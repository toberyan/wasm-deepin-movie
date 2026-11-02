# ADR-0006: SourceReader and HTTP Range policy

- Status: accepted
- Date: 2026-11-02

## Decision

- `SourceReader` exposes `getSize`, `readAt`, `cancel`, `close` and
  `getCapabilities`.
- File reads use `Blob.slice()`; no whole-file MEMFS copy.
- HTTP random access requires an actual `206` response with a valid
  `Content-Range` and a matching total size. `Accept-Ranges` is not trusted.
- `ETag` / `Last-Modified` are captured at initialization and checked on every
  range response; a change returns `SOURCE_CHANGED`.
- A server that answers the Range probe with `200` is treated as a bounded,
  forward-only source. It is not advertised as seekable; discarding the window
  makes backward reads return `SOURCE_NOT_SEEKABLE`.
- Range reads use a small block cache (default 1 MiB blocks, bounded LRU) so
  demuxer readahead does not issue one request per tiny read.
- Sparse source is a virtual reader for 6 GiB offset/boundary tests; it never
  allocates the virtual file size.

## Consequences

- The demuxer gets 64-bit-safe offsets (`Number.isSafeInteger`) and a clear
  capability report.
- Unsupported Range sources degrade explicitly instead of silently downloading
  or buffering an entire movie.
