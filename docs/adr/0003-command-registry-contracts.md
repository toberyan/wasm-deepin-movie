# ADR-0003: Command registry and requested/effective settings

- Status: accepted
- Date: 2026-11-02

## Decision

- Every public operation is an `ActionDefinition` with a stable dotted ID, Zod
  input/output schema, media requirement, capability requirements, cancellation
  and long-running metadata, events, UI metadata and an MCP tool name.
- `PlayerController.invoke()` is the only mutation path. The UI calls it; the
  future SDK/MCP layer will call the same method.
- Requests carry `requestId`, `sessionId` and optional `expectedRevision`.
  `requestId` is deduplicated in a bounded time window; stale revisions return
  `REVISION_CONFLICT`.
- Settings are layered: default → global → preset → media → session. Every
  setting returns `requested`, `effective`, `status`, `layer` and an optional
  reason. Unsupported values are not silently reported as applied.
- Events carry an independent sequence, so per-frame telemetry does not
  conflict with configuration revisions.

## Consequences

- UI, SDK and MCP share schemas and semantics.
- Tests can assert exact error codes and effective-value behavior.
- Adding a setting requires a descriptor, schema snapshot and a handler; the
  published schema snapshot is checked in CI.
