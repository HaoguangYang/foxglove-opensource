// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Asset } from "@foxglove/studio-base/components/PanelExtensionAdapter/types";

const EMBEDDED_URDF_PROTOCOL = "embedded-urdf:";
const PACKAGE_VERSION = 1;

export const MAX_EMBEDDED_URDF_ASSET_COUNT = 1_000;
export const MAX_EMBEDDED_URDF_BYTES = 50 * 1024 * 1024;

export type EmbeddedUrdfAsset = {
  /** MIME type reported by the browser, or inferred from the asset path. */
  mediaType?: string;
  /** Base64-encoded asset bytes. This is JSON-serializable layout state. */
  data: string;
};

export type EmbeddedUrdfPackage = {
  version: typeof PACKAGE_VERSION;
  /** Stable identifier used only to namespace runtime package URLs. */
  id: string;
  /** Name used to resolve package:// URLs found in the URDF. */
  packageName: string;
  /** Package-relative path to the selected URDF or Xacro entry point. */
  urdfPath: string;
  /** Package-relative asset path to base64 payload. */
  files: Record<string, EmbeddedUrdfAsset>;
};

export type EmbeddedUrdfFileInput = {
  path: string;
  mediaType?: string;
  data: Uint8Array;
};

export type EmbeddedUrdfPackageInput = {
  id: string;
  packageName: string;
  urdfPath: string;
  files: readonly EmbeddedUrdfFileInput[];
};

export type ResolvedEmbeddedUrdfAsset = EmbeddedUrdfAsset & {
  path: string;
  url: string;
};

type DecodedEmbeddedUrdfAsset = Omit<EmbeddedUrdfAsset, "data"> & {
  data: Uint8Array;
};

/**
 * Creates the portable representation stored in a custom-layer layout. Files and handles are
 * intentionally converted to base64 before reaching this boundary.
 */
export function createEmbeddedUrdfPackage(
  input: EmbeddedUrdfPackageInput,
): EmbeddedUrdfPackage {
  const packageInfo = validatePackageInfo(input);
  const candidates = new Map<string, EmbeddedUrdfFileInput>();
  for (const file of input.files) {
    const path = normalizePackagePath(file.path);
    if (candidates.has(path)) {
      throw new Error(`Duplicate embedded URDF asset: "${path}"`);
    }
    candidates.set(path, { ...file, path });
  }
  const closure = collectEmbeddedUrdfClosure(
    packageInfo.urdfPath,
    packageInfo.packageName,
    (path) => candidates.get(path),
  );
  return makeEmbeddedUrdfPackage(packageInfo, closure);
}

/** Returns decoded bytes for a known package-relative asset path. */
export function decodeEmbeddedUrdfAsset(
  source: EmbeddedUrdfPackage,
  path: string,
): DecodedEmbeddedUrdfAsset | undefined {
  const normalizedPath = normalizePackagePath(path);
  const asset = source.files[normalizedPath];
  return asset ? { ...asset, data: decodeBase64(asset.data) } : undefined;
}

/**
 * Resolves relative, package://, and embedded-urdf:// references without permitting escape from
 * the imported directory. Unknown external URLs are deliberately returned as undefined so their
 * existing source handlers continue to own them.
 */
export function resolveEmbeddedUrdfAsset(
  source: EmbeddedUrdfPackage,
  uri: string,
  referencePath?: string,
): ResolvedEmbeddedUrdfAsset | undefined {
  const path = resolvePackagePath(source, uri, referencePath);
  if (!path) {
    return undefined;
  }
  const asset = source.files[path];
  return asset ? { ...asset, path, url: makeEmbeddedUrdfUrl(source, path) } : undefined;
}

/** Produces a synthetic, package-scoped URL. It is never written to the layout. */
export function makeEmbeddedUrdfUrl(source: EmbeddedUrdfPackage, path: string): string {
  return `${EMBEDDED_URDF_PROTOCOL}//${encodeURIComponent(source.id)}/${encodePath(
    normalizePackagePath(path),
  )}`;
}

/**
 * Runtime view over the serializable package. It uses no object URLs: data URLs let Three.js load
 * embedded glTF and Collada secondary resources without retaining browser file permissions.
 */
export class EmbeddedUrdfPackageResolver {
  public readonly source: EmbeddedUrdfPackage;

  public constructor(source: EmbeddedUrdfPackage) {
    this.source = source;
  }

