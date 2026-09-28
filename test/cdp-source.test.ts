import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { startCdpSource, isNetworkDomainUnsupported } from "../src/capture/cdp-source.js";
import { RequestStore } from "../src/store/request-store.js";
import type { CDPClientLike, CDPEventHandler, CDPConnectHandler } from "../src/capture/cdp-client.js";

/** Scriptable stand-in: `connectResults` are consumed per attempt (Error → reject, else resolve). */
class FakeClient implements CDPClientLike {
  connected = false;
  disconnects = 0;
  enableCalls = 0;
  private connectHandlers: CDPConnectHandler[] = [];
  private disconnectHandlers: Array<() => void> = [];
  constructor(private connectResults: Array<Error | null>, public enableError?: Error, private dropOnEnableError = false) {}
  async connect(): Promise<void> {
    const r = this.connectResults.shift() ?? null;
    if (r) throw r;
    this.connected = true;
    for (const h of this.connectHandlers) await h();
  }
  async disconnect(): Promise<void> { this.connected = false; this.disconnects++; }
  async send(method: string): Promise<unknown> {
    if (method === "Network.enable") {
      this.enableCalls++;
      if (this.enableError) {
        if (this.dropOnEnableError) this.connected = false;
        throw this.enableError;
      }
    }
    return {};
  }
  onEvent(_h: CDPEventHandler): void {}
  onConnected(h: CDPConnectHandler): void { this.connectHandlers.push(h); }
  onDisconnected(h: () => void): void { this.disconnectHandlers.push(h); }
  dropConnection(): void { this.connected = false; for (const h of this.disconnectHandlers) h(); }
  async reconnect(): Promise<void> { this.connected = true; for (const h of this.connectHandlers) await h(); }
}

const base = (client: FakeClient, logs: string[] = []) => ({
  store: new RequestStore(),
  metroHost: "localhost",
  metroPort: 8081,
  retryDelayMs: 1,
  log: (l: string) => logs.push(l),
  createClient: () => client,
});

describe("isNetworkDomainUnsupported", () => {
  it("recognises Hermes' method-not-found answers", () => {
    assert.equal(isNetworkDomainUnsupported(new Error("Unsupported method 'Network.enable'")), true);
    assert.equal(isNetworkDomainUnsupported(new Error("'Network.enable' wasn't found (-32601)")), true);
    assert.equal(isNetworkDomainUnsupported(new Error("CDP command timed out: Network.enable")), false);
  });
});

describe("startCdpSource", () => {
  it("retries until Metro exposes an app, then reports connected", async () => {
    const client = new FakeClient([new Error("no target"), new Error("no target"), null]);
    const logs: string[] = [];
    const src = startCdpSource(base(client, logs));
    await src.done;
    assert.deepEqual(src.status(), { state: "connected", attempts: 3, detail: undefined });
    assert.equal(client.enableCalls, 1);
    assert.ok(logs.some((l) => /attempt 3\)/.test(l)));
  });

  it("stops and reports 'unsupported' when the runtime has no Network domain", async () => {
    const client = new FakeClient([null, null, null], new Error("Unsupported method 'Network.enable'"));
    const logs: string[] = [];
    const src = startCdpSource(base(client, logs));
    await src.done;
    const s = src.status();
    assert.equal(s.state, "unsupported");
    assert.equal(s.attempts, 1);
    assert.match(s.detail ?? "", /React Native < 0\.83/);
    assert.equal(client.disconnects, 1);
    assert.ok(logs.some((l) => /interceptor\.js/.test(l)));
  });

  it("tracks socket drops and re-enables capture on reconnect", async () => {
    const client = new FakeClient([null]);
    const src = startCdpSource(base(client));
    await src.done;
    client.dropConnection();
    assert.equal(src.status().state, "reconnecting");
    await client.reconnect();
    assert.equal(src.status().state, "connected");
    assert.equal(client.enableCalls, 2);
  });

  it("hands over to the client's own reconnect when the socket drops while enabling", async () => {
    const client = new FakeClient([null], new Error("CDP connection closed"), true);
    const logs: string[] = [];
    const src = startCdpSource(base(client, logs));
    await src.done;
    assert.equal(src.status().state, "reconnecting");
    assert.equal(client.enableCalls, 1);
    client.enableError = undefined;
    await client.reconnect(); // NetworkCapture's onConnected re-enables — no second driver needed
    assert.equal(src.status().state, "connected");
    assert.equal(client.enableCalls, 2);
  });

  it("stop() ends the loop and disconnects", async () => {
    const client = new FakeClient([new Error("no target"), new Error("no target"), new Error("no target"), new Error("no target")]);
    const src = startCdpSource(base(client));
    await new Promise((r) => setTimeout(r, 5));
    await src.stop();
    await src.done;
    assert.equal(client.disconnects, 1);
  });
});
