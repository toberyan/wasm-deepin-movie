/**
 * Stable identity for a local file.
 *
 * Local files cannot be persisted (a `File` points at a picked handle and its
 * bytes are not serializable state), so the playlist stores this identity and
 * matches it again when the user re-selects the file or its folder. The
 * relative path is preferred over the bare name so two files called
 * `episode.mkv` in different folders stay distinct; size and modification time
 * separate two files that share a path but were replaced.
 */
export interface FileIdentityParts {
  /** Relative path from a directory picker (`webkitRelativePath`). */
  path?: string;
  /** File name, used when no path is available. */
  name?: string;
  size?: number;
  lastModified?: number;
}

export function fileIdentity(parts: FileIdentityParts): string {
  const location = (parts.path && parts.path.trim()) || (parts.name ?? "").trim();
  const size = typeof parts.size === "number" && Number.isFinite(parts.size) ? parts.size : -1;
  const modified =
    typeof parts.lastModified === "number" && Number.isFinite(parts.lastModified)
      ? parts.lastModified
      : -1;
  return `${location}|${size}|${modified}`;
}

interface FileLike {
  name?: unknown;
  size?: unknown;
  lastModified?: unknown;
  webkitRelativePath?: unknown;
}

/**
 * Derive an identity from a picked `File`. Returns `undefined` when the object
 * carries no name, which keeps callers from persisting a meaningless identity.
 */
export function fileIdentityOf(
  file: unknown,
  fallbackName?: string
): string | undefined {
  if (!file || typeof file !== "object") return undefined;
  const record = file as FileLike;
  const name = typeof record.name === "string" ? record.name : fallbackName;
  if (!name) return undefined;
  return fileIdentity({
    name,
    path: typeof record.webkitRelativePath === "string" ? record.webkitRelativePath : undefined,
    size: typeof record.size === "number" ? record.size : undefined,
    lastModified: typeof record.lastModified === "number" ? record.lastModified : undefined
  });
}
