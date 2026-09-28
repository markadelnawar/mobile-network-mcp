// Manual e2e helper (not part of npm test). Run from the repo root after `npm run build`,
// with Metro on :8081 and the RN app in the simulator: node scripts/e2e/cdp-body-probe.mjs
import WebSocket from "ws";
const port = 8081;
const targets = await (await fetch(`http://localhost:${port}/json`)).json();
console.log('targets:', targets.map(x => x.title + ' :: ' + x.description).join(' ;; ')); const t = targets.find(x => (x.description || '').includes('React Native')) ?? targets[0];
const ws = new WebSocket(t.webSocketDebuggerUrl, { origin: `http://localhost:${port}` });
let id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); setTimeout(() => { if (pending.has(i)) { pending.delete(i); rej(new Error('timeout ' + method)); } }, 15000); });
const reqs = new Map(); const resps = new Map(); const done = [];
ws.on('message', (data) => { const m = JSON.parse(data.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); return; }
  if (m.method === 'Network.requestWillBeSent') reqs.set(m.params.requestId, m.params.request.url);
  if (m.method === 'Network.responseReceived') resps.set(m.params.requestId, m.params.response);
  if (m.method === 'Network.loadingFinished') done.push(m.params); });
await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); ws.on('unexpected-response', (_r, rs) => rej(new Error('HTTP ' + rs.statusCode))); });
console.log('Network.enable ->', JSON.stringify(await send('Network.enable', { maxTotalBufferSize: 10_000_000 })), 'on', t.webSocketDebuggerUrl);
console.log('enabled; waiting 100s for JSON responses...');
await new Promise(r => setTimeout(r, 100000));
const json = done.filter(f => (resps.get(f.requestId)?.mimeType || '').includes('json'));
console.log(`finished=${done.length} json=${json.length}`);
for (const f of json.sort((a, b) => (b.encodedDataLength || 0) - (a.encodedDataLength || 0)).slice(0, 6)) {
  const url = (reqs.get(f.requestId) || '').replace(/^https:\/\/api-app\.noon\.com/, ''); const r = resps.get(f.requestId);
  try { const b = await send('Network.getResponseBody', { requestId: f.requestId }); const body = b.body || '';
    let parse = 'ok'; try { JSON.parse(body); } catch (e) { parse = 'FAIL ' + e.message.slice(0, 60); }
    console.log(`\n${url.slice(0, 70)}\n  encodedDataLength=${f.encodedDataLength} content-length=${r?.headers?.['content-length'] ?? r?.headers?.['Content-Length'] ?? '-'} content-encoding=${r?.headers?.['content-encoding'] ?? '-'}\n  body.length=${body.length} base64=${b.base64Encoded} utf8Bytes=${Buffer.byteLength(body)} parse=${parse}\n  head=${body.slice(0, 50).replace(/\s+/g, ' ')}\n  tail=${body.slice(-50).replace(/\s+/g, ' ')}`);
  } catch (e) { console.log(`\n${url.slice(0, 70)}\n  getResponseBody FAILED: ${e.message}`); }
}
ws.close(); process.exit(0);
