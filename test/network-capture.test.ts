import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { NetworkCapture } from "../src/capture/network-capture.js";
import { RequestStore } from "../src/store/request-store.js";
import type { CDPClient, CDPEventHandler, CDPConnectHandler } from "../src/capture/cdp-client.js";

/** In-memory stand-in for CDPClient: records commands, lets tests emit events and simulate reconnects. */
class FakeCDP {
  sent: Array<{ method: string; params: Record<string, unknown> }> = [];
  bodies = new Map<string, { body: string; base64Encoded?: boolean }>();
  private eventHandlers: CDPEventHandler[] = [];
  private connectHandlers: CDPConnectHandler[] = [];

  onEvent(handler: CDPEventHandler): void {
    this.eventHandlers.push(handler);
  }
  onConnected(handler: CDPConnectHandler): void {
    this.connectHandlers.push(handler);
  }
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === "Network.getResponseBody") {
      const body = this.bodies.get(params.requestId as string);
      if (!body) throw new Error("No resource with given identifier found");
      return body;
    }
    return {};
  }
  emit(method: string, params: Record<string, unknown>): void {
    for (const handler of this.eventHandlers) handler(method, params);
  }
  async reconnect(): Promise<void> {
    for (const handler of this.connectHandlers) await handler();
  }
  asClient(): CDPClient {
    return this as unknown as CDPClient;
  }
  count(method: string): number {
    return this.sent.filter((s) => s.method === method).length;
  }
}

function request(cdp: FakeCDP, id: string, url: string, method = "GET"): void {
  cdp.emit("Network.requestWillBeSent", {
    requestId: id,
    request: { url, method, headers: { accept: "application/json" } },
    wallTime: 1_700_000_000,
  });
}
function response(cdp: FakeCDP, id: string, status = 200, mimeType = "application/json"): void {
  cdp.emit("Network.responseReceived", {
    requestId: id,
    response: { status, statusText: "OK", headers: { "content-type": mimeType }, mimeType },
  });
}
/** loadingFinished triggers an awaited getResponseBody — yield to let it settle. */
async function finish(cdp: FakeCDP, id: string, encodedDataLength = 42): Promise<void> {
  cdp.emit("Network.loadingFinished", { requestId: id, encodedDataLength });
  await new Promise((r) => setTimeout(r, 0));
}

async function setup(ignoreUrls?: string[]) {
  const cdp = new FakeCDP();
  const store = new RequestStore();
  const capture = new NetworkCapture(cdp.asClient(), store, { ignoreUrls });
  await capture.start();
  return { cdp, store, capture };
}

