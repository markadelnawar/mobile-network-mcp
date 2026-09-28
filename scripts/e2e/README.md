# Manual end-to-end checks for the CDP door

Not run by `npm test` — they need Metro on `:8081` and a React Native app (RN 0.83+)
in the iOS simulator. Run from the repo root after `npm run build`:

| Script | What it proves |
|--------|----------------|
| `cdp-probe.mjs` | Raw CDP: Metro accepts the socket (needs `Origin`), `Network.enable` works, events + `getResponseBody` arrive. |
| `cdp-body-probe.mjs` | Compares fetched body bytes with `encodedDataLength` — shows the RN 0.87 iOS truncation (see PLAN.md). |
| `mcp-e2e.mjs` | Full server over MCP stdio: capture → tools → `Page.reload` → capture continues. |
| `mcp-reconnect.mjs` | Kill + relaunch the app while the server runs → reconnect + `Network.enable` re-sent. |
| `mcp-final.mjs` | Server started with **no** app running → connects when the app appears → truncated body repaired + flagged. |

Generate traffic in the app while a script's capture window is open (tap into a
search, pull-to-refresh, etc.).
