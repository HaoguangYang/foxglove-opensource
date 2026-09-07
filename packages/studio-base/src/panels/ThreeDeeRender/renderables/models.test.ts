// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import * as THREE from "three";

import { replaceMaterials } from "./models";

describe("replaceMaterials", () => {
  it("keeps ModelCache-owned source materials alive when requested", () => {
    const sourceMaterial = new THREE.MeshStandardMaterial();
    const sourceTexture = new THREE.Texture();
    sourceMaterial.map = sourceTexture;
    const disposeMaterial = jest.spyOn(sourceMaterial, "dispose");
    const disposeTexture = jest.spyOn(sourceTexture, "dispose");
    const model = new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(), sourceMaterial));
    const replacement = new THREE.MeshStandardMaterial();

    replaceMaterials(model, replacement, { disposeReplacedMaterials: false });

    expect(disposeMaterial).not.toHaveBeenCalled();
    expect(disposeTexture).not.toHaveBeenCalled();
    expect((model.children[0] as THREE.Mesh).material).toBe(replacement);
  });
});
