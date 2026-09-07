// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  createEmbeddedUrdfPackage,
  createEmbeddedUrdfPackageFromFiles,
  decodeEmbeddedUrdfAsset,
  EmbeddedUrdfPackageResolver,
  MAX_EMBEDDED_URDF_BYTES,
  resolveEmbeddedUrdfAsset,
} from "./EmbeddedUrdfPackage";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe("EmbeddedUrdfPackage", () => {
  it("preserves a URDF and its relative mesh through a JSON layout round-trip", () => {
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "urdf/robot.urdf",
      files: [
        {
          path: "urdf/robot.urdf",
          mediaType: "application/xml",
          data: encoder.encode('<robot name="test"><link name="base"><visual><geometry><mesh filename="../meshes/base.stl"/></geometry></visual></link></robot>'),
        },
        {
          path: "meshes/base.stl",
          mediaType: "model/stl",
          data: Uint8Array.from([0, 1, 2, 3]),
        },
      ],
    });

    const serialized = JSON.stringify(source);
    expect(serialized).toBeDefined();
    const restored = JSON.parse(serialized!) as typeof source;

    const urdf = decodeEmbeddedUrdfAsset(restored, "urdf/robot.urdf");
    expect(urdf).toBeDefined();
    expect(decoder.decode(urdf!.data)).toContain('filename="../meshes/base.stl"');
    expect(
      resolveEmbeddedUrdfAsset(restored, "../meshes/base.stl", "urdf/robot.urdf"),
    ).toMatchObject({ path: "meshes/base.stl", mediaType: "model/stl" });
  });

  it("resolves a relative asset from an embedded reference URL", async () => {
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "urdf/robot.urdf",
      files: [
        {
          path: "urdf/robot.urdf",
          mediaType: "application/xml",
          data: encoder.encode(
            '<robot name="test"><link name="base"><visual><geometry><mesh filename="../meshes/base.stl"/></geometry></visual></link></robot>',
          ),
        },
        {
          path: "meshes/base.stl",
          mediaType: "model/stl",
          data: Uint8Array.from([0, 1, 2, 3]),
        },
      ],
    });
    const resolver = new EmbeddedUrdfPackageResolver(source);

    await expect(
      resolver.fetchAsset("../meshes/base.stl", { referenceUrl: resolver.urdfUrl() }),
    ).resolves.toMatchObject({ uri: "embedded-urdf://robot-package/meshes/base.stl" });
  });

  it("rejects references that traverse outside the selected package", () => {
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "urdf/robot.urdf",
      files: [
        {
          path: "urdf/robot.urdf",
          mediaType: "application/xml",
          data: encoder.encode('<robot name="test"/>'),
        },
      ],
    });

    expect(() =>
      resolveEmbeddedUrdfAsset(source, "../../../outside.stl", "urdf/robot.urdf"),
    ).toThrow("outside the selected package");
    expect(() =>
      resolveEmbeddedUrdfAsset(source, "%2e%2e/%2e%2e/outside.stl", "urdf/robot.urdf"),
    ).toThrow("outside the selected package");
  });

  it("resolves a matching package URL without allowing a different package", () => {
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "urdf/robot.urdf",
      files: [
        {
          path: "urdf/robot.urdf",
          mediaType: "application/xml",
          data: encoder.encode(
            '<robot name="test"><link name="base"><visual><geometry><mesh filename="package://robot/meshes/base.stl"/></geometry></visual></link></robot>',
          ),
        },
        {
          path: "meshes/base.stl",
          mediaType: "model/stl",
          data: Uint8Array.from([0, 1, 2, 3]),
        },
      ],
    });

    expect(resolveEmbeddedUrdfAsset(source, "package://robot/meshes/base.stl")).toMatchObject({
      path: "meshes/base.stl",
    });
    expect(resolveEmbeddedUrdfAsset(source, "package://another/meshes/base.stl")).toBeUndefined();
  });

  it("fails closed when a secondary model resource is not in the selected package", () => {
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "robot.urdf",
      files: [
        {
          path: "robot.urdf",
          mediaType: "application/xml",
          data: encoder.encode('<robot name="test"/>'),
        },
      ],
    });
    const resolver = new EmbeddedUrdfPackageResolver(source);

    expect(() => resolver.resolveToDataUrl("https://example.com/texture.png")).toThrow(
      "does not contain",
    );
    expect(() => resolver.resolveToDataUrl("package://another/texture.png")).toThrow(
      "does not contain",
    );
  });

  it("resolves the selected package URL after a synthetic loader base URL", () => {
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "robot.urdf",
      files: [
        {
          path: "robot.urdf",
          mediaType: "application/xml",
          data: encoder.encode(
            '<robot name="test"><link name="base"><visual><geometry><mesh filename="package://robot/textures/base.png"/></geometry></visual></link></robot>',
          ),
        },
        {
          path: "textures/base.png",
          mediaType: "image/png",
          data: Uint8Array.from([137, 80, 78, 71]),
        },
      ],
    });
    const resolver = new EmbeddedUrdfPackageResolver(source);

    expect(
      resolver.resolveToDataUrl(
        "embedded-urdf://robot-package/meshes/package://robot/textures/base.png",
      ),
    ).toContain("image/png;base64,iVBORw==");
  });

  it("rejects raw and encoded package traversal before it can be URL-normalized", () => {
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "robot.urdf",
      files: [
        {
          path: "robot.urdf",
          mediaType: "application/xml",
          data: encoder.encode('<robot name="test"/>'),
        },
      ],
    });
    const resolver = new EmbeddedUrdfPackageResolver(source);

    expect(() => resolver.resolveToDataUrl("package://robot/meshes/../../outside.png")).toThrow(
      "outside the selected package",
    );
    expect(() =>
      resolver.resolveToDataUrl("package://robot/meshes/%2e%2e/%2E%2e/outside.png"),
    ).toThrow("outside the selected package");
  });

  it("serializes only the URDF asset closure, not unrelated selected files", () => {
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "urdf/robot.urdf",
      files: [
        {
          path: "urdf/robot.urdf",
          mediaType: "application/xml",
          data: encoder.encode(
            '<robot name="test"><link name="base"><visual><geometry><mesh filename="../meshes/base.gltf"/></geometry></visual></link></robot>',
          ),
        },
        {
          path: "meshes/base.gltf",
          mediaType: "model/gltf+json",
          data: encoder.encode('{"asset":{"version":"2.0"},"images":[{"uri":"textures/base.png"}]}'),
        },
        {
          path: "meshes/textures/base.png",
          mediaType: "image/png",
          data: Uint8Array.from([137, 80, 78, 71]),
        },
        {
          path: "secrets/credentials.txt",
          mediaType: "text/plain",
          data: encoder.encode("do not serialize"),
        },
      ],
    });

    expect(Object.keys(source.files).sort()).toEqual([
      "meshes/base.gltf",
      "meshes/textures/base.png",
      "urdf/robot.urdf",
    ]);
  });

  it("keeps inline glTF data URIs local without requiring a package asset", () => {
    const inlineBuffer = "data:application/octet-stream;base64,AAE=";
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "robot.urdf",
      files: [
        {
          path: "robot.urdf",
          mediaType: "application/xml",
          data: encoder.encode(
            '<robot name="test"><link name="base"><visual><geometry><mesh filename="meshes/base.gltf"/></geometry></visual></link></robot>',
          ),
        },
        {
          path: "meshes/base.gltf",
          mediaType: "model/gltf+json",
          data: encoder.encode(JSON.stringify({ asset: { version: "2.0" }, buffers: [{ uri: inlineBuffer }] })),
        },
      ],
    });
    const resolver = new EmbeddedUrdfPackageResolver(source);

    expect(Object.keys(source.files).sort()).toEqual(["meshes/base.gltf", "robot.urdf"]);
    expect(resolver.resolveToDataUrl(inlineBuffer)).toBe(inlineBuffer);
  });

  it("collects same-package Xacro find references before JSON round-trip", () => {
    const source = createEmbeddedUrdfPackage({
      id: "robot-package",
      packageName: "robot",
      urdfPath: "xacro/robot.xacro",
      files: [
        {
          path: "xacro/robot.xacro",
          mediaType: "application/xml",
          data: encoder.encode(
            '<robot xmlns:xacro="http://www.ros.org/wiki/xacro"><xacro:include filename="$(find robot)/xacro/part.xacro"/><link name="base"><visual><geometry><mesh filename="$(find robot)/meshes/base.stl"/></geometry></visual></link></robot>',
          ),
        },
        {
          path: "xacro/part.xacro",
          mediaType: "application/xml",
          data: encoder.encode('<robot xmlns:xacro="http://www.ros.org/wiki/xacro"/>'),
        },
        { path: "meshes/base.stl", mediaType: "model/stl", data: Uint8Array.from([1, 2, 3]) },
      ],
    });
    const restored = JSON.parse(JSON.stringify(source)!) as typeof source;

    expect(Object.keys(restored.files).sort()).toEqual([
      "meshes/base.stl",
      "xacro/part.xacro",
      "xacro/robot.xacro",
    ]);
    expect(resolveEmbeddedUrdfAsset(restored, "package://robot/meshes/base.stl")).toMatchObject({
      path: "meshes/base.stl",
    });
    expect(() =>
      createEmbeddedUrdfPackage({
        ...source,
        files: [
          {
            path: "xacro/robot.xacro",
            data: encoder.encode('<robot><xacro:include filename="$(find other)/part.xacro"/></robot>'),
          },
        ],
      }),
    ).toThrow("External asset reference");
  });

  it("rejects a reachable oversized browser File before reading its bytes", async () => {
    const urdfText = '<robot name="test"><link name="base"><visual><geometry><mesh filename="meshes/base.glb"/></geometry></visual></link></robot>';
    const urdfFile = {
      type: "application/xml",
      size: encoder.encode(urdfText).byteLength,
      arrayBuffer: jest.fn(async () => encoder.encode(urdfText).buffer),
    } as unknown as File;
    const readOversizedFile = jest.fn();
    const oversizedFile = {
      type: "model/gltf-binary",
      size: MAX_EMBEDDED_URDF_BYTES + 1,
      arrayBuffer: readOversizedFile,
    } as unknown as File;

    await expect(
      createEmbeddedUrdfPackageFromFiles({
        id: "robot-package",
        packageName: "robot",
        urdfPath: "robot.urdf",
        files: [
          { path: "robot.urdf", file: urdfFile },
          { path: "meshes/base.glb", file: oversizedFile },
        ],
      }),
    ).rejects.toThrow("byte limit");
    expect(readOversizedFile).not.toHaveBeenCalled();
  });
});
