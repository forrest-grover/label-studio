import { SampleDatasetSelect } from "@humansignal/app-common/blocks/SampleDatasetSelect/SampleDatasetSelect";
import { ff, formatFileSize } from "@humansignal/core";
import { IconCode, IconErrorAlt, IconFileUpload, IconInfoOutline, IconTrash, IconUpload } from "@humansignal/icons";
import { cn as scn } from "@humansignal/shad/utils";
import { useAtomValue } from "jotai";
import Input from "libs/datamanager/src/components/Common/Input/Input";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useAPI } from "../../../providers/ApiProvider";
import { cn } from "../../../utils/bem";
import { sampleDatasetAtom } from "../utils/atoms";
import "./Import.prefix.css";
import { Button, CodeBlock, SimpleCard, Spinner, Tooltip, Typography, Badge } from "@humansignal/ui";
import truncate from "truncate-middle";
import samples from "./samples.json";
import { importFiles } from "./utils";
import { iterateFileTree } from "./fileTraversal";
import { createUploadQueue, uploadFileTus } from "./tusUpload";
import { recordInflight, removeInflight, getInflight, clearInflight } from "./tusResume";
import { createProcessFiles, initialReducerState, shouldSkipAsDuplicate } from "./Import.reducer";
import { UploadProgressHeader } from "./UploadProgressHeader";
import { useCompletedFingerprintsPrune } from "./useCompletedFingerprintsPrune";

const importClass = cn("upload_page");
const dropzoneClass = cn("dropzone");

// Constants for file display and animation
const FLASH_ANIMATION_DURATION = 2000; // 2 seconds
const FILENAME_TRUNCATE_START = 24;
const FILENAME_TRUNCATE_END = 24;
// Cap the number of "uploaded" rows we actually render. For 8000-file imports
// the DOM cost of rendering every completed row was visible in profiling —
// each progress tick from any in-flight file re-renders the whole table, and
// React's reconciliation over thousands of <tr> nodes dominated upload
// throughput (down to ~3 files/s). Show the most recent N successes plus a
// summary row for the rest.
const MAX_RENDERED_UPLOADED_ROWS = 50;

function flatten(nested) {
  return [].concat(...nested);
}

// Keep in sync with core.settings.SUPPORTED_EXTENSIONS on the BE.
const supportedExtensions = {
  text: ["txt"],
  audio: ["wav", "mp3", "flac", "m4a", "ogg"],
  video: ["mp4", "webm"],
  image: ["bmp", "gif", "jpg", "jpeg", "png", "svg", "webp"],
  html: ["html", "htm", "xml"],
  pdf: ["pdf"],
  structuredData: ["csv", "tsv", "json"],
};
const allSupportedExtensions = flatten(Object.values(supportedExtensions));

function getFileExtension(fileName) {
  if (!fileName) {
    return fileName;
  }
  return fileName.split(".").pop().toLowerCase();
}

const Upload = ({ children, onDropItems }) => {
  const [hovered, setHovered] = useState(false);
  const onHover = (e) => {
    e.preventDefault();
    setHovered(true);
  };
  const onLeave = setHovered.bind(null, false);
  const dropzoneRef = useRef();

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      onLeave();
      // Hand the raw DataTransferItemList straight through — the consumer
      // iterates lazily (async generator) so we never materialise the full
      // tree up front. See UPLOAD_FIX_DESIGN.md §A1.
      onDropItems(e.dataTransfer.items);
    },
    [onLeave, onDropItems],
  );

  return (
    <div
      id="holder"
      className={dropzoneClass.mod({ hovered }).toClassName()}
      ref={dropzoneRef}
      onDragStart={onHover}
      onDragOver={onHover}
      onDragLeave={onLeave}
      onDrop={onDrop}
      // {...getRootProps}
    >
      {children}
    </div>
  );
};

