/**
 * Workspace-rooted, content-addressed asset storage: uploaded asset bytes are
 * persisted once under `<workspaceRoot>/assets/<contentHash>.<extension>`,
 * alongside a small JSON sidecar (`<contentHash>.meta.json`) carrying the
 * metadata a raw byte blob cannot itself carry (source URL, content type,
 * upload time).
 *
 * Every path this module constructs is built from a content hash, produced
 * by `@cadra/core`'s `hashAssetBytes` (see that module's own doc: "do not
 * reimplement hashing elsewhere, reuse this"), so it is never influenced by
 * caller-supplied text and cannot itself be a path-traversal vector. The one
 * piece of caller-influenced text this module ever turns into a path segment
 * is the file extension (derived from an optionally caller-supplied content
 * type or source URL); {@link sanitizeAssetExtension} applies the exact same
 * allow-list-plus-resolved-path-check discipline `scene-store.ts`'s
 * `sanitizeSceneId` established for scene ids, so a malicious content type or
 * URL can never smuggle a `..`/`/`/absolute-path segment into the final
 * asset path.
 *
 * Assets are deduplicated by construction: two uploads with byte-identical
 * content hash to the same value and therefore resolve to the same path,
 * so a second upload of the same bytes overwrites the same file with
 * identical content (a no-op in effect) rather than creating a second copy.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ContentHash } from "@cadra/core";
import { hashAssetBytes } from "@cadra/core";

/** Subdirectory under `workspaceRoot` asset files are persisted in. */
const ASSETS_SUBDIRECTORY = "assets";

/** Suffix (after the content hash) every metadata sidecar file uses. */
const ASSET_META_SUFFIX = ".meta.json";

/**
 * Fallback extension (no leading dot) used when no content type or source
 * URL yields a recognizable one. Deliberately generic rather than guessing.
 */
const DEFAULT_ASSET_EXTENSION = "bin";

/**
 * An asset extension (no leading dot) is accepted only if it matches this
 * pattern: one or more characters from a conservative allow-list (letters,
 * digits). This rules out `/`, `\`, `..`, `.`, null bytes, and any other
 * path-meaningful character by construction, mirroring
 * `scene-store.ts`'s `VALID_SCENE_ID_PATTERN` rationale exactly.
 */
const VALID_EXTENSION_PATTERN = /^[A-Za-z0-9]+$/;

/** Upper bound on extension length; generous for any realistic file extension, bounded against a pathological input. */
const MAX_EXTENSION_LENGTH = 16;

/** The MCP-facing asset ref scheme this module mints and parses: `cadra-asset://<contentHash>`. */
export const ASSET_REF_SCHEME = "cadra-asset://";

/** Builds the asset ref string for `hash`, valid to place directly into a scene node's `assetRef` field. */
export function buildAssetRef(hash: ContentHash): string {
  return `${ASSET_REF_SCHEME}${hash}`;
}

/**
 * Parses an asset ref built by {@link buildAssetRef} back into its content
 * hash, or returns `undefined` if `ref` does not use the `cadra-asset://`
 * scheme this module mints.
 */
export function parseAssetRef(ref: string): ContentHash | undefined {
  if (!ref.startsWith(ASSET_REF_SCHEME)) {
    return undefined;
  }
  return ref.slice(ASSET_REF_SCHEME.length);
}

/**
 * A minimal, well-known content-type-to-extension table for the asset kinds
 * this codebase's own `AssetKind` union names (image, video, font, gltf,
 * audio). Not exhaustive: an unrecognized or absent content type falls back
 * to sniffing `sourceUrl`'s own extension, then to {@link DEFAULT_ASSET_EXTENSION}.
 */
const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "font/woff2": "woff2",
  "font/woff": "woff",
  "font/ttf": "ttf",
  "model/gltf+json": "gltf",
  "model/gltf-binary": "glb",
  "application/octet-stream": DEFAULT_ASSET_EXTENSION,
};

