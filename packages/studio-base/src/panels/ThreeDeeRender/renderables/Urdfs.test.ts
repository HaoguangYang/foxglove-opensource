// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import type { EmbeddedUrdfPackage } from "./EmbeddedUrdfPackage";
import { getLocalFilesUrdfSettings, getLocalUrdfImportPlan } from "./Urdfs";

// Model rendering loads a WebAssembly asset that Jest cannot execute. The settings helpers do
// not depend on it, so replace only that external rendering boundary.
jest.mock("./markers/RenderableMeshResource", () => ({
  RenderableMeshResource: jest.fn(),
}));

describe("browser local URDF settings", () => {
  const importedPackage: EmbeddedUrdfPackage = {
    version: 1,
    id: "robot",
    packageName: "robot",
    urdfPath: "robot.urdf",
    files: { "robot.urdf": { data: "PHJvYm90Lz4=" } },
  };

  // This catches the regression where the chooser only existed in the overflow menu.
  it("attaches the inline package chooser only to browser-local sources", () => {
    expect(getLocalFilesUrdfSettings("localFiles").actions).toEqual([
      {
        type: "action",
        id: "import-local-files",
        label: "Choose URDF package",
        icon: "FolderOpen",
        display: "inline",
      },
    ]);
    expect(getLocalFilesUrdfSettings("url").actions).toEqual([]);
  });

  // This catches cancellation leaving an old URL/topic/parameter model visible after the
  // source has become empty Local files, while keeping a manual replacement cancel non-destructive.
  it("clears before an empty source switch but not before a manual package replacement", () => {
    expect(
      getLocalUrdfImportPlan("source-change", { sourceType: "localFiles" }),
    ).toEqual({ openPicker: true, clearBeforePicker: true });
    expect(
      getLocalUrdfImportPlan("source-change", {
        sourceType: "localFiles",
        localPackage: importedPackage,
      }),
    ).toEqual({ openPicker: false, clearBeforePicker: false });
    expect(
      getLocalUrdfImportPlan("manual", {
        sourceType: "localFiles",
        localPackage: importedPackage,
      }),
    ).toEqual({ openPicker: true, clearBeforePicker: false });
  });
});