const ErrorMessage = ({ error }) => {
  if (!error) return null;
  let extra = error.validation_errors ?? error.extra;
  // support all possible responses

  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    extra = extra.non_field_errors ?? Object.values(extra);
  }
  if (Array.isArray(extra)) extra = extra.join("; ");

  return (
    <div className={importClass.elem("error").toClassName()}>
      <IconErrorAlt width="24" height="24" />
      {error.id && `[${error.id}] `}
      {error.detail || error.message}
      {extra && ` (${extra})`}
    </div>
  );
};

export const ImportPage = ({
  project,
  sample,
  show = true,
  onWaiting,
  onFileListUpdate,
  onSampleDatasetSelect,
  highlightCsvHandling,
  dontCommitToProject = false,
  csvHandling,
  setCsvHandling,
  addColumns,
  openLabelingConfig,
}) => {
  const [error, setError] = useState();
  const [newlyUploadedFiles, setNewlyUploadedFiles] = useState(new Set());
  const prevUploadedRef = useRef(new Set());
  const api = useAPI();
  const projectConfigured = project?.label_config !== "<View></View>";
  const sampleConfig = useAtomValue(sampleDatasetAtom);

  // processFiles reducer lives in Import.reducer.js — extracted so the full
  // branch matrix (IR-UP-*, IR-IDS-*, IR-SE-*, IR-PR-*, IR-BT/BD/RS-*) can be
  // unit-tested without mounting the Import component. `onFileListUpdate` is
  // the only non-pure dep; the factory receives a getter that reads the latest
  // callback via a ref so parent re-renders always see the current handler
  // (matches pre-refactor closure-capture semantics).
  const onFileListUpdateRef = useRef(onFileListUpdate);
  onFileListUpdateRef.current = onFileListUpdate;
  const processFilesRef = useRef(null);
  if (processFilesRef.current === null) {
    processFilesRef.current = createProcessFiles((ids) => onFileListUpdateRef.current?.(ids));
  }
  const [files, dispatch] = useReducer(processFilesRef.current, undefined, initialReducerState);
  // Resume-on-reload state (§A4). Declared up here so `showList` can include it —
  // the resume banner must render even when no files are attached yet, so the
  // user has a recovery path immediately after a page reload.
  const [interrupted, setInterrupted] = useState([]);
  // Per-drop skipped-as-duplicate counter. Resets each call to consumeItems so
  // the user sees "N queued, M skipped as already uploaded" for each drop,
  // not a lifetime total. See TUS-001. Declared before `showList` so a drop
  // of files that are ALL already-uploaded still flips the header into view.
  const [lastDropSkipped, setLastDropSkipped] = useState(0);
  const showList = Boolean(
    files.uploaded?.length
    || files.uploading?.length
    || files.failed?.length
    || sample
    || interrupted.length
    || lastDropSkipped,
  );

  // Abort controller + queue live across the lifetime of the modal instance.
  const uploadQueueRef = useRef(null);
  const abortControllerRef = useRef(null);
  // Monotonic counter for _tusKey — gives each File a stable unique id even
  // when two files share the same basename (w0/img_001.png vs w1/img_001.png).
  const fileKeySeq = useRef(0);
  const getQueue = () => {
    if (!uploadQueueRef.current) uploadQueueRef.current = createUploadQueue();
    return uploadQueueRef.current;
  };
  const getAbortController = () => {
    if (!abortControllerRef.current) abortControllerRef.current = new AbortController();
    return abortControllerRef.current;
  };
  useEffect(() => {
    return () => {
      try {
        abortControllerRef.current?.abort();
      } catch (_) {
        /* ignore */
      }
    };
  }, []);

  // Resume-on-reload effect (§A4). State declared earlier next to showList so
  // the banner can gate showList before any files are attached.
  useEffect(() => {
    if (!project?.id) return;
    setInterrupted(getInflight(project.id));
  }, [project?.id]);

  // Evict fingerprint entries older than 7 days once per Import-page mount
  // (TUS-001). Cheap — scans only ls-tus-completed-* keys.
  useCompletedFingerprintsPrune();

  const loadFilesList = useCallback(
    async (file_upload_ids) => {
      const query = {};

      if (file_upload_ids) {
        // should be stringified array "[1,2]"
        query.ids = JSON.stringify(file_upload_ids);
      }
      const files = await api.callApi("fileUploads", {
        params: { pk: project.id, ...query },
      });

      dispatch({ uploaded: files ?? [] });

      if (files?.length) {
        dispatch({ ids: files.map((f) => f.id) });
      }
      return files;
    },
    [project?.id],
  );

  const onError = (err) => {
    console.error(err);
    // @todo workaround for error about input size in a wrong html format
    if (typeof err === "string" && err.includes("RequestDataTooBig")) {
      const message = "Imported file is too big";
      const extra = err.match(/"exception_value">(.*)<\/pre>/)?.[1];

      err = { message, extra };
    }
    setError(err);
    onWaiting?.(false);
  };
  const onFinish = useCallback(
    async (res) => {
      const { could_be_tasks_list, data_columns, file_upload_ids } = res;

      dispatch({ ids: file_upload_ids });
      if (could_be_tasks_list && !csvHandling) setCsvHandling("choose");
      onWaiting?.(false);
      addColumns(data_columns);

      await loadFilesList(file_upload_ids);
      return res;
    },
    [addColumns, loadFilesList],
  );

  // Track newly uploaded files for flash animation
  useEffect(() => {
    const currentUploadedIds = new Set(files.uploaded.map((f) => f.id));
    const previousUploadedIds = prevUploadedRef.current;

    // Find files that were just uploaded (in current but not in previous)
    const justUploaded = new Set([...currentUploadedIds].filter((id) => !previousUploadedIds.has(id)));

    // Update the ref immediately after comparison to ensure it's available for next run
    prevUploadedRef.current = new Set(currentUploadedIds);

    // Clean up animation state for files that are no longer in the uploaded list
    setNewlyUploadedFiles((prev) => {
      const filtered = new Set([...prev].filter((id) => currentUploadedIds.has(id)));
      return filtered;
    });

    // Animate newly uploaded files (including first upload)
    if (justUploaded.size > 0) {
      // Apply animation class immediately for better responsiveness
      setNewlyUploadedFiles((prev) => new Set([...prev, ...justUploaded]));

      // Remove animation class after animation completes (CSS handles the animation timing)
      const timeoutId = setTimeout(() => {
        setNewlyUploadedFiles((prev) => {
          const updated = new Set(prev);
          justUploaded.forEach((id) => updated.delete(id));
          return updated;
        });
      }, FLASH_ANIMATION_DURATION);

      // Cleanup timeout on unmount or dependency change
      return () => clearTimeout(timeoutId);
    }
  }, [files.uploaded]);

  const importFilesImmediately = useCallback(
    async (files, body) => {
      importFiles({
        files,
        body,
        project,
        onError,
        onFinish,
        onUploadStart: (files) => dispatch({ sending: files }),
        onUploadFinish: (files) => dispatch({ sent: files }),
        dontCommitToProject,
      });
    },
    [project, onFinish],
  );

  // Dispatch one File into the tus queue. Returns the queued Promise.
  const enqueueOne = useCallback(
    (file) => {
      if (!allSupportedExtensions.includes(getFileExtension(file.name))) {
        onError(new Error(`The filetype of file "${file.name}" is not supported.`));
        return Promise.resolve(null);
      }
      // TUS-001: skip files that already completed in a prior session. The
      // completed-fingerprint index is per-project and TTL'd; see
      // completedFingerprints.js. We log via console.info (same channel
      // neighbouring upload code uses for skip/error diagnostics) and bump
      // the per-drop skipped counter so the user can see how many files
      // were dropped-but-not-enqueued on this drop.
      if (shouldSkipAsDuplicate(file, project?.id)) {
        console.info(
          `[tus] skipping "${file.name}" — already uploaded to project ${project.id} within the last 7 days`,
        );
        setLastDropSkipped((n) => n + 1);
        return Promise.resolve(null);
      }
      // Stable unique key for reducer indexing. Filenames alone are not unique
      // when a user drags in e.g. 10 subdirs that each contain `img_001.png`.
      // File objects are frozen so we install the key via defineProperty with
      // a try/catch fallback for exotic browser File implementations.
      if (!file._tusKey) {
        const k = `f${++fileKeySeq.current}`;
        try {
          Object.defineProperty(file, "_tusKey", { value: k, configurable: false });
        } catch (_) {
          file._tusKey = k; /* eslint-disable-line no-param-reassign */
        }
      }
      dispatch({ sending: [file] });
      dispatch({
        progress: { key: file._tusKey, loaded: 0, total: file.size || 0 },
      });
      dispatch({ bumpTotals: { files: 1, bytes: file.size || 0 } });

      return getQueue().add(async () => {
        // Per-file progress throttle. tus-js-client emits onProgress at the
        // native rate (many ticks per second per chunk); with 4 concurrent
        // uploads and 8000 already-rendered rows, the React reconciliation
        // cost of every tick dominates upload throughput. Rate-limit to
        // PROGRESS_THROTTLE_MS and always forward the last reported value on
        // success so the row settles at 100%.
        let lastDispatchAt = 0;
        let pendingProgress = null;
        const PROGRESS_THROTTLE_MS = 100;
        try {
          const { fileUploadId, resourceUrl } = await uploadFileTus({
            file,
            projectId: project.id,
            abortSignal: getAbortController().signal,
            onProgress: (f, loaded, total) => {
              pendingProgress = { key: f._tusKey, loaded, total };
              const now = Date.now();
              if (now - lastDispatchAt >= PROGRESS_THROTTLE_MS) {
                lastDispatchAt = now;
                dispatch({ progress: pendingProgress });
                pendingProgress = null;
              }
              // Track per-project inflight so the Resume banner can recover
              // this upload after a reload. Overwrites on every tick; the
              // key is the fingerprint tus-js-client assigned (stored on the
              // upload URL itself — we keep just filename + size for display).
              try {
                recordInflight(project.id, {
                  fingerprint: `${project.id}:${f.name}:${f.size}`,
                  filename: f.name,
                  size: f.size,
                  loaded,
                  total,
                });
              } catch (_) { /* best-effort */ }
            },
          });
          // Flush any coalesced trailing tick so the final percent is shown.
          if (pendingProgress) dispatch({ progress: pendingProgress });

          // Pull the new FileUpload record (shape-compatible with the legacy
          // /file-uploads endpoint) so downstream state renders consistently.
          const uploadedRow = await api.callApi("fileUploads", {
            params: { pk: project.id, ids: JSON.stringify([fileUploadId]) },
          });
          if (uploadedRow && uploadedRow.length) {
            dispatch({ uploaded: uploadedRow });
            dispatch({ ids: uploadedRow.map((r) => r.id) });
          } else {
            dispatch({ ids: [fileUploadId] });
          }
          dispatch({ sent: [file] });
          dispatch({ bumpDone: 1 });
          try { removeInflight(project.id, `${project.id}:${file.name}:${file.size}`); } catch (_) {}
          return { fileUploadId, resourceUrl };
        } catch (err) {
          if (err?.name === "AbortError") return null;
          dispatch({ failed: { file, error: err } });
          return null;
        }
      });
    },
    [api, project?.id],
  );

  // Consume the async generator, handing each File into the queue as soon as
  // it arrives. This keeps memory bounded even for huge drag-drops. Stats are
  // additive across successive calls — if the user clicks "Upload More Files"
  // (or the test harness batches a huge drop), the aggregate counter should
  // keep climbing, not snap back to zero. initialStats() runs once on mount
  // which already handles the fresh-session case.
  const consumeItems = useCallback(
    async (items) => {
      setError(null);
      onWaiting?.(true);
      // Reset per-drop skipped counter — lastDropSkipped shows "M skipped as
      // already uploaded" for the current drop only. See TUS-001.
      setLastDropSkipped(0);
      let any = false;
      try {
        for await (const file of iterateFileTree(items)) {
          if (!file) continue;
          any = true;
          enqueueOne(file);
        }
      } catch (err) {
        onError(err);
      }
      // Wait for everything already queued to settle before announcing done.
      // New enqueues added during the await (shouldn't happen mid-iteration,
      // but p-queue's onIdle is safe to call repeatedly) all resolve.
      await getQueue().onIdle();
      onWaiting?.(false);
      if (!any) return;
    },
    [enqueueOne, onWaiting],
  );

  // Back-compat wrapper: existing callers pass an Array<File> or FileList.
  const sendFiles = useCallback(
    (fileList) => {
      consumeItems(fileList);
    },
    [consumeItems],
  );

  const onUpload = useCallback(
    (e) => {
      // Snapshot the FileList into a plain Array BEFORE clearing the input's
      // value — setting `value = ""` empties the live FileList reference, and
      // `consumeItems` iterates it asynchronously, so without this snapshot
      // only the first file (if any) makes it through before the list is
      // truncated to length 0.
      const picked = Array.from(e.target.files || []);
      e.target.value = "";
      consumeItems(picked);
    },
    [consumeItems],
  );

  const retryFailed = useCallback(
    (file) => {
      dispatch({ retry: file });
      enqueueOne(file);
    },
    [enqueueOne],
  );

  const retryAllFailed = useCallback(() => {
    const toRetry = [...files.failed.map((e) => e.file)];
    for (const f of toRetry) retryFailed(f);
  }, [files.failed, retryFailed]);

  const dismissResumeBanner = useCallback(() => {
    if (project?.id) clearInflight(project.id);
    setInterrupted([]);
  }, [project?.id]);

  const resumeInterrupted = useCallback(() => {
    // True resume requires re-selecting the File (the Blob/File object is
    // never persisted in localStorage). We surface the list so the user can
    // drag the same files again; tus-js-client will resume from the stored
    // offset automatically once it sees the matching fingerprint.
    document.getElementById("file-input")?.click();
  }, []);

  const onLoadURL = useCallback(
    (e) => {
      e.preventDefault();
      setError(null);
      const url = urlRef.current?.value;

      if (!url) {
        return;
      }
      urlRef.current.value = "";
      onWaiting?.(true);
      const body = new URLSearchParams({ url });

      importFilesImmediately([{ name: url }], body);
    },
    [importFilesImmediately],
  );

  const openConfig = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      openLabelingConfig?.();
    },
    [openLabelingConfig],
  );

  useEffect(() => {
    if (project?.id !== undefined) {
      loadFilesList().then((files) => {
        if (csvHandling) return;
        // empirical guess on start if we have some possible tasks list/structured data problem
        if (Array.isArray(files) && files.some(({ file }) => /\.[ct]sv$/.test(file))) {
          setCsvHandling("choose");
        }
      });
    }
  }, [project?.id, loadFilesList]);

  const urlRef = useRef();

  if (!project) return null;
  if (!show) return null;

  const csvProps = {
    name: "csv",
    type: "radio",
    onChange: (e) => setCsvHandling(e.target.value),
  };

  return (
    <div className={importClass}>
      {highlightCsvHandling && <div className={importClass.elem("csv-splash").toClassName()} />}
      <input id="file-input" type="file" name="file" multiple onChange={onUpload} style={{ display: "none" }} />

      <header className="flex gap-4">
        <form
          className={`${importClass.elem("url-form")} inline-flex items-stretch`}
          method="POST"
          onSubmit={onLoadURL}
        >
          <Input placeholder="Dataset URL" name="url" ref={urlRef} rawClassName="h-[40px]" />
          <Button variant="primary" look="outlined" type="submit" aria-label="Add URL">
            Add URL
          </Button>
        </form>
        <span>or</span>
        <Button
          variant="primary"
          look="outlined"
          type="button"
          onClick={() => document.getElementById("file-input").click()}
          leading={<IconUpload />}
          aria-label="Upload file"
        >
          Upload {files.uploaded.length ? "More " : ""}Files
        </Button>
        {ff.isActive(ff.FF_SAMPLE_DATASETS) && (
          <SampleDatasetSelect samples={samples} sample={sample} onSampleApplied={onSampleDatasetSelect} />
        )}
        <div
          className={importClass
            .elem("csv-handling")
            .mod({ highlighted: highlightCsvHandling, hidden: !csvHandling })
            .toClassName()}
        >
          <span>Treat CSV/TSV as</span>
          <label>
            <input {...csvProps} value="tasks" checked={csvHandling === "tasks"} /> List of tasks
          </label>
          <label>
            <input {...csvProps} value="ts" checked={csvHandling === "ts"} /> Time Series or Whole Text File
          </label>
        </div>
        <div className={importClass.elem("status").toClassName()}>
          {files.uploaded.length ? `${files.uploaded.length} files uploaded` : ""}
        </div>
      </header>

      <ErrorMessage error={error} />

      <main>
        <Upload onDropItems={consumeItems} project={project}>
          <div
            className={scn("flex gap-4 w-full min-h-full", {
              "justify-center": !showList,
            })}
          >
            {!showList && (
              <div className="flex gap-4 justify-center items-start w-full h-full">
                <label htmlFor="file-input" className="w-full h-full">
                  <div className={`${dropzoneClass.elem("content")} w-full`}>
                    <IconFileUpload height="64" className={dropzoneClass.elem("icon").toClassName()} />
                    <header>
                      Drag & drop files here
                      <br />
                      or click to browse
                    </header>

                    <dl>
                      <dt>Images</dt>
                      <dd>{supportedExtensions.image.join(", ")}</dd>
                      <dt>Audio</dt>
                      <dd>{supportedExtensions.audio.join(", ")}</dd>
                      <dt>
                        <div className="flex items-center gap-1">
                          Video
                          <Tooltip title="Video format support depends on your browser. Click to learn more.">
                            <a
                              href="https://labelstud.io/tags/video#Video-format"
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center"
                              aria-label="Learn more about video format support (opens in a new tab)"
                            >
                              <IconInfoOutline className="w-4 h-4 text-primary-content hover:text-primary-content-hover" />
                            </a>
                          </Tooltip>
                        </div>
                      </dt>
                      <dd>{supportedExtensions.video.join(", ")}</dd>
                      <dt>HTML / HyperText</dt>
                      <dd>{supportedExtensions.html.join(", ")}</dd>
                      <dt>Text</dt>
                      <dd>{supportedExtensions.text.join(", ")}</dd>
                      <dt>Structured data</dt>
                      <dd>{supportedExtensions.structuredData.join(", ")}</dd>
                      <dt>PDF</dt>
                      <dd>{supportedExtensions.pdf.join(", ")}</dd>
                    </dl>
                    <div className="tips">
                      <b>Important:</b>
                      <ul className="mt-2 ml-4 list-disc font-normal">
                        <li>
                          We recommend{" "}
                          <a
                            href="https://labelstud.io/guide/storage.html"
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Cloud Storage documentation (opens in a new tab)"
                          >
                            Cloud Storage
                          </a>{" "}
                          over direct uploads due to{" "}
                          <a
                            href="https://labelstud.io/guide/tasks.html#Import-data-from-the-Label-Studio-UI"
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Upload limitations documentation (opens in a new tab)"
                          >
                            upload limitations
                          </a>
                          .
                        </li>
                        <li>
                          For PDFs, use{" "}
                          <a
                            href="https://labelstud.io/templates/multi-page-document-annotation"
                            target="_blank"
                            rel="noopener noreferrer"
                            aria-label="Multi-image labeling documentation (opens in a new tab)"
                          >
                            multi-image labeling
                          </a>
                          . JSONL or Parquet (Enterprise only) files require cloud storage.
                        </li>
                        <li>
                          Check the documentation to{" "}
                          <a target="_blank" href="https://labelstud.io/guide/predictions.html" rel="noreferrer">
                            import preannotated data
                          </a>
                          .
                        </li>
                      </ul>
                    </div>
                  </div>
                </label>
              </div>
            )}

            {showList && (
              <div className="w-full">
                {interrupted.length > 0 && (
                  <div
                    className="flex items-center gap-4 p-3 mb-3 border border-warning-border-subtle bg-warning-background rounded"
                    data-testid="tus-resume-banner"
                  >
                    <Typography variant="body" size="small" className="flex-1">
                      Resume {interrupted.length} interrupted upload{interrupted.length === 1 ? "" : "s"}
                    </Typography>
                    <Button size="smaller" look="outlined" onClick={resumeInterrupted}>
                      Resume
                    </Button>
                    <Button size="smaller" variant="negative" look="outlined" onClick={dismissResumeBanner}>
                      Dismiss
                    </Button>
                  </div>
                )}
                <UploadProgressHeader
                  stats={files.stats}
                  failedCount={files.failed.length}
                  onRetryAll={retryAllFailed}
                  skippedCount={lastDropSkipped}
                />
                <SimpleCard
                  title="Files"
                  className="w-full h-full"
                  contentClassName="overflow-y-auto h-[calc(100%-48px)]"
                >
                  <table className="w-full">
                    <tbody>
                      {sample && (
                        <tr key={sample.url}>
                          <td>
                            <div className="flex items-center gap-2">
                              {sample.title}
                              <Badge>Sample</Badge>
                            </div>
                          </td>
                          <td>{sample.description}</td>
                          <td>
                            <Button size="smaller" variant="negative" onClick={() => onSampleDatasetSelect(undefined)}>
                              <IconTrash className="w-4 h-4" />
                            </Button>
                          </td>
                        </tr>
                      )}
                      {files.uploaded.length > MAX_RENDERED_UPLOADED_ROWS && (
                        <tr data-testid="tus-uploaded-summary">
                          <td colSpan={3} className="text-neutral-content-subtle italic py-2">
                            {files.uploaded.length - MAX_RENDERED_UPLOADED_ROWS} earlier uploaded files hidden
                            (showing most recent {MAX_RENDERED_UPLOADED_ROWS})
                          </td>
                        </tr>
                      )}
                      {files.uploaded.slice(-MAX_RENDERED_UPLOADED_ROWS).map((file) => {
                        const truncatedFilename = truncate(
                          file.file,
                          FILENAME_TRUNCATE_START,
                          FILENAME_TRUNCATE_END,
                          "...",
                        );
                        return (
                          <tr
                            key={file.file}
                            className={newlyUploadedFiles.has(file.id) ? importClass.elem("upload-flash") : ""}
                          >
                            <td className={importClass.elem("file-name").toClassName()}>
                              <Tooltip title={file.file}>
                                <Typography variant="body" size="small" className="truncate">
                                  {truncatedFilename}
                                </Typography>
                              </Tooltip>
                            </td>
                            <td>
                              <span className={importClass.elem("file-status").toClassName()} />
                            </td>
                            <td className={importClass.elem("file-size").toClassName()}>
                              <Typography
                                variant="body"
                                size="smaller"
                                className="text-nowrap text-neutral-content-subtle text-right"
                              >
                                {file.size ? formatFileSize(file.size) : ""}
                              </Typography>
                            </td>
                          </tr>
                        );
                      })}
                      {files.uploading.map((file) => {
                        const truncatedFilename = truncate(
                          file.name,
                          FILENAME_TRUNCATE_START,
                          FILENAME_TRUNCATE_END,
                          "...",
                        );
                        const p = files.progress[file._tusKey] || { loaded: 0, total: file.size || 0 };
                        const pct = p.total > 0 ? Math.min(100, Math.round((p.loaded * 100) / p.total)) : null;
                        return (
                          <tr key={file._tusKey}>
                            <td className={importClass.elem("file-name").toClassName()}>
                              <Tooltip title={file.name}>
                                <Typography variant="body" size="small" className="truncate">
                                  {truncatedFilename}
                                </Typography>
                              </Tooltip>
                            </td>
                            <td style={{ minWidth: 160 }}>
                              {pct == null ? (
                                <span
                                  className={importClass.elem("file-status").mod({ uploading: true }).toClassName()}
                                />
                              ) : (
                                <div className="flex items-center gap-2" data-testid={`tus-progress-${file.name}`}>
                                  <progress value={p.loaded} max={p.total} style={{ width: 120, height: 8 }} />
                                  <Typography variant="body" size="smaller">{pct}%</Typography>
                                </div>
                              )}
                            </td>
                            <td className={importClass.elem("file-size").toClassName()}>
                              <Typography variant="body" size="smaller" className="text-nowrap text-neutral-content-subtle text-right">
                                {p.total ? `${formatFileSize(p.loaded)} / ${formatFileSize(p.total)}` : ""}
                              </Typography>
                            </td>
                          </tr>
                        );
                      })}
                      {files.failed.map((entry) => {
                        const truncatedFilename = truncate(
                          entry.file.name,
                          FILENAME_TRUNCATE_START,
                          FILENAME_TRUNCATE_END,
                          "...",
                        );
                        return (
                          <tr key={`failed-${entry.file._tusKey}`} data-testid={`tus-failed-${entry.file.name}`}>
                            <td className={importClass.elem("file-name").toClassName()}>
                              <Tooltip title={`${entry.file.name}: ${entry.error}`}>
                                <Typography variant="body" size="small" className="truncate text-negative-content">
                                  <IconErrorAlt width="14" height="14" className="inline mr-1 align-middle" />
                                  {truncatedFilename}
                                </Typography>
                              </Tooltip>
                            </td>
                            <td>
                              <Button
                                size="smaller"
                                look="outlined"
                                onClick={() => retryFailed(entry.file)}
                                aria-label={`Retry upload of ${entry.file.name}`}
                              >
                                Retry
                              </Button>
                            </td>
                            <td className={importClass.elem("file-size").toClassName()}>
                              <Typography variant="body" size="smaller" className="text-nowrap text-negative-content text-right">
                                Failed
                              </Typography>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </SimpleCard>
              </div>
            )}

            {ff.isFF(ff.FF_JSON_PREVIEW) && (
              <div className="w-full h-full flex flex-col min-h-[400px]">
                {projectConfigured ? (
                  <SimpleCard
                    title="Expected Input Preview"
                    className="w-full h-full overflow-hidden flex flex-col"
                    contentClassName="h-[calc(100%-48px)]"
                    flushContent
                  >
                    {sampleConfig.data ? (
                      <div className={importClass.elem("code-wrapper").toClassName()}>
                        <CodeBlock
                          title="Expected Input Preview"
                          code={sampleConfig?.data ?? ""}
                          className="w-full h-full"
                        />
                      </div>
                    ) : sampleConfig.isLoading ? (
                      <div className="w-full flex justify-center py-12">
                        <Spinner className="h-6 w-6" />
                      </div>
                    ) : sampleConfig.isError ? (
                      <div className="w-[calc(100%-24px)] text-lg text-negative-content bg-negative-background border m-3 rounded-md border-negative-border-subtle p-4">
                        Something went wrong, the sample data could not be loaded.
                      </div>
                    ) : null}
                  </SimpleCard>
                ) : (
                  <SimpleCard className="w-full h-full flex flex-col items-center justify-center text-center p-wide">
                    <div className="flex flex-col items-center gap-tight">
                      <div className="bg-primary-background rounded-largest p-tight flex items-center justify-center">
                        <IconCode className="w-6 h-6 text-primary-icon" />
                      </div>
                      <div className="flex flex-col items-center gap-tighter">
                        <div className="text-label-small text-neutral-content font-medium">View JSON input format</div>
                        <div className="text-body-small text-neutral-content-subtler text-center">
                          Setup your{" "}
                          <Button
                            type="button"
                            look="string"
                            onClick={openConfig}
                            className="border-none bg-none p-0 m-0 text-primary-content underline"
                          >
                            labeling configuration
                          </Button>{" "}
                          first to preview the expected JSON data format
                        </div>
                      </div>
                    </div>
                  </SimpleCard>
                )}
              </div>
            )}
          </div>
        </Upload>
      </main>
    </div>
  );
};