  public urdfText(): string {
    const urdf = decodeEmbeddedUrdfAsset(this.source, this.source.urdfPath);
    if (!urdf) {
      throw new Error(`Selected URDF "${this.source.urdfPath}" is not in the package`);
    }
    return new TextDecoder().decode(urdf.data);
  }

  public urdfUrl(): string {
    return makeEmbeddedUrdfUrl(this.source, this.source.urdfPath);
  }

  public resolve(uri: string, referencePath?: string): ResolvedEmbeddedUrdfAsset | undefined {
    return resolveEmbeddedUrdfAsset(this.source, uri, referencePath);
  }

  public fetchAsset = async (
    uri: string,
    options?: { referenceUrl?: string },
  ): Promise<Asset> => {
    const referencePath = options?.referenceUrl
      ? packagePathFromEmbeddedUrl(this.source, options.referenceUrl)
      : undefined;
    const asset = this.resolve(uri, referencePath);
    if (!asset) {
      throw new Error(`Embedded URDF package does not contain "${uri}"`);
    }
    return {
      uri: asset.url,
      data: decodeBase64(asset.data),
      mediaType: asset.mediaType,
    };
  };

  public resolveToDataUrl = (uri: string): string => {
    if (isDataUri(uri)) {
      return uri;
    }
    const originalUri = extractOriginalUri(uri);
    if (isDataUri(originalUri)) {
      return originalUri;
    }
    const asset = this.resolve(originalUri);
    if (!asset) {
      throw new Error(`Embedded URDF package does not contain "${uri}"`);
    }
    return `data:${asset.mediaType ?? "application/octet-stream"};base64,${asset.data}`;
  };
}

/** Converts selected browser files to the portable package while retaining only byte data. */
export async function createEmbeddedUrdfPackageFromFiles(args: {
  id: string;
  packageName: string;
  urdfPath: string;
  files: readonly { path: string; file: File }[];
}): Promise<EmbeddedUrdfPackage> {
  const packageInfo = validatePackageInfo(args);
  if (args.files.length > MAX_EMBEDDED_URDF_ASSET_COUNT) {
    throw new Error(`Selected directory exceeds the ${MAX_EMBEDDED_URDF_ASSET_COUNT}-file limit`);
  }
  const candidates = new Map<string, File>();
  for (const { path: originalPath, file } of args.files) {
    const path = normalizePackagePath(originalPath);
    if (candidates.has(path)) {
      throw new Error(`Duplicate embedded URDF asset: "${path}"`);
    }
    candidates.set(path, file);
  }
  const declaredPaths = new Set<string>();
  let declaredBytes = 0;
  const closure = await collectEmbeddedUrdfClosureAsync(
    packageInfo.urdfPath,
    packageInfo.packageName,
    async (path) => {
      const file = candidates.get(path);
      if (!file) {
        return undefined;
      }
      if (!declaredPaths.has(path)) {
        assertClosureLimits(declaredPaths.size + 1, declaredBytes + file.size);
        declaredPaths.add(path);
        declaredBytes += file.size;
      }
      return {
        path,
        mediaType: file.type || inferMediaType(path),
        data: new Uint8Array(await file.arrayBuffer()),
      };
    },
  );
  return makeEmbeddedUrdfPackage(packageInfo, closure);
}

