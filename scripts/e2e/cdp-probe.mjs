// Manual e2e helper (not part of npm test). Run from the repo root after `npm run build`,
// with Metro on :8081 and the RN app in the simulator: node scripts/e2e/cdp-probe.mjs
import WebSocket from "ws";
// Raw CDP probe: connect to Metro inspector, Network.enable, report events for ~70s, then try getResponseBody.
const port = 8081;
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
console.log('targets:', targets.map(t => `${t.title} | ${t.description} | type=${t.type}`).join(' ;; '));
const t = targets.find(x => (x.description || '').includes('React Native')) ?? targets[0];
const ws = new WebSocket(t.webSocketDebuggerUrl, { origin: `http://localhost:${port}` }); ws.on("unexpected-response", (rq, rs) => console.log("handshake rejected:", rs.statusCode, JSON.stringify(rs.headers))); ws.on("error", e => console.log("ws error:", e.message));
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params }));
  setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 10000);
});
const counts = {}; const finished = []; const reqs = new Map(); let shown = 0;
ws.on("message", (data) => { const ev = { data: data.toString() };
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (!m.method) return;
  counts[m.method] = (counts[m.method] || 0) + 1;
  if (m.method === 'Network.requestWillBeSent') {
    reqs.set(m.params.requestId, m.params);
    if (shown++ < 3) console.log('REQ', m.params.requestId, m.params.request.method, (m.params.request.url || '').slice(0, 110), '| wallTime:', 'wallTime' in m.params, '| hdrs:', Object.keys(m.params.request.headers || {}).length, '| postData:', 'postData' in m.params.request);
  } else if (m.method === 'Network.responseReceived' && finished.length < 3) {
    const r = m.params.response; console.log('RESP', m.params.requestId, r.status, r.mimeType, '| hdrs:', Object.keys(r.headers || {}).length, '| content-length:', r.headers?.['content-length'] ?? r.headers?.['Content-Length']);
  } else if (m.method === 'Network.loadingFinished') {
    finished.push(m.params); if (finished.length <= 3) console.log('FIN', m.params.requestId, '| encodedDataLength:', m.params.encodedDataLength);
  }
});
await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); ws.on("close", (c, r) => rej(new Error("closed " + c + " " + r))); });
console.log('ws open ->', t.webSocketDebuggerUrl);
try { console.log('Network.enable ->', JSON.stringify(await send('Network.enable', { maxTotalBufferSize: 10_000_000 }))); }
catch (e) { console.log('Network.enable FAILED:', e.message); }
const total = 70000, end = Date.now() + total;
while (Date.now() < end) { await new Promise(r => setTimeout(r, 5000)); console.log(`t+${Math.round((total - (end - Date.now())) / 1000)}s`, JSON.stringify(counts)); if (finished.length >= 6) break; }
for (const f of finished.slice(0, 6)) {
  const rq = reqs.get(f.requestId);
  try { const b = await send('Network.getResponseBody', { requestId: f.requestId }); console.log('BODY', f.requestId, (rq?.request?.url || '').slice(0, 90), '| base64:', b.base64Encoded, '| len:', b.body?.length, '| head:', (b.body || '').slice(0, 70).replace(/\s+/g, ' ')); }
  catch (e) { console.log('BODY FAIL', f.requestId, (rq?.request?.url || '').slice(0, 90), e.message); }
}
console.log('final counts', JSON.stringify(counts));
try { await send('Network.disable'); } catch {}
ws.close(); process.exit(0);
