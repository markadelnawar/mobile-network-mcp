# Capture Pipeline — Pre-Ship Findings & Fixes

Issues found while validating the three capture methods against the noon app
(Proxyman scripting, Proxyman CLI capture, RN ingest). These are about the
**shipped** code on `main` (ingest server + Proxyman capture). The native
iOS/Android/Flutter re-integration plan lives separately in
`interceptors/PLAN.md` on the `feature/platform-interceptors` branch.

## Method validation status
- **Method 3 — Proxyman scripting:** ✅ working, after fixing the body bug (#1).
- **Method 1 — Proxyman CLI capture:** ✅ pipeline validated (poller pulled 500
  flows), but needs the cursor fixes in #2 before shipping.
- **Method 2 — RN in-app interceptor:** ⬜ not yet tested end-to-end.

## Implementation status (code)
- ✅ #1 ingest body hardening (server-side `bodyToString` + proxyman.js `asString`)
- ✅ #2 inclusive-cursor rework: boundary-skip on ingest + reset detection/resync
- ✅ #4 startup sweep of stale `proxyman-mcp-*` temp dirs
- ✅ #5 port-file (`~/.mobile-network-mcp/port`) + `server_status` MCP tool; script
  auto-provision via `--print-proxyman-script` (kept auto-bump + discovery, not fail-loud)
- ◻️ #3 cross-method dedup — left documented (optional; content-signature merging
  can wrongly collapse genuinely distinct flows)
- ◻️ #6 ignore-filter tuning — config change, not code

## Inherent limits (document, not bugs)
- Captures **network traffic only** — cached responses and client-side
  filtering/pagination are invisible to *all* methods. Confirmed live: noon
  served a sunscreen search from cache, so no door captured it.
- **CDP door is dead on RN < 0.83** — Hermes returns "Unsupported method
  'Network.enable'" (verified on noon's RN 0.77). Use Proxyman or the in-app
  interceptor there.

---

## 1. Ingest body coercion — FIXED (pending commit)
**Problem:** `toFlow` did `String(body)`; when an interceptor sends a parsed
JSON object/array (Proxyman scripting hands the script parsed bodies), this
produced `"[object Object]"` / comma-joined garbage. Destroyed every JSON
response — fatal for a schema-query tool.
**Fix:** `interceptors/proxyman.js` now stringifies non-string bodies
(`asString`) — done. **Still TODO:** harden the server too — in `toFlow`,
`JSON.stringify` non-string bodies instead of `String()` (protects every
client, incl. method 2 when a request uses `responseType:'json'`).

## 2. Proxyman `--since` is INCLUSIVE — cursor logic needs rework
Verified empirically: `--since N` returns flows with ID **≥ N** (it returns the
boundary flow itself). Two consequences:

**2a. Latent duplicate (every poll).** Because the boundary flow `lastSeenId` is
re-returned each poll, `parseExportDir` currently re-ingests it (it only guards
the *cursor update* on `flowId > lastSeenId`, not the *push*). Fix: ingest only
flows with `flowId > lastSeenId`.

**2b. Reset detection.** Proxyman's ID counter survives `clear-session` (keeps
climbing) and resets **only on full app restart** — which can happen *without*
killing this tool, leaving a stale-high cursor that silently skips everything.
With inclusive `--since`, this is cleanly detectable:
- `--since lastMax` returns flows, max > lastMax → new data → update.
- returns flows, max == lastMax → idle (only the boundary came back) → pause.
- `"nothing to export"` → the boundary flow is GONE → clear/restart → run a full
  export (no `--since`); if non-empty, `clear()` the store and re-ingest from
  scratch; if empty, nothing to capture.
The inclusive boundary flow does double duty: it's the "is the cursor still
valid?" probe *and* the flow to skip on ingest. No 5-retry disambiguation
needed. On reset we discard old flows (mirror the reset — acceptable).

## 3. Cross-method double-push (no dedup)
**Problem:** `--source` picks one *active* source, but the ingest HTTP server
**always** runs. So running an active source + an interceptor that sees the same
traffic double-captures into the same store (e.g. `--source proxyman` + the
Proxyman scripting interceptor; or `--source cdp` + `interceptor.js`). The store
appends with no dedup.
**Fix options:** (a) document "pick one method per traffic stream", and/or
(b) content-signature dedup in the store, keyed on
`method + url + startTime + bodySize` within a short window.

## 4. Temp-dir orphan on hard kill
**Problem:** each `poll()` cleans its temp dir in a `finally` (fine normally),
but a `SIGKILL`/crash mid-poll leaks one `proxyman-mcp-<ts>` dir. No shutdown
handler, no startup sweep.
**Fix:** on startup, `rm` stale `proxyman-mcp-*` dirs in `os.tmpdir()` (robust
even against crashes; a shutdown handler wouldn't fire on SIGKILL anyway).

## 5. Ingest port auto-bump → silent split-brain
**Problem:** on `EADDRINUSE`, the ingest server does `port++` until free. Clients
hardcode `7890` and can't discover the bumped port, so flows go to the wrong/
dead instance. Hit live (one instance on 7890, another bumped to 7891).
**Trade-offs:**
- *Auto-bump (current):* always starts, but silent split-brain; N clients → N
  stores, only one fed.
- *Fail-loud on fixed port (recommended):* one discoverable server; surfaces
  orphan instances. Cost: a 2nd client can't start; needs a clear error.
- *Shared daemon (long-term):* decouple store out-of-process; true single
  source of truth; bigger rework.
- *Publish chosen port to a file:* helps host-side clients only, not the on-
  device interceptor; multiple instances fight over the file.
**Decision (revised):** *keep* auto-bump, but close the discoverability gap so it
stops being dangerous:
- On bind, **write the resolved port to a fixed port-file** (e.g.
  `~/.mobile-network-mcp/port`) that host-side clients/tools read.
- Expose a **`server_status` MCP tool** ("listening on port N, M flows") so the
  user/AI can ask where flows land.
- **Auto-provision the Proxyman script with the resolved port injected** — so the
  script always targets the live port (this is what makes bump safe).
- Keep `--ingest-port` as an explicit override.
Method 1 (CLI export poll) is **port-independent** — it writes to the store
directly, never through the ingest server — so it's unaffected either way.

### Auto-provisioning the Proxyman script — feasibility
Verified the config format via `proxyman-cli export`:
`scriptingData.data` = `base64(gzip(JSON))` → `{ userFiles:[{name, data:base64(body)}],
tree:[url-match rules] }`. Two takeaways:
- **`import`-templating is fragile:** the `tree` match-rule schema is non-trivial,
  and `export` did **not** round-trip the live editor script (only the default
  `HelloWorld.js` came back) — so we can't reliably template a rule from an export.
- **Preferred:** use Proxyman's own MCP `create_scripting_rule` (native, no format
  wrangling) if available; else **generate-and-print** the script with the port
  pre-injected for a one-shot manual paste. Avoid hand-building the `import` blob.

### Don't double-capture (see #3)
Auto-provisioning the script (push) while also running `--source proxyman` (poll)
captures the same Proxyman traffic twice. Treat "ingest + auto-provision script"
as its own mode, mutually exclusive with CLI-poll for Proxyman traffic.

## 6. Ignore-filter tuning
The default `tracking|analytics|etracker|recapi/ingest` doesn't catch noon's
`adtracker` calls (pattern is `tracking`, not `tracker`), and theme/static
assets flood the store. Tune the default ignore list (add `adtracker`/`tracker`,
consider dropping `/assets/` and image content-types) so the store stays focused
on real API calls.