describe("NetworkCapture", () => {
  it("enables the Network domain on start", async () => {
    const { cdp } = await setup();
    assert.equal(cdp.count("Network.enable"), 1);
  });

  it("stores a completed flow with its fetched body", async () => {
    const { cdp, store } = await setup();
    cdp.bodies.set("r1", { body: '{"items":[1,2,3]}' });

    request(cdp, "r1", "https://api.example.com/items");
    response(cdp, "r1");
    await finish(cdp, "r1", 128);

    assert.equal(store.size, 1);
    const flow = store.list().flows[0];
    assert.equal(flow.request.url, "https://api.example.com/items");
    assert.equal(flow.request.timestamp, 1_700_000_000);
    assert.equal(flow.response?.status, 200);
    assert.equal(flow.response?.body, '{"items":[1,2,3]}');
    assert.equal(flow.response?.bodySize, '{"items":[1,2,3]}'.length);
    assert.equal(flow.response?.encodedDataLength, 128);
    assert.equal(typeof flow.timing.duration, "number");
  });

  it("replaces base64 (binary) bodies with a placeholder", async () => {
    const { cdp, store } = await setup();
    cdp.bodies.set("img", { body: "iVBORw0KGgo=", base64Encoded: true });

    request(cdp, "img", "https://cdn.example.com/logo.png");
    response(cdp, "img", 200, "image/png");
    await finish(cdp, "img");

    assert.equal(store.list().flows[0].response?.body, "[base64 encoded, 12 chars]");
  });

  it("drops URLs matching the ignore list before they reach the store", async () => {
    const { cdp, store } = await setup(["tracking|analytics", "cdn.example.com"]);
    cdp.bodies.set("keep", { body: "{}" });

    request(cdp, "t1", "https://metrics.example.com/analytics/collect", "POST");
    request(cdp, "a1", "https://cdn.example.com/icons/logo.svg");
    request(cdp, "keep", "https://api.example.com/users");
    for (const id of ["t1", "a1", "keep"]) {
      response(cdp, id);
      await finish(cdp, id);
    }

    assert.equal(store.size, 1);
    assert.equal(store.list().flows[0].request.url, "https://api.example.com/users");
    // Ignored requests must not cost a body fetch either
    const fetched = cdp.sent.filter((s) => s.method === "Network.getResponseBody").map((s) => s.params.requestId);
    assert.deepEqual(fetched, ["keep"]);
  });

  it("treats an ignore pattern that is not a valid regex as a literal substring", async () => {
    const { cdp, store } = await setup(["/v1/(users"]);

    request(cdp, "lit", "https://api.example.com/v1/(users");
    request(cdp, "ok", "https://api.example.com/v1/users");
    for (const id of ["lit", "ok"]) {
      response(cdp, id);
      await finish(cdp, id);
    }

    assert.equal(store.size, 1);
    assert.equal(store.list().flows[0].request.url, "https://api.example.com/v1/users");
  });

  it("re-enables the Network domain after a reconnect and forgets stale in-flight requests", async () => {
    const { cdp, store } = await setup();
    request(cdp, "stale", "https://api.example.com/slow");

    await cdp.reconnect();

    assert.equal(cdp.count("Network.enable"), 2);
    // The old session's request can never complete; a late finish must not create a half-flow
    response(cdp, "stale");
    await finish(cdp, "stale");
    assert.equal(store.size, 0);
  });

  it("records failed requests with a synthetic status-0 response", async () => {
    const { cdp, store } = await setup();

    request(cdp, "f1", "https://api.example.com/timeout");
    cdp.emit("Network.loadingFailed", { requestId: "f1", errorText: "net::ERR_TIMED_OUT" });

    assert.equal(store.size, 1);
    const flow = store.list().flows[0];
    assert.equal(flow.response?.status, 0);
    assert.equal(flow.response?.statusText, "net::ERR_TIMED_OUT");
  });
});

describe("NetworkCapture truncation detection", () => {
  it("flags a body whose UTF-8 byte count is shorter than encodedDataLength", async () => {
    const { cdp, store } = await setup();
    // 12 UTF-16 chars, 13 UTF-8 bytes; the response really had 14 bytes.
    cdp.bodies.set("t", { body: '{"name":"ñ"}' });
    request(cdp, "t", "https://api.example.com/item");
    response(cdp, "t");
    await finish(cdp, "t", 14);

    const flow = store.list().flows[0];
    assert.deepEqual(flow.response?.truncated, {
      capturedBytes: 13,
      expectedBytes: 14,
      reason: "React Native inspector stored a short copy of the body",
    });
  });

  it("does not flag a complete body, nor one longer than a compressed encodedDataLength", async () => {
    const { cdp, store } = await setup();
    cdp.bodies.set("ok", { body: '{"name":"ñ"}' });
    cdp.bodies.set("gz", { body: '{"name":"plain text longer than its gzip size"}' });
    request(cdp, "ok", "https://api.example.com/a");
    response(cdp, "ok");
    await finish(cdp, "ok", 13);
    request(cdp, "gz", "https://api.example.com/b");
    response(cdp, "gz");
    await finish(cdp, "gz", 20);

    for (const flow of store.list().flows) assert.equal(flow.response?.truncated, undefined);
  });
});

describe("NetworkCapture.start", () => {
  it("registers its listeners once even when start() is retried", async () => {
    const cdp = new FakeCDP();
    const store = new RequestStore();
    const capture = new NetworkCapture(cdp.asClient(), store);
    await capture.start();
    await capture.start();
    assert.equal(cdp.count("Network.enable"), 2);
    cdp.bodies.set("r", { body: "{}" });
    request(cdp, "r", "https://api.example.com/once");
    response(cdp, "r");
    await finish(cdp, "r");
    assert.equal(store.size, 1); // a duplicated listener would have stored it twice
    await cdp.reconnect();
    assert.equal(cdp.count("Network.enable"), 3); // one onConnected handler, not two
  });
});
