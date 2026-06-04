# Platform Interceptors — Re-integration Plan

## Why this branch exists
`main` ships the proven RN-oriented path: Proxyman capture, the ingest HTTP
server, the CDP/Metro source, and the RN `interceptor.js`. The native client
interceptors — iOS (`ios.swift`), Android (`android.kt`), Flutter
(`flutter.dart`) — are parked here until each is verified and hardened. This
file is the checklist for bringing them back to `main`.

## The integration seam (why deferral is clean)
Every interceptor is a *client*: it captures a request/response and POSTs a JSON
flow to the ingest server (`/flows` or `/flows/batch`, default `localhost:7890`).
The server is platform-agnostic and needs ZERO changes for new platforms. This
is purely client-side work + verification — no risk to the shipped server.

Canonical payload (must match `ingest-server.ts` -> `toFlow()`):

    {
      "request":  { "url", "method", "headers", "body?" },   // url+method required
      "response": { "status", "statusText?", "headers", "body?" },
      "startTime?", "endTime?", "duration?", "timestamp?"
    }

Rules every interceptor must honor:
- Skip traffic to the ingest host:port (avoid capture loops).
- Lowercase header keys (server does not normalize).
- Don't consume/destroy the app's real response stream when reading the body.
- Android emulator -> `10.0.2.2`; iOS simulator/device -> `localhost`.

## Per-platform status & work

### iOS — `ios.swift` (URLProtocol)
- Subclasses `URLProtocol`, `registerClass` globally, replays via `URLSession.shared`.
- Gaps: only catches `.shared` + sessions whose `configuration.protocolClasses`
  include it -> add a helper to inject into a custom `URLSessionConfiguration`
  (most apps use their own session). Document background-session / CFNetwork /
  gRPC as out of scope. Decide base64 marker for non-UTF8 bodies.
- Done when: a sample app with a custom URLSession shows flows in `list_requests`.

### Android — `android.kt` (OkHttp Interceptor)
- Application-level OkHttp `Interceptor`, async `enqueue`, `peekBody(1MB)`.
- Gaps: OkHttp-only (HttpURLConnection/others missed); 1MB peek silently
  truncates large bodies -> make configurable + record true size; confirm
  application- vs network-interceptor placement and document it.
- Done when: emulator sample (`10.0.2.2`) shows flows.

### Flutter — `flutter.dart` (Dio Interceptor)
- Dio `Interceptor` (onRequest/onResponse/onError), POST via raw `HttpClient`.
- BUG (priority): pairs request<->response by `request.hashCode` — hashes collide /
  get reused, mismatching flows under concurrency. Replace with a unique
  per-request id stored on `RequestOptions.extra`.
- Gaps: Dio-only (not `http` package / platform channels). Document.
- Done when: sample app shows correctly-paired flows under concurrent requests.

## Cross-cutting decisions (need a call)
1. Batching vs per-request: RN batches every 500ms; native ones POST per request.
   Standardize on batching for throughput/back-pressure?
2. Distribution: stay copy-paste snippets, or publish real packages
   (SPM/CocoaPods, Gradle/Maven, pub.dev)? Affects contract versioning.
3. Priority/order: noon is RN (covered on main). Are native interceptors for
   native modules inside noon, or other apps/teams? That sets the order.

## Verification strategy
- Contract test (cheap, do first): a script that POSTs each platform's
  representative payload to a running ingest server and asserts the flow lands in
  the store. Catches contract drift without a device.
- Per-platform smoke app: minimal app making 2-3 calls (incl. one POST-with-body
  and one error) and confirming flows via `list_requests` + `query_response`.

## Rollout
1. Land contract tests for the payload shape.
2. Fix Flutter pairing bug; verify.
3. Harden iOS custom-session injection; verify.
4. Make Android body cap configurable; verify.
5. Write README setup section per platform (today it lives only in code comments).
6. Merge platforms back to main one at a time — the server already supports them.
