// Manual e2e helper (not part of npm test). Run from the repo root after `npm run build`,
// with Metro on :8081 and the RN app in the simulator: node scripts/e2e/mcp-e2e.mjs
// E2E: drive the patched server (--source cdp) over MCP stdio, like Claude Code would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const CLI = new URL("../../dist/bin/cli.js", import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let serverLog = "";

const transport = new StdioClientTransport({
  command: "node",
  args: [CLI, "--source", "cdp", "--port", "8081", "--ingest-port", "7899", "-i", "tracking|analytics|adtracker|etracker|recapi/ingest|nooncdn\\.com"],
  stderr: "pipe",
});
transport.stderr?.on("data", (d) => { const t = d.toString(); serverLog += t; for (const l of t.trimEnd().split("\n")) log("  [server]", l); });
const client = new Client({ name: "e2e", version: "0.0.0" });
await client.connect(transport);
const call = async (name, args = {}) => (await client.callTool({ name, arguments: args })).content[0].text;

log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
await sleep(3000);
log("server_status ->\n" + await call("server_status"));

const countOf = (listing) => { const m = listing.match(/\[(?:Showing \d+-\d+ of )?(\d+) (?:matching )?request/); return m ? parseInt(m[1], 10) : 0; };
async function waitForFlows(minCount, timeoutMs) {
  const t0 = Date.now(); let listing = "";
  while (Date.now() - t0 < timeoutMs) { listing = await call("list_requests", { limit: 10 }); if (countOf(listing) >= minCount) return listing; await sleep(4000); }
  return listing;
}

// Phase A — capture
log("PHASE A: waiting for app traffic...");
let listing = await waitForFlows(1, 90000);
log("list_requests ->\n" + listing);
const row = listing.split("\n").find((l) => /api-app\.noon\.com.*search/.test(l)) ?? listing.split("\n").find((l) => /api-app\.noon\.com/.test(l));
if (row) {
  const id = parseInt(row.trim().split("|")[0], 10);
  const schema = await call("get_response_schema", { request_id: id, max_depth: 3 });
  log(`get_response_schema(${id}) -> ${schema.length} chars; first lines:\n` + schema.split("\n").slice(0, 25).join("\n"));
  if (/search/.test(row)) log(`query_response(${id}) ->\n` + await call("query_response", { request_id: id, paths: ["navPills[*].code", "nbHits", "hits[0].name"] }));
} else log("no api-app.noon.com flow captured in phase A");
const before = countOf(await call("list_requests", { limit: 1 }));

// Phase B — reload the app via CDP and confirm the server re-enables capture
log("PHASE B: sending Page.reload to the app via CDP...");
const targets = await (await fetch("http://localhost:8081/json")).json();
const t = targets.find((x) => (x.description || "").includes("React Native")) ?? targets[0];
await new Promise((res) => { const ws = new WebSocket(t.webSocketDebuggerUrl, { origin: "http://localhost:8081" }); ws.on("open", () => { ws.send(JSON.stringify({ id: 1, method: "Page.reload", params: {} })); setTimeout(() => { ws.close(); res(); }, 500); }); ws.on("error", (e) => { log("reload ws error", e.message); res(); }); });
const tB = Date.now(); let reconnected = false;
while (Date.now() - tB < 45000) { if (/Reconnected to Metro/.test(serverLog)) { reconnected = true; break; } await sleep(1000); }
log(reconnected ? `reconnect observed after ${Math.round((Date.now() - tB) / 1000)}s` : "NO reconnect log within 45s");

// Phase C — new traffic after reload must land in the same store
log(`PHASE C: waiting for new flows (had ${before})...`);
listing = await waitForFlows(before + 1, 90000);
log("list_requests ->\n" + listing.split("\n").slice(0, 8).join("\n"));
log("final server_status ->\n" + await call("server_status"));
log(countOf(listing) > before ? "RESULT: PASS — capture survived the reload" : "RESULT: FAIL — no new flows after reload");
await client.close(); process.exit(0);
