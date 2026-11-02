# ADR-0007: Companion control bridge security

- Status: accepted
- Date: 2026-11-02

## Context

The MCP Companion is a local process that lets an Agent control a browser
session. It must not become a general-purpose file server or a cross-site
control channel.

## Decision

- The Companion binds to `127.0.0.1`/`localhost`/`::1` only (`parseArgs`
  rejects other hosts).
- HTTP requests validate the `Host` header against the bound address. Browser
  requests with an `Origin` header must match the Companion origin too.
- `/api/bootstrap` returns the random per-process control token, the WebSocket
  URL, a fresh session ID and the broker base URL. It is same-origin only and
  never cacheable.
- WebSocket upgrades require a matching token (constant-time comparison) and a
  valid same-origin `Origin`. A page must send a `hello` with a session ID
  within five seconds; otherwise the socket is closed.
- MCP stdio stdout carries only protocol messages. Logs go to stderr.
- The media broker is read-only and disabled unless `--allow-root` is given.
  Source IDs are relative paths; `realpath` is computed before the root check,
  so `..`, absolute paths and symlink escapes are rejected. Only GET/HEAD with
  Range are served. Directory listing is limited to media extensions.
- The browser page is served by the Companion itself, so the page, control
  WebSocket and broker share one origin. No CORS wildcard is used.
- CSP disables `eval`, remote scripts, remote workers and arbitrary object
  content; `wasm-unsafe-eval`, same-origin workers, blob AudioWorklet/JASSUB
  workers and same-origin/loopback WebSocket connections are allowed.
- MCP tool schemas are emitted as draft-07 JSON Schema for compatibility with
  the official client validator. The contracts package remains draft-2020-12
  for its own snapshots.

## Verified controls

- Bad `Origin` on `/api/bootstrap` returns 403.
- Bad WebSocket token does not open.
- `../package.json` on the broker returns 404.
- Symlink escape and non-media files are rejected by unit tests.
- MCP tools return typed rejected results for invalid input or unavailable
  sessions.

## Not yet covered

- Remote relay/Streamable HTTP, multi-user authorization, persistent paired
  devices and a full security review before public distribution.
