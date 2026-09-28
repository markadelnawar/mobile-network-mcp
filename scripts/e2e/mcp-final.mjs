// Manual e2e helper (not part of npm test). Run from the repo root after `npm run build`,
// with Metro on :8081 and the RN app in the simulator: node scripts/e2e/mcp-final.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const CLI = new URL("../../dist/bin/cli.js", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let serverLog = "";
const transport = new StdioClientTransport({ command: "node", args: [CLI, "--source", "cdp", "--port", "8081", "--ingest-port", "7899", "-i", "tracking|analytics|adtracker|etracker|recapi/ingest|nooncdn\\.com|mp-ads-api"], stderr: "pipe" });
transport.stderr?.on("data", (d) => { const t = d.toString(); serverLog += t; for (const l of t.trimEnd().split("\n")) log("  [server]", l); });
const client = new Client({ name: "e2e-final", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;
log("PHASE 1: server started with no app running; waiting for it to connect once the app launches...");
const t0 = Date.now(); while (Date.now() - t0 < 120000 && !/Connected to Metro/.test(serverLog)) await sleep(1000);
log(/Connected to Metro/.test(serverLog) ? `connected after ${Math.round((Date.now() - t0) / 1000)}s` : "NEVER connected");
log("PHASE 2: waiting for a truncated (non-ASCII, large) response...");
const t1 = Date.now(); let listing = "";
while (Date.now() - t1 < 120000) { listing = await call("list_requests", { limit: 8 }); if (/cut short by the capture source/.test(listing)) break; await sleep(4000); }
log("list_requests ->\n" + listing);
const row = listing.split("\n").filter((l) => /^\s*\d+\s*\|/.test(l)).sort((a, b) => sizeOf(b) - sizeOf(a))[0];
function sizeOf(l) { const m = l.match(/\|\s*([\d.]+)(B|KB|MB)\s*\|/); return m ? parseFloat(m[1]) * ({ B: 1, KB: 1024, MB: 1048576 })[m[2]] : 0; }
if (row) {
  const id = parseInt(row.trim().split("|")[0], 10);
  const schema = await call("get_response_schema", { request_id: id, max_depth: 2 });
  log(`get_response_schema(${id}) ->\n` + schema.split("\n").slice(0, 22).join("\n") + (schema.split("\n").length > 22 ? "\n  ..." : ""));
  const key = (schema.split("\n").map((l) => l.match(/^\s{0,2}"?([A-Za-z_][\w-]*)"?\s*[:=]/)).find(Boolean) || [])[1];
  if (key) log(`query_response(${id}, "${key}") ->\n` + (await call("query_response", { request_id: id, path: key, max_items: 2 })).slice(0, 700));
  log(`get_response_raw(${id}, 160) ->\n` + (await call("get_response_raw", { request_id: id, truncate_at: 160 })).split("\n").slice(0, 6).join("\n"));
}
log("final:", (await call("server_status")).replace(/\n/g, " | "));
log(/Connected to Metro/.test(serverLog) && row ? "RESULT: PASS" : "RESULT: FAIL");
await client.close(); process.exit(0);
