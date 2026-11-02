# Companion / MCP Closed-Loop Evidence

Date: 2026-11-02.

## Verified path

`MCP stdio client → Companion → loopback WebSocket → browser page → PlayerController → BrowserMediaEngine`

The Companion serves the built web app, `/api/bootstrap`, a read-only media
broker and the control WebSocket from the same loopback origin.

## Executed checks

- MCP `tools/list` returns 46 tools generated from the contracts registry.
- `sessions_list` → one connected browser session.
- `sessions_attach` → selected session.
- `sources_list` → broker sources with relative sourceIds and Range URLs.
- `media_open` with `sourceId` → HTTP Range media; state read-back shows the
  correct name, duration, WebCodecs paths and ETag.
- `settings_apply` → brightness/volume effective values match requested.
- `playback_seek` → requested 1,000,000 µs, position 1,000,000 µs.
- `state_get` → paused phase, requested position and settings.
- `capture_create` → accepted jobId; `jobs_get` → applied PNG job with
  dimensions.
- `diagnostics_get` → WebCodecs paths, no warnings.
- Bad bootstrap Origin → 403.
- Bad WebSocket token → socket does not open.
- Broker traversal (`../package.json`) → 404.
- Range request to an authorized source → 206 with `Content-Range`.

## Gaps

- No remote/Streamable HTTP transport; loopback stdio only.
- No signed standalone distribution or multi-user authorization.
- Full security review and long-run reconnect testing remain release gates.
