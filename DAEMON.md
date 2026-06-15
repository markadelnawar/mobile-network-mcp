# Shared-Daemon Architecture (Option C) — design

Decouple the store + ingest server + capture source from the per-session MCP
process so multiple Claude sessions share ONE capture store, instead of each
session having its own blind store. Long-term fix for multi-session visibility.
v1 (on `main`) keeps the simpler per-session model with port auto-bump +
port-file/`server_status` discovery; this branch is the future replacement.

## Two roles
- **Daemon** (one per machine): owns RequestStore + ingest HTTP server (FIXED
  port) + the capture source (Proxyman poll / CDP). Pure HTTP service, no
  stdio/MCP. Adds read endpoints so front-ends can query.
- **MCP front-end** (one per Claude session, stdio): holds NO store/capture; its
  tools are thin HTTP proxies to the daemon.

## Discovery / spawn — `ensureDaemon()` (front-end startup + on any failed call)
    if GET 127.0.0.1:<port>/health succeeds -> daemon up, use it
    else spawn daemon DETACHED, poll /health until ready (timeout)
Daemon on boot binds the fixed port; if EADDRINUSE (lost a spawn race) it
exit(0)s immediately — do NOT bump (exactly one daemon is the whole point).

## Tool read path (logic stays in the front-end)
    list_requests       -> GET /flows?filters   -> format table
    get_response_schema -> GET /flows/:id        -> inferSchema(body) + render
    query_response      -> GET /flows/:id        -> resolvePath
    get_response_raw    -> GET /flows/:id        -> truncate
    server_status       -> GET /health
Daemon serves raw flows; existing src/tools/* run per-session. Token-efficiency
to the AI is unchanged (only schema/query results reach the AI; raw transfer is
localhost-only).

## Freshness (front-end-initiated)
Each tool does `POST /refresh` before `GET /flows`. Daemon no-ops it unless the
source is Proxyman (then it polls). Mirrors today's onBeforeToolCall, over HTTP.

## Lifecycle — exit when no listeners (refcount via held connections)
- Each front-end opens a long-lived `GET /attach` the daemon never closes, kept
  open for the front-end's whole life.
- Daemon counts open /attach sockets. A socket closing (graceful exit OR crash —
  the OS tears it down either way) -> count--.
- When count hits 0, start a ~10s grace timer; if still 0, daemon shuts down
  (stop capture + ingest, exit). Grace absorbs session restarts/handoffs.
- Startup guard: don't arm idle-exit until the first attach is seen (or ~15s
  startup grace) so a fresh daemon doesn't instantly suicide.
Reproduces today's "capture lives iff >=1 session", but shared.

## Decisions (settled)
- Tool logic: front-end.
- Shutdown: exit when the last /attach closes (+ grace).
- Capture config: first front-end to spawn the daemon wins; later sessions can't
  reconfigure the running source.
- Freshness: front-end POST /refresh; daemon no-ops unless Proxyman.
- Failover: a front-end whose daemon call gets ECONNREFUSED re-runs
  ensureDaemon (respawn) + retries once. Data in a dead daemon's store is lost
  (in-memory, same as today).

## Why this beats v1, and matches today's lifecycle
- Multiple sessions share ONE store (today each is blind to the others).
- Grace period rescues data across quick session restarts (today a restart loses
  everything).
- "No session -> no capture" is unchanged from today (capture was always
  session-scoped); interceptor POSTs during a no-session gap drop, same as today.

## Notes
- Bind 127.0.0.1 only (same exposure as today's ingest server).
- The fixed daemon port is the single well-known rendezvous -> no port-file
  needed here (v1's port-file exists only for the bump approach).
