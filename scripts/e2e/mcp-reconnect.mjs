// Manual e2e helper (not part of npm test). Run from the repo root after `npm run build`,
// with Metro on :8081 and the RN app in the simulator: node scripts/e2e/mcp-reconnect.mjs
// E2E #2: app kill + relaunch must trigger the server's reconnect + Network re-enable; then demo schema/query tools.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
const IGNORE = process.env.MNM_E2E_IGNORE ?? "tracking|analytics|adtracker|etracker|recapi/ingest|nooncdn\\\\.com|mp-ads-api"; // noise for the test app; override for yours
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const CLI = new URL("../../dist/bin/cli.js", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let serverLog = "";
const transport = new StdioClientTransport({ command: "node", args: [CLI, "--source", "cdp", "--port", "8081", "--ingest-port", "7899", "-i", IGNORE], stderr: "pipe" });
transport.stderr?.on("data", (d) => { const t = d.toString(); serverLog += t; for (const l of t.trimEnd().split("\n")) log("  [server]", l); });
const client = new Client({ name: "e2e-reconnect", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
await sleep(2500);
log("status ->", (await call("server_status")).replace(/\n/g, " | "));
log("PHASE 1: waiting for app kill + relaunch (reconnect log)...");
const t0 = Date.now(); let ok = false;
while (Date.now() - t0 < 120000) { if (/Reconnected to Metro/.test(serverLog)) { ok = true; break; } await sleep(1000); }
log(ok ? `reconnect + re-enable observed after ${Math.round((Date.now() - t0) / 1000)}s` : "NO reconnect within 120s");
log("PHASE 2: waiting for post-relaunch flows...");
const t1 = Date.now(); let listing = "";
while (Date.now() - t1 < 90000) { listing = await call("list_requests", { limit: 6 }); if (/\[(\d+) request/.test(listing) && !/\[0 request/.test(listing)) break; await sleep(4000); }
log("list_requests ->\n" + listing);
const row = listing.split("\n").find((l) => /^\s*\d+\s*\|\s*(GET|POST)/.test(l) && !/\|\s+\d+B\s+\|/.test(l));
if (row) {
  const id = parseInt(row.trim().split("|")[0], 10);
  const schema = await call("get_response_schema", { request_id: id, max_depth: 2 });
  log(`get_response_schema(${id}) -> ${schema.length} chars for a ${row.trim().split("|")[4].trim()} body; first 14 lines:\n` + schema.split("\n").slice(0, 14).join("\n"));
  const firstKey = (schema.split("\n").map((l) => l.match(/^\s{0,2}"?([A-Za-z_][\w-]*)"?\s*:/)).find(Boolean) || [])[1];
  if (firstKey) log(`query_response(${id}, "${firstKey}") ->\n` + (await call("query_response", { request_id: id, path: firstKey })).slice(0, 600));
}
log("final:", (await call("server_status")).replace(/\n/g, " | "));
log(ok ? "RESULT: PASS" : "RESULT: FAIL (no reconnect)");
await client.close(); process.exit(0);
