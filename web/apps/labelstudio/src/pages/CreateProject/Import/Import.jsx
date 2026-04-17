import { SampleDatasetSelect } from "@humansignal/app-common/blocks/SampleDatasetSelect/SampleDatasetSelect";
import { ff, formatFileSize } from "@humansignal/core";
import { IconCode, IconErrorAlt, IconFileUpload, IconInfoOutline, IconTrash, IconUpload } from "@humansignal/icons";
import { cn as scn } from "@humansignal/shad/utils";
import { useAtomValue } from "jotai";
import Input from "libs/datamanager/src/components/Common/Input/Input";
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useAPI } from "../../../providers/ApiProvider";
import { cn } from "../../../utils/bem";
import { unique } from "../../../utils/helpers";
import { sampleDatasetAtom } from "../utils/atoms";
import "./Import.prefix.css";
import { Button, CodeBlock, SimpleCard, Spinner, Tooltip, Typography, Badge } from "@humansignal/ui";
import truncate from "truncate-middle";
import samples from "./samples.json";
import { importFiles } from "./utils";
import { iterateFileTree } from "./fileTraversal";
import { createUploadQueue, uploadFileTus } from "./tusUpload";
import { recordInflight, removeInflight, getInflight, clearInflight } from "./tusResume";

const importClass = cn("upload_page");
const dropzoneClass = cn("dropzone");

// Constants for file display and animation
const FLASH_ANIMATION_DURATION = 2000; // 2 seconds
const FILENAME_TRUNCATE_START = 24;
const FILENAME_TRUNCATE_END = 24;

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