export function inferMediaType(path: string): string | undefined {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  switch (extension) {
    case ".urdf":
    case ".xacro":
    case ".xml":
      return "application/xml";
    case ".dae":
      return "model/vnd.collada+xml";
    case ".gltf":
      return "model/gltf+json";
    case ".glb":
      return "model/gltf-binary";
    case ".stl":
      return "model/stl";
    case ".obj":
      return "model/obj";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function validatePackageInfo(input: {
  id: string;
  packageName: string;
  urdfPath: string;
}): Pick<EmbeddedUrdfPackage, "id" | "packageName" | "urdfPath"> {
  if (!input.id) {
    throw new Error("Embedded URDF package id is required");
  }
  if (!input.packageName) {
    throw new Error("Embedded URDF package name is required");
  }
  return {
    id: input.id,
    packageName: input.packageName,
    urdfPath: normalizePackagePath(input.urdfPath),
  };
}

function makeEmbeddedUrdfPackage(
  packageInfo: Pick<EmbeddedUrdfPackage, "id" | "packageName" | "urdfPath">,
  closure: ReadonlyMap<string, EmbeddedUrdfFileInput>,
): EmbeddedUrdfPackage {
  const files: Record<string, EmbeddedUrdfAsset> = {};
  for (const [path, file] of closure) {
    files[path] = { data: encodeBase64(file.data), mediaType: file.mediaType };
  }
  return { version: PACKAGE_VERSION, ...packageInfo, files };
}

function collectEmbeddedUrdfClosure(
  urdfPath: string,
  packageName: string,
  getFile: (path: string) => EmbeddedUrdfFileInput | undefined,
): ReadonlyMap<string, EmbeddedUrdfFileInput> {
  const closure = new Map<string, EmbeddedUrdfFileInput>();
  const pending = [urdfPath];
  let totalBytes = 0;

  while (pending.length > 0) {
    const path = pending.pop()!;
    if (closure.has(path)) {
      continue;
    }
    const file = getFile(path);
    if (!file) {
      throw new Error(`Local URDF package is missing referenced asset "${path}"`);
    }
    assertClosureLimits(closure.size + 1, totalBytes + file.data.byteLength);
    closure.set(path, file);
    totalBytes += file.data.byteLength;
    pending.push(...getReferencedAssetPaths(file, path, packageName));
  }
  return closure;
}

async function collectEmbeddedUrdfClosureAsync(
  urdfPath: string,
  packageName: string,
  getFile: (path: string) => Promise<EmbeddedUrdfFileInput | undefined>,
): Promise<ReadonlyMap<string, EmbeddedUrdfFileInput>> {
  const closure = new Map<string, EmbeddedUrdfFileInput>();
  const pending = [urdfPath];
  let totalBytes = 0;

  while (pending.length > 0) {
    const path = pending.pop()!;
    if (closure.has(path)) {
      continue;
    }
    const file = await getFile(path);
    if (!file) {
      throw new Error(`Local URDF package is missing referenced asset "${path}"`);
    }
    assertClosureLimits(closure.size + 1, totalBytes + file.data.byteLength);
    closure.set(path, file);
    totalBytes += file.data.byteLength;
    pending.push(...getReferencedAssetPaths(file, path, packageName));
  }
  return closure;
}

function assertClosureLimits(fileCount: number, byteCount: number): void {
  if (fileCount > MAX_EMBEDDED_URDF_ASSET_COUNT) {
    throw new Error(`Local URDF package exceeds the ${MAX_EMBEDDED_URDF_ASSET_COUNT}-asset limit`);
  }
  if (byteCount > MAX_EMBEDDED_URDF_BYTES) {
    throw new Error(`Local URDF package exceeds the ${MAX_EMBEDDED_URDF_BYTES}-byte limit`);
  }
}

function getReferencedAssetPaths(
  file: EmbeddedUrdfFileInput,
  path: string,
  packageName: string,
): string[] {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  const text = new TextDecoder().decode(file.data);
  let references: string[];
  switch (extension) {
    case ".urdf":
    case ".xacro":
    case ".xml":
      references = getXmlAttributeReferences(text);
      break;
    case ".gltf":
      references = getGltfReferences(text, path);
      break;
    case ".dae":
      references = Array.from(text.matchAll(/<init_from>\s*([^<\s][^<]*)\s*<\/init_from>/giu), ([
        _match,
        reference,
      ]) => reference!.trim());
      break;
    case ".obj":
      if (/^\s*mtllib\s+/imu.test(text)) {
        throw new Error(`OBJ material libraries are not supported in local URDF packages: "${path}"`);
      }
      references = [];
      break;
    default:
      references = [];
      break;
  }
  return references.flatMap((reference) =>
    resolveEmbeddedDependencyPath(packageName, reference, path),
  );
}

function getXmlAttributeReferences(text: string): string[] {
  return Array.from(
    text.matchAll(/\b(?:filename|url)\s*=\s*["']([^"']+)["']/giu),
    ([_match, reference]) => reference!,
  );
}

function getGltfReferences(text: string, path: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid glTF asset "${path}": ${error}`);
  }
  const references: string[] = [];
  collectGltfUris(parsed, references);
  return references;
}

function collectGltfUris(value: unknown, references: string[]): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      collectGltfUris(child, references);
    }
  } else if (value != undefined && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "uri" && typeof child === "string") {
        references.push(child);
      } else {
        collectGltfUris(child, references);
      }
    }
  }
}

function resolveEmbeddedDependencyPath(
  packageName: string,
  uri: string,
  referencePath: string,
): string[] {
  if (uri.startsWith("data:")) {
    return [];
  }
  const path = resolvePackageReference(packageName, uri, referencePath);
  if (!path) {
    throw new Error(`External asset reference is not supported in local URDF packages: "${uri}"`);
  }
  return [path];
}

function resolvePackagePath(
  source: EmbeddedUrdfPackage,
  uri: string,
  referencePath?: string,
): string | undefined {
  return resolvePackageReference(source.packageName, uri, referencePath, source.id);
}

function resolvePackageReference(
  packageName: string,
  uri: string,
  referencePath?: string,
  packageId?: string,
): string | undefined {
  const normalizedUri = normalizeFindPackageReference(packageName, uri);
  if (!normalizedUri) {
    return undefined;
  }
  if (normalizedUri.startsWith(EMBEDDED_URDF_PROTOCOL)) {
    if (!packageId) {
      return undefined;
    }
    const { authority, path } = splitAuthorityAndPath(
      normalizedUri.slice(`${EMBEDDED_URDF_PROTOCOL}//`.length),
    );
    if (decodeURIComponent(authority) !== packageId) {
      return undefined;
    }
    return normalizePackagePath(path);
  }
  if (normalizedUri.startsWith("package://")) {
    const { authority, path } = splitAuthorityAndPath(normalizedUri.slice("package://".length));
    if (decodeURIComponent(authority) !== packageName) {
      return undefined;
    }
    return normalizePackagePath(path);
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(normalizedUri) || normalizedUri.startsWith("//")) {
    return undefined;
  }
  const base = referencePath ? directoryOf(normalizePackagePath(referencePath)) : "";
  return normalizePackagePath(`${base}${stripQueryAndHash(normalizedUri)}`);
}