/** Extracts a bare, lowercased extension (no leading dot) from `sourceUrl`'s path, ignoring any query string or fragment; `undefined` if none is found. */
function extensionFromUrl(sourceUrl: string): string | undefined {
  try {
    const { pathname } = new URL(sourceUrl);
    const lastSegment = pathname.split("/").pop() ?? "";
    const dotIndex = lastSegment.lastIndexOf(".");
    if (dotIndex === -1 || dotIndex === lastSegment.length - 1) {
      return undefined;
    }
    return lastSegment.slice(dotIndex + 1).toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Validates that `extension` is safe to use as a filename suffix: non-empty,
 * within {@link MAX_EXTENSION_LENGTH}, and composed only of `[A-Za-z0-9]`.
 * Mirrors `scene-store.ts`'s `sanitizeSceneId` structure exactly, applied to
 * this module's own narrower "just an extension" path segment.
 */
export function sanitizeAssetExtension(
  extension: string,
): { valid: true; extension: string } | { valid: false; reason: string } {
  if (extension.length === 0) {
    return { valid: false, reason: "Extension must not be empty." };
  }
  if (extension.length > MAX_EXTENSION_LENGTH) {
    return {
      valid: false,
      reason: `Extension must be at most ${MAX_EXTENSION_LENGTH} characters long.`,
    };
  }
  if (!VALID_EXTENSION_PATTERN.test(extension)) {
    return {
      valid: false,
      reason: "Extension must contain only letters and digits (no dots, no path separators).",
    };
  }
  return { valid: true, extension: extension.toLowerCase() };
}

/**
 * Derives a safe, lowercased extension (no leading dot) for a newly-uploaded
 * asset: prefers `contentType`'s well-known mapping, falls back to sniffing
 * `sourceUrl`'s own extension, then to {@link DEFAULT_ASSET_EXTENSION}. The
 * result always passes {@link sanitizeAssetExtension} (an input that would
 * not is silently replaced with the default instead of ever propagating an
 * unsafe value into a filename).
 */
export function resolveAssetExtension(
  contentType: string | undefined,
  sourceUrl: string | undefined,
): string {
  const fromContentType =
    contentType !== undefined ? CONTENT_TYPE_EXTENSIONS[contentType.toLowerCase()] : undefined;
  const fromUrl = sourceUrl !== undefined ? extensionFromUrl(sourceUrl) : undefined;
  const candidate = fromContentType ?? fromUrl ?? DEFAULT_ASSET_EXTENSION;

  const validation = sanitizeAssetExtension(candidate);
  return validation.valid ? validation.extension : DEFAULT_ASSET_EXTENSION;
}

/**
 * Resolves the absolute path an asset's bytes are stored at, given its
 * content `hash` and an already-{@link sanitizeAssetExtension}-validated
 * `extension`.
 *
 * As defense in depth beyond `hashAssetBytes` producing only hex characters
 * and `sanitizeAssetExtension`'s own allow-list, this also re-verifies (via
 * `resolve`) that the resulting path is still directly inside the assets
 * directory before returning it, throwing rather than ever handing back a
 * path that escaped it, mirroring `scene-store.ts`'s `resolveSceneFilePath`
 * exactly.
 */
function resolveAssetFilePath(workspaceRoot: string, hash: ContentHash, extension: string): string {
  const assetsDirectory = resolve(workspaceRoot, ASSETS_SUBDIRECTORY);
  const filePath = resolve(assetsDirectory, `${hash}.${extension}`);

  if (filePath !== join(assetsDirectory, `${hash}.${extension}`)) {
    throw new Error(
      `Refusing to resolve asset hash "${hash}" to a path outside the assets directory.`,
    );
  }

  return filePath;
}

/** Resolves the absolute path an asset's metadata sidecar is stored at, given its content `hash`. Mirrors {@link resolveAssetFilePath}'s own defense-in-depth check. */
function resolveAssetMetaFilePath(workspaceRoot: string, hash: ContentHash): string {
  const assetsDirectory = resolve(workspaceRoot, ASSETS_SUBDIRECTORY);
  const filePath = resolve(assetsDirectory, `${hash}${ASSET_META_SUFFIX}`);

  if (filePath !== join(assetsDirectory, `${hash}${ASSET_META_SUFFIX}`)) {
    throw new Error(
      `Refusing to resolve asset hash "${hash}" to a metadata path outside the assets directory.`,
    );
  }

  return filePath;
}

/** Persisted metadata for one stored asset, as a JSON sidecar alongside its bytes. */
export interface AssetMetadata {
  /** This asset's content hash, i.e. its own filename (minus extension). Redundant with the sidecar's own filename, kept explicit so a caller reading one `AssetMetadata` value never needs to also parse a filename. */
  hash: ContentHash;
  /** File extension (no leading dot) the asset's bytes are stored under. */
  extension: string;
  /** Total byte length of the stored asset. */
  sizeBytes: number;
  /** Content type supplied at upload time (either given directly, or the URL response's own `Content-Type` header), if known. */
  contentType?: string;
  /** Source URL the asset was fetched from, if uploaded by URL rather than by raw bytes. */
  sourceUrl?: string;
  /** ISO-8601 timestamp of when this asset was first uploaded. */
  uploadedAt: string;
}

/** One stored asset's full metadata plus its resolved asset ref, as returned by {@link listStoredAssets}. */
export interface StoredAssetSummary extends AssetMetadata {
  /** This asset's `cadra-asset://<hash>` ref, ready to place into a scene node's `assetRef` field. */
  assetRef: string;
}

/**
 * Persists `bytes` under `hash`'s content-addressed path (creating the
 * `assets` subdirectory if needed) alongside a metadata sidecar, unless an
 * asset with this exact hash is already stored: re-uploading identical bytes
 * is a deliberate no-op (beyond re-touching the metadata's `uploadedAt`
 * newer of the two, everything else about the existing file is left
 * untouched), which is what makes this module's dedup guarantee hold without
 * needing a separate "does this exist" check at every call site.
 *
 * `extension` must already have passed {@link sanitizeAssetExtension}; this
 * function does not re-validate it beyond the defense-in-depth check in
 * `resolveAssetFilePath`/`resolveAssetMetaFilePath`.
 */
export async function writeAssetFile(
  workspaceRoot: string,
  hash: ContentHash,
  extension: string,
  bytes: Uint8Array,
  metadata: Omit<AssetMetadata, "hash" | "extension" | "sizeBytes" | "uploadedAt">,
): Promise<AssetMetadata> {
  const assetsDirectory = resolve(workspaceRoot, ASSETS_SUBDIRECTORY);
  await mkdir(assetsDirectory, { recursive: true });

  const existing = await readAssetMetadata(workspaceRoot, hash);
  if (existing !== undefined) {
    return existing;
  }

  const filePath = resolveAssetFilePath(workspaceRoot, hash, extension);
  const metaFilePath = resolveAssetMetaFilePath(workspaceRoot, hash);

  await writeFile(filePath, bytes);

  const fullMetadata: AssetMetadata = {
    hash,
    extension,
    sizeBytes: bytes.byteLength,
    uploadedAt: new Date().toISOString(),
    ...metadata,
  };
  await writeFile(metaFilePath, JSON.stringify(fullMetadata, null, 2), "utf8");

  return fullMetadata;
}

/**
 * Fetches `sourceUrl` with Node's built-in `fetch` and returns its bytes
 * plus, if present, its response's own `Content-Type` header (stripped of
 * any `; charset=...` parameter, since {@link resolveAssetExtension}'s
 * lookup table is keyed on the bare MIME type).
 *
 * Extracted as its own function so both `upload_asset`
 * (`./asset-tools.ts`) and any other caller ingesting a URL into this same
 * durable, content-addressed store (e.g. `./generation-asset-binding.ts`,
 * binding a finished generation job's `outputUrl` onto a scene node) fetch
 * bytes exactly the same way, rather than one of them re-implementing this
 * URL-to-bytes step independently.
 */
async function fetchBytesFromUrl(
  sourceUrl: string,
): Promise<{ bytes: Uint8Array; contentType: string | undefined }> {
  const response = await fetch(sourceUrl);
  if (!response.ok) {
    throw new Error(`Fetching "${sourceUrl}" failed with status ${response.status}.`);
  }
  const arrayBuffer = await response.arrayBuffer();
  const rawContentType = response.headers.get("content-type") ?? undefined;
  const contentType = rawContentType?.split(";")[0]?.trim();
  return { bytes: new Uint8Array(arrayBuffer), contentType };
}

/**
 * Ingests `sourceUrl` into this workspace's durable, content-addressed asset
 * store in one step: fetches its bytes ({@link fetchBytesFromUrl}), hashes
 * them (`@cadra/core`'s `hashAssetBytes`, this codebase's sole standardized
 * content-hashing primitive), derives a safe extension
 * ({@link resolveAssetExtension}), and persists them ({@link writeAssetFile}),
 * deduplicating automatically exactly like every other write through this
 * module.
 *
 * This is the one real "ingest a URL into the asset store" code path in this
 * package: `upload_asset`'s "by URL" tool input (`./asset-tools.ts`) calls
 * this directly rather than duplicating the fetch/hash/extension/write
 * sequence, and `./generation-asset-binding.ts` (Phase 36) calls it too, to
 * turn a finished generation job's vendor-hosted `outputUrl` into a real,
 * durable `cadra-asset://<hash>` ref the same way a human-uploaded URL
 * becomes one.
 *
 * `contentType`, if given, overrides whatever the URL response's own
 * `Content-Type` header reports (matching `upload_asset`'s own precedence);
 * omit it to trust the response header (falling back to sniffing
 * `sourceUrl`'s own extension, then a generic default, if the response has
 * no `Content-Type` either).
 */
export async function ingestAssetFromUrl(
  workspaceRoot: string,
  sourceUrl: string,
  contentType?: string,
): Promise<StoredAssetSummary> {
  const fetched = await fetchBytesFromUrl(sourceUrl);
  const resolvedContentType = contentType ?? fetched.contentType;
  const hash = hashAssetBytes(fetched.bytes);
  const extension = resolveAssetExtension(resolvedContentType, sourceUrl);

  const metadata = await writeAssetFile(workspaceRoot, hash, extension, fetched.bytes, {
    ...(resolvedContentType !== undefined ? { contentType: resolvedContentType } : {}),
    sourceUrl,
  });

  return { ...metadata, assetRef: buildAssetRef(metadata.hash) };
}

/** Reads back `hash`'s metadata sidecar, or `undefined` if no asset with this hash has been stored yet. Does not read the asset's own bytes; see {@link readAssetBytes} for that. */
export async function readAssetMetadata(
  workspaceRoot: string,
  hash: ContentHash,
): Promise<AssetMetadata | undefined> {
  const assetsDirectory = resolve(workspaceRoot, ASSETS_SUBDIRECTORY);

  let entries;
  try {
    entries = await readdir(assetsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }

  const metaFileName = `${hash}${ASSET_META_SUFFIX}`;
  const found = entries.find((entry) => entry.isFile() && entry.name === metaFileName);
  if (found === undefined) {
    return undefined;
  }

  const metaFilePath = resolveAssetMetaFilePath(workspaceRoot, hash);
  const contents = await readFile(metaFilePath, "utf8");
  return JSON.parse(contents) as AssetMetadata;
}

/**
 * Reads back `hash`'s stored bytes, or `undefined` if no asset with this
 * hash has been stored yet. Looks up the extension from the metadata
 * sidecar first (an asset's own extension is not otherwise derivable from
 * its hash alone).
 */
export async function readAssetBytes(
  workspaceRoot: string,
  hash: ContentHash,
): Promise<Uint8Array | undefined> {
  const metadata = await readAssetMetadata(workspaceRoot, hash);
  if (metadata === undefined) {
    return undefined;
  }

  const filePath = resolveAssetFilePath(workspaceRoot, hash, metadata.extension);
  try {
    return await readFile(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Lists every stored asset under `workspaceRoot`'s `assets` directory as a
 * {@link StoredAssetSummary}, or an empty array if the directory does not
 * exist yet (a workspace with no assets uploaded is not an error). Entries
 * whose metadata sidecar cannot be parsed are silently skipped, mirroring
 * `scene-store.ts`'s `listSceneFiles` tolerance for stray/hand-edited files.
 */
export async function listStoredAssets(workspaceRoot: string): Promise<StoredAssetSummary[]> {
  const assetsDirectory = resolve(workspaceRoot, ASSETS_SUBDIRECTORY);

  let entries;
  try {
    entries = await readdir(assetsDirectory, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return [];
    }
    throw error;
  }

  const results: StoredAssetSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(ASSET_META_SUFFIX)) {
      continue;
    }
    const hash = entry.name.slice(0, -ASSET_META_SUFFIX.length);
    try {
      const metaFilePath = resolveAssetMetaFilePath(workspaceRoot, hash);
      const contents = await readFile(metaFilePath, "utf8");
      const metadata = JSON.parse(contents) as AssetMetadata;
      results.push({ ...metadata, assetRef: buildAssetRef(metadata.hash) });
    } catch {
      continue;
    }
  }
  return results;
}

/** True if `error` is a Node.js `ENOENT` (file/directory not found) error. */
function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}