// Aggregate byte-transfer summary shown above the per-file list. See
// UPLOAD_FIX_DESIGN.md §A5.
const UploadProgressHeader = ({ stats, failedCount, onRetryAll }) => {
  const hasTotals = stats && stats.totalFiles > 0;
  if (!hasTotals && !failedCount) return null;
  const remaining = Math.max(0, stats.totalBytes - stats.doneBytes);
  let etaLabel = null;
  if (hasTotals && stats.doneBytes > 0 && stats.startedAt) {
    const elapsed = (Date.now() - stats.startedAt) / 1000;
    if (elapsed > 5) {
      const bytesPerSec = stats.doneBytes / elapsed;
      if (bytesPerSec > 0) {
        const etaSec = remaining / bytesPerSec;
        const h = Math.floor(etaSec / 3600);
        const m = Math.floor((etaSec % 3600) / 60);
        etaLabel = `ETA ${h > 0 ? `${h}h ` : ""}${m}m`;
      }
    }
  }
  const doneFmt = formatFileSize(stats.doneBytes || 0);
  const totalFmt = formatFileSize(stats.totalBytes || 0);
  return (
    <div
      className="flex items-center gap-4 p-2 mb-2 border border-neutral-border-subtle rounded"
      data-testid="tus-aggregate-header"
    >
      <Typography variant="body" size="small" className="flex-1">
        {stats.doneFiles} of {stats.totalFiles} files{" "}
        <span className="text-neutral-content-subtle">
          | {doneFmt} / {totalFmt}
          {etaLabel ? ` | ${etaLabel}` : ""}
        </span>
      </Typography>
      {failedCount > 0 && (
        <>
          <Typography variant="body" size="small" className="text-negative-content">
            {failedCount} failed
          </Typography>
          <Button size="smaller" look="outlined" onClick={onRetryAll} aria-label="Retry all failed uploads">
            Retry all failed
          </Button>
        </>
      )}
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

  const processFiles = (state, action) => {
    if (action.sending) {
      return { ...state, uploading: [...action.sending, ...state.uploading] };
    }
    if (action.sent) {
      // `action.sent` is an array of File objects that just finished. Remove
      // them from `uploading` AND clear any stale progress/failed entries so
      // successful rows don't linger as failures. Fold their final `loaded`
      // byte count into `stats.completedBytes` so the aggregate doneBytes
      // stays cumulative even after we drop the entries (otherwise the
      // "X / Y" byte readout jumps back to ~zero each time a batch finishes
      // and the ETA becomes nonsense).
      const sentNames = new Set(action.sent.map((f) => f.name));
      const progress = { ...state.progress };
      let sentBytes = 0;
      for (const n of sentNames) {
        const p = progress[n];
        if (p) sentBytes += p.loaded || 0;
        delete progress[n];
      }
      return {
        ...state,
        uploading: state.uploading.filter((f) => !sentNames.has(f.name)),
        failed: state.failed.filter((e) => !sentNames.has(e.file.name)),
        progress,
        stats: {
          ...state.stats,
          completedBytes: (state.stats.completedBytes || 0) + sentBytes,
        },
      };
    }
    if (action.uploaded) {
      return {
        ...state,
        uploaded: unique([...state.uploaded, ...action.uploaded], (a, b) => a.id === b.id),
      };
    }
    if (action.ids) {
      const ids = unique([...state.ids, ...action.ids]);
      onFileListUpdate?.(ids);
      return { ...state, ids };
    }
    if (action.progress) {
      const { name, loaded, total } = action.progress;
      const nextProgress = { ...state.progress, [name]: { loaded, total } };
      // doneBytes = bytes already committed (completedBytes) + bytes in-flight
      // right now. This stays monotonically non-decreasing across the lifetime
      // of a batch because completed files no longer appear in `progress`
      // after the `sent` action folds their size into completedBytes.
      let inflight = 0;
      for (const p of Object.values(nextProgress)) {
        inflight += p.loaded || 0;
      }
      const doneBytes = (state.stats.completedBytes || 0) + inflight;
      return {
        ...state,
        progress: nextProgress,
        stats: {
          ...state.stats,
          doneBytes,
          // totalBytes is owned by bumpTotals, do not overwrite here.
          startedAt: state.stats.startedAt || Date.now(),
        },
      };
    }
    if (action.failed) {
      const { file, error } = action.failed;
      return {
        ...state,
        uploading: state.uploading.filter((f) => f.name !== file.name),
        failed: [
          ...state.failed.filter((e) => e.file.name !== file.name),
          { file, error: String(error?.message ?? error ?? "Upload failed"), retries: 0 },
        ],
      };
    }
    if (action.retry) {
      return {
        ...state,
        failed: state.failed.filter((e) => e.file.name !== action.retry.name),
      };
    }
    if (action.bumpTotals) {
      return {
        ...state,
        stats: {
          ...state.stats,
          totalFiles: (state.stats.totalFiles || 0) + action.bumpTotals.files,
          totalBytes: (state.stats.totalBytes || 0) + action.bumpTotals.bytes,
          startedAt: state.stats.startedAt || Date.now(),
        },
      };
    }
    if (action.bumpDone) {
      return {
        ...state,
        stats: {
          ...state.stats,
          doneFiles: (state.stats.doneFiles || 0) + action.bumpDone,
        },
      };
    }
    if (action.resetStats) {
      return { ...state, stats: initialStats(), progress: {} };
    }
    return state;
  };

  const initialStats = () => ({
    totalFiles: 0,
    doneFiles: 0,
    totalBytes: 0,
    doneBytes: 0,
    completedBytes: 0, // cumulative bytes for already-finished files
    startedAt: null,
  });

  const [files, dispatch] = useReducer(processFiles, {
    uploaded: [],
    uploading: [],
    ids: [],
    progress: {},
    failed: [],
    stats: initialStats(),
  });
  const showList = Boolean(files.uploaded?.length || files.uploading?.length || files.failed?.length || sample);

  // Abort controller + queue live across the lifetime of the modal instance.
  const uploadQueueRef = useRef(null);
  const abortControllerRef = useRef(null);
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

  // Resume-on-reload state (§A4).
  const [interrupted, setInterrupted] = useState([]);
  useEffect(() => {
    if (!project?.id) return;
    setInterrupted(getInflight(project.id));
  }, [project?.id]);

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
      dispatch({ sending: [file] });
      dispatch({
        progress: { name: file.name, loaded: 0, total: file.size || 0 },
      });
      dispatch({ bumpTotals: { files: 1, bytes: file.size || 0 } });

      return getQueue().add(async () => {
        try {
          const { fileUploadId, resourceUrl } = await uploadFileTus({
            file,
            projectId: project.id,
            abortSignal: getAbortController().signal,
            onProgress: (f, loaded, total) => {
              dispatch({ progress: { name: f.name, loaded, total } });
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
  // it arrives. This keeps memory bounded even for huge drag-drops.
  const consumeItems = useCallback(
    async (items) => {
      setError(null);
      onWaiting?.(true);
      dispatch({ resetStats: true });
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
                <UploadProgressHeader stats={files.stats} failedCount={files.failed.length} onRetryAll={retryAllFailed} />
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
                      {files.uploaded.map((file) => {
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
                      {files.uploading.map((file, idx) => {
                        const truncatedFilename = truncate(
                          file.name,
                          FILENAME_TRUNCATE_START,
                          FILENAME_TRUNCATE_END,
                          "...",
                        );
                        const p = files.progress[file.name] || { loaded: 0, total: file.size || 0 };
                        const pct = p.total > 0 ? Math.min(100, Math.round((p.loaded * 100) / p.total)) : null;
                        return (
                          <tr key={`${idx}-${file.name}`}>
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
                      {files.failed.map((entry, idx) => {
                        const truncatedFilename = truncate(
                          entry.file.name,
                          FILENAME_TRUNCATE_START,
                          FILENAME_TRUNCATE_END,
                          "...",
                        );
                        return (
                          <tr key={`failed-${idx}-${entry.file.name}`} data-testid={`tus-failed-${entry.file.name}`}>
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