/** Matches the Xacro parser's `$(find package)` expansion without permitting another package. */
function normalizeFindPackageReference(packageName: string, uri: string): string | undefined {
  if (!uri.startsWith("$(find")) {
    return uri;
  }
  const match = /^\$\(find\s+([^)]+)\)(?:\/(.*))?$/u.exec(uri);
  if (!match || match[1]!.trim() !== packageName) {
    return undefined;
  }
  return `package://${encodeURIComponent(packageName)}/${match[2] ?? ""}`;
}

function splitAuthorityAndPath(value: string): { authority: string; path: string } {
  const slash = value.indexOf("/");
  if (slash === -1) {
    return { authority: value, path: "" };
  }
  return {
    authority: value.slice(0, slash),
    path: stripQueryAndHash(value.slice(slash + 1)),
  };
}

function extractOriginalUri(uri: string): string {
  const packageStart = uri.indexOf("/package://");
  return packageStart === -1 ? uri : uri.slice(packageStart + 1);
}

function isDataUri(uri: string): boolean {
  if (!uri.startsWith("data:")) {
    return false;
  }
  const comma = uri.indexOf(",");
  return comma >= "data:".length && !/[\r\n]/u.test(uri.slice(0, comma));
}

function packagePathFromEmbeddedUrl(
  source: EmbeddedUrdfPackage,
  url: string,
): string | undefined {
  const prefix = `${EMBEDDED_URDF_PROTOCOL}//${encodeURIComponent(source.id)}/`;
  if (!url.startsWith(prefix)) {
    return undefined;
  }
  const path = stripQueryAndHash(url.slice(prefix.length))
    .split("/")
    .map((segment) => decodeURIComponent(segment))
    .join("/");
  return normalizePackagePath(path);
}

function stripQueryAndHash(value: string): string {
  const index = value.search(/[?#]/u);
  return index === -1 ? value : value.slice(0, index);
}

function normalizePackagePath(path: string): string {
  if (!path) {
    throw new Error("Embedded URDF asset path is required");
  }
  const result: string[] = [];
  const decodedPath = path
    .replaceAll(/%2e/giu, ".")
    .replaceAll(/%2f|%5c/giu, "/")
    .replaceAll("\\", "/");
  for (const segment of decodedPath.split("/")) {
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (!result.pop()) {
        throw new Error(`Asset path "${path}" resolves outside the selected package`);
      }
      continue;
    }
    result.push(segment);
  }
  if (result.length === 0) {
    throw new Error(`Asset path "${path}" resolves outside the selected package`);
  }
  return result.join("/");
}

function directoryOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index + 1);
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
}
