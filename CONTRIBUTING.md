# Contributing to mobile-network-mcp

Thanks for your interest! This is a token-efficient network MCP server for
mobile apps. Contributions — bug fixes, new capture sources, platform
interceptors, docs — are welcome.

## Development setup

```bash
git clone <your-fork>
cd mobile-network-mcp
npm install
npm run build      # tsc → dist/   (must pass clean before a PR)
npm test           # node --test dist/test/*.js
```

Run the CLI locally with `node dist/bin/cli.js --help`.

## Project layout

- `src/` — the MCP **server** (TypeScript, compiled to `dist/`, runs in Node).
  - `src/capture/` — the three capture sources (ingest HTTP, CDP, Proxyman) +
    the shared `CapturedFlow` types.
  - `src/store/` — the in-memory ring-buffer store.
  - `src/tools/` — the four MCP tools (schema-first querying).
- `interceptor.js` + `interceptors/` — **client-side drop-ins** that run in a
  different runtime (the app / Proxyman), *not* server code. Authored as plain
  JS/Swift/Kotlin/Dart; never compiled by `tsc`.
- `README.md` — usage. `PLAN.md` — capture-pipeline findings & roadmap.
- `DAEMON.md` (on the `daemon-approach` branch) — the shared-daemon design.

## Branches

- `main` — shippable.
- `feature/platform-interceptors` — native iOS/Android/Flutter interceptors
  pending re-integration.
- `daemon-approach` — the shared-daemon (multi-session) rework.

## Adding a capture source or interceptor

Everything funnels into one `RequestStore` via the `CapturedFlow` contract
(`src/capture/types.ts`). A new **capture source** writes `CapturedFlow`s into
the store; a new **interceptor** POSTs the ingest JSON shape to
`/flows` or `/flows/batch` (see `ingest-server.ts` → `toFlow`). Send `body` as
a **string** (objects are re-serialized server-side, but send strings to be safe).

## Pull requests

1. `npm run build` must pass with **zero** TypeScript errors.
2. Match the surrounding code style; keep changes focused.
3. Describe the change and link the relevant `PLAN.md` item if applicable.
4. By contributing, you agree your contributions are licensed under the MIT
   License (see `LICENSE`).
