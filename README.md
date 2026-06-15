# mobile-network-mcp

Token-efficient network MCP server for mobile apps — gives AI coding agents
visibility into your app's API traffic via **schema-first querying** instead of
dumping whole responses into the context window.

## Why

Pasting a 300 KB JSON response into a chat burns the context window. This server
captures your app's network flows and exposes them through tools that let an AI:
learn a response's **shape** for a few hundred tokens, **query** just the fields
it needs, and fall back to the **raw** body only as a last resort.

## How it works

```
[app traffic] ──(one of 3 capture methods)──▶ RequestStore ──(4 MCP tools)──▶ AI agent
                                              (bounded ring buffer)
```

All capture methods funnel into one in-memory store; the four tools read from it.

## Install & build

```bash
npm install
npm run build
```

## Register as an MCP server

```jsonc
{
  "mcpServers": {
    "rn-network": {
      "command": "node",
      "args": [
        "/abs/path/to/dist/bin/cli.js",
        "-i", "tracking|analytics|adtracker"   // ignore noisy URLs (regex)
      ]
    }
  }
}
```

## Capture methods — pick ONE per traffic stream

The ingest HTTP server (default port **7890**) always runs. Choose how flows
reach it. ⚠️ Don't run two methods that see the same traffic (e.g. Proxyman
scripting **and** `--source proxyman`) — you'll get duplicates.

### 1. Proxyman scripting — recommended (captures everything, incl. native)

Generate the script with the ingest port already injected, then paste it into
Proxyman:

```bash
node dist/bin/cli.js --print-proxyman-script                 # uses port 7890
node dist/bin/cli.js --print-proxyman-script --ingest-port 7895
```

Then in Proxyman → **Tools → Scripting**: enable the tool, new script (Cmd+N),
set URL to `*`, check both **Request** and **Response**, paste, and save.

### 2. Proxyman CLI capture — no scripting, polls `proxyman-cli`

```bash
node dist/bin/cli.js --source proxyman -d api.example.com
```

Polls Proxyman's export and writes to the store directly (port-independent).

### 3. In-app interceptor — React Native, no proxy needed

Add to your app's dev entry (e.g. `index.js`), as early as possible:

```js
if (__DEV__) require('mobile-network-mcp/interceptor');
```

For a real device, point it at your machine's LAN IP and gate it on a dedicated
build flag (not just `__DEV__`). iOS/Android/Flutter snippets live on the
`feature/platform-interceptors` branch.

> **CDP / React Native Metro** capture (`--source cdp`) requires **RN 0.83+**
> (Hermes' `Network` domain). On older RN, use one of the methods above.

## MCP tools

| Tool | Purpose |
|------|---------|
| `list_requests` | Compact table of captured flows (id, method, status, URL, size, time). Filter by URL/method/status. |
| `get_response_schema` | The **shape** of a JSON response (keys + types, no values). Start here. |
| `query_response` | Extract specific values by path — `data.users[*].id`, multiple paths at once. |
| `get_response_raw` | Full raw body (truncated). Escape hatch; prefer schema + query. |

Typical flow: `list_requests` → `get_response_schema <id>` → `query_response <id> <path>`.

## CLI options

Run `node dist/bin/cli.js --help` for the full list (capture source, ports,
domain/ignore filters, poll interval, `--print-proxyman-script`).

## Known issues & roadmap

See [`PLAN.md`](./PLAN.md) for capture-pipeline findings and planned fixes.
