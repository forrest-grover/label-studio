/**
 * Lazy drag-drop traversal — yields one File at a time.
 *
 * Replaces the old `traverseFileTree` + `getFiles` pair (Import.jsx:49–86)
 * which did a `Promise.all` over every entry before returning. With 10,000
 * images that approach materialises every File in memory at once; the
 * generator keeps only the current frontier alive. See UPLOAD_FIX_DESIGN.md
 * §A1.
 */

function fileFromEntry(entry) {
  return new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}

function readAllEntries(dirReader) {
  // readEntries() is capped at ~100 entries per call by spec; drain in a loop.
  return new Promise((resolve, reject) => {
    const out = [];
    const pump = () => {
      dirReader.readEntries((batch) => {
        if (!batch || batch.length === 0) {
          resolve(out);
          return;
        }
        out.push(...batch);
        pump();
      }, reject);
    };
    pump();
  });
}

async function* iterateEntry(entry) {
  if (!entry) return;
  if (entry.isFile) {
    if (entry.name && entry.name[0] === ".") return; // skip hidden
    try {
      const file = await fileFromEntry(entry);
      yield file;
    } catch (_) {
      /* unreadable file; skip */
    }
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const entries = await readAllEntries(reader);
    for (const child of entries) {
      yield* iterateEntry(child);
    }
  }
}

/**
 * `items` is a DataTransferItemList (drag-drop) OR a FileList (click-to-browse).
 * The FileList path cannot have directories, so we yield directly.
 */
export async function* iterateFileTree(items) {
  if (!items || items.length === 0) return;

  // <input type=file> yields FileList; files do not have webkitGetAsEntry.
  const first = items[0];
  if (typeof first.webkitGetAsEntry !== "function") {
    for (const file of items) {
      if (file && file.name && file.name[0] !== ".") yield file;
    }
    return;
  }

  // DataTransferItemList: snapshot entries up front because the underlying
  // DataTransfer can be invalidated after the drop event's microtask.
  const entries = [];
  for (const item of items) {
    const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry) entries.push(entry);
  }
  for (const entry of entries) {
    yield* iterateEntry(entry);
  }
}
