// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.

import * as THREE from "three";

import { ModelCache, resolveModelAssetUrl } from "./ModelCache";

jest.mock("three/examples/jsm/libs/draco/draco_decoder.wasm", () => "", { virtual: true });
jest.mock("three/examples/jsm/libs/draco/draco_wasm_wrapper.js?raw", () => "", { virtual: true });

describe("ModelCache", () => {
  it("does not fall back to a URL when an embedded-package resolver rejects it", () => {
    const missingAsset = () => {
      throw new Error("Embedded URDF package does not contain the URL");
    };

    expect(() => resolveModelAssetUrl("https://example.com/texture.png", missingAsset)).toThrow(
      "does not contain",
    );
  });

  it("reloads an embedded model after its cache entry is evicted", async () => {
    const fetchAsset = jest.fn(async (uri: string) => ({
      uri,
      mediaType: "model/obj",
      data: new TextEncoder().encode("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n"),
    }));
    const cache = new ModelCache({
      edgeMaterial: new THREE.LineBasicMaterial(),
      ignoreColladaUpAxis: false,
      meshUpAxis: "z_up",
      fetchAsset,
    });
    const url = "embedded-urdf://old-package/meshes/base.obj";

    expect(await cache.load(url, {}, jest.fn())).toBeDefined();
    cache.evict(url);
    expect(await cache.load(url, {}, jest.fn())).toBeDefined();

    expect(fetchAsset).toHaveBeenCalledTimes(2);
    cache.dispose();
  });
});
