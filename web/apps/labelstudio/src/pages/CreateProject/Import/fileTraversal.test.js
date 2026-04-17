/**
 * Unit tests for the lazy iterateFileTree generator.
 *
 * We stub the webkitGetAsEntry / createReader / readEntries surface that the
 * browser's DataTransferItemList exposes so the tests can run in jsdom.
 */

import { iterateFileTree } from "./fileTraversal";

function makeFileEntry(name) {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file(cb) {
      cb({ name, type: "image/jpeg", size: 123 });
    },
  };
}

function makeDirEntry(name, children) {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader() {
      // Spec: readEntries returns in batches; we split into two to prove the
      // drain loop works.
      let served = 0;
      return {
        readEntries(cb) {
          if (served === 0) {
            served = 1;
            cb(children.slice(0, Math.ceil(children.length / 2)));
          } else if (served === 1) {
            served = 2;
            cb(children.slice(Math.ceil(children.length / 2)));
          } else {
            cb([]);
          }
        },
      };
    },
  };
}

function dataTransferItemList(entries) {
  return entries.map((entry) => ({
    webkitGetAsEntry() {
      return entry;
    },
  }));
}

describe("iterateFileTree", () => {
  test("yields a single file from a DataTransferItemList", async () => {
    const items = dataTransferItemList([makeFileEntry("a.jpg")]);
    const out = [];
    for await (const f of iterateFileTree(items)) out.push(f);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("a.jpg");
  });

  test("walks a nested directory and yields all files", async () => {
    const tree = dataTransferItemList([
      makeDirEntry("top", [
        makeFileEntry("a.jpg"),
        makeDirEntry("inner", [makeFileEntry("b.jpg"), makeFileEntry("c.jpg")]),
        makeFileEntry("d.jpg"),
      ]),
    ]);
    const out = [];
    for await (const f of iterateFileTree(tree)) out.push(f.name);
    expect(out.sort()).toEqual(["a.jpg", "b.jpg", "c.jpg", "d.jpg"]);
  });

  test("skips hidden dotfiles", async () => {
    const items = dataTransferItemList([makeFileEntry(".DS_Store"), makeFileEntry("ok.jpg")]);
    const out = [];
    for await (const f of iterateFileTree(items)) out.push(f.name);
    expect(out).toEqual(["ok.jpg"]);
  });

  test("treats FileList (no webkitGetAsEntry) as a flat list", async () => {
    const fileList = [{ name: "x.jpg" }, { name: ".hidden" }, { name: "y.jpg" }];
    const out = [];
    for await (const f of iterateFileTree(fileList)) out.push(f.name);
    expect(out).toEqual(["x.jpg", "y.jpg"]);
  });

  test("yields nothing for an empty list", async () => {
    const out = [];
    for await (const f of iterateFileTree([])) out.push(f);
    expect(out).toEqual([]);
  });
});
