// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import { LocalModelUrlReferences } from "./LocalModelUrlReferences";

describe("LocalModelUrlReferences", () => {
  it("keeps a duplicated package model cached until its final layer releases it", () => {
    const references = new LocalModelUrlReferences();
    const modelUrl = "embedded-urdf://package/meshes/base.glb";

    expect(references.replace("first", [modelUrl])).toEqual(new Set());
    // Reserve before the duplicate's asynchronous URDF parse begins.
    expect(references.replace("duplicate", [modelUrl])).toEqual(new Set());
    expect(references.release("first")).toEqual(new Set());
    expect(references.release("duplicate")).toEqual(new Set([modelUrl]));
  });

  it("evicts only models no longer reserved by a replacement layer", () => {
    const references = new LocalModelUrlReferences();
    const oldUrl = "embedded-urdf://old/meshes/base.glb";
    const retainedUrl = "embedded-urdf://shared/meshes/base.glb";
    const newUrl = "embedded-urdf://new/meshes/base.glb";

    references.replace("first", [oldUrl, retainedUrl]);
    references.replace("second", [retainedUrl]);

    expect(references.replace("first", [newUrl])).toEqual(new Set([oldUrl]));
    expect(references.release("second")).toEqual(new Set([retainedUrl]));
    expect(references.release("first")).toEqual(new Set([newUrl]));
  });

  it("releases every remaining URL when the renderer is disposed", () => {
    const references = new LocalModelUrlReferences();
    references.replace("first", ["embedded-urdf://package/a.glb"]);
    references.replace("second", ["embedded-urdf://package/a.glb", "embedded-urdf://package/b.glb"]);

    expect(references.clear()).toEqual(
      new Set(["embedded-urdf://package/a.glb", "embedded-urdf://package/b.glb"]),
    );
  });
});
