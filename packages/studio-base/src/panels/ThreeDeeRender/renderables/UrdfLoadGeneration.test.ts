// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { UrdfLoadGeneration } from "./UrdfLoadGeneration";

describe("UrdfLoadGeneration", () => {
  it("invalidates an older source load when a layer changes source", () => {
    const generation = new UrdfLoadGeneration();
    const older = generation.begin("urdf-layer");
    const newer = generation.begin("urdf-layer");

    expect(generation.isCurrent("urdf-layer", older)).toBe(false);
    expect(generation.isCurrent("urdf-layer", newer)).toBe(true);
  });

  it("invalidates a pending directory import and its parse when a newer import begins", () => {
    const generation = new UrdfLoadGeneration();
    const firstImport = generation.begin("urdf-layer");
    const firstParse = firstImport;
    const secondImport = generation.begin("urdf-layer");

    expect(generation.isCurrent("urdf-layer", firstImport)).toBe(false);
    expect(generation.isCurrent("urdf-layer", firstParse)).toBe(false);
    expect(generation.isCurrent("urdf-layer", secondImport)).toBe(true);
  });
});
