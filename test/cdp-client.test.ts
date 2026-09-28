import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { CDPClient } from "../src/capture/cdp-client.js";

/**
 * Minimal Metro look-alike: serves the /json target list and guards the
 * debugger WebSocket the way `@react-native/dev-middleware` 0.8x does — the
 * Origin must have a localhost hostname, otherwise the upgrade is refused (401).
 * Commands are echoed back as results, except "Never.answer" (left pending).
 */
function startFakeMetro() {
  const rejectedOrigins: Array<string | undefined> = [];
  let connections = 0;
  const server: Server = createServer((req, res) => {
    if (req.url === "/json") {
      const { port } = server.address() as AddressInfo;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify([
          {
            id: "dev-1",
            title: "com.example.app (iPhone)",
            description: "React Native Bridgeless [C++ connection]",
            type: "node",
            webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug?device=dev&page=1`,
          },
        ]),
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  const wss = new WebSocketServer({
    server,
    verifyClient: (info: { origin: string; secure: boolean; req: IncomingMessage }) => {
      const origin: string | undefined = info.origin;
      if (origin && URL.canParse(origin) && ["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) {
        return true;
      }
      rejectedOrigins.push(origin);
      return false;
    },
  });
  wss.on("connection", (socket) => {
    connections++;
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string };
      if (msg.method === "Never.answer") return;
      socket.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method } }));
    });
  });

  return new Promise<{
    port: number;
    rejectedOrigins: Array<string | undefined>;
    connections: () => number;
    openSockets: () => number;
    dropAll: () => void;
    close: () => Promise<void>;
  }>((resolve) => {
    server.listen(0, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        rejectedOrigins,
        connections: () => connections,
        openSockets: () => [...wss.clients].filter((c) => c.readyState === WebSocket.OPEN).length,
        dropAll: () => {
          for (const client of wss.clients) client.close();
        },
        close: () =>
          new Promise<void>((done) => {
            for (const client of wss.clients) client.terminate();
            wss.close();
            server.close(() => done());
          }),
      });
    });
  });
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("CDPClient", () => {
  let metro: Awaited<ReturnType<typeof startFakeMetro>>;
  const clients: CDPClient[] = [];
  const make = (opts = {}) => {
    const c = new CDPClient(metro.port, "localhost", { reconnectDelayMs: 20, commandTimeoutMs: 500, ...opts });
    clients.push(c);
    return c;
  };
  before(async () => {
    metro = await startFakeMetro();
  });
  beforeEach(async () => {
    while (clients.length) await clients.pop()!.disconnect();
  });
  after(async () => {
    while (clients.length) await clients.pop()!.disconnect();
    await metro.close();
  });

  it("is refused by Metro when the debugger socket has no Origin (why the client sends one)", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const raw = new WebSocket(`ws://localhost:${metro.port}/inspector/debug?device=dev&page=1`);
      raw.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      raw.on("open", () => reject(new Error("expected the origin-less socket to be refused")));
    });
    assert.equal(status, 401);
    assert.deepEqual(metro.rejectedOrigins, [undefined]);
  });

  it("connects with a localhost origin and round-trips commands", async () => {
    const client = make();
    await client.connect();
    assert.equal(client.connected, true);
    assert.deepEqual(await client.send("Network.enable", { maxTotalBufferSize: 1 }), { echoed: "Network.enable" });
    await client.disconnect();
    assert.equal(client.connected, false);
    assert.equal(metro.rejectedOrigins.length, 1); // only the deliberately origin-less socket above
  });

  it("explains a 401 in terms of the Origin header", async () => {
    // Point the client at a port where our origin is NOT on the allow-list: simulate by
    // using a hostname Metro rejects (::1 is not in the fake's list, but the client always
    // sends localhost) — so instead assert the message shape via a refused fake.
    const refusing = await startFakeMetroRefusingAll();
    try {
      const client = new CDPClient(refusing.port, "localhost", { reconnectDelayMs: 20 });
      await assert.rejects(client.connect(), (err: Error) => /HTTP 401/.test(err.message) && /Origin "http:\/\/localhost:\d+"/.test(err.message));
      assert.equal(client.connected, false);
    } finally {
      await refusing.close();
    }
  });

  it("reconnects by itself when an established socket drops, and reports both edges once", async () => {
    const client = make();
    let disconnected = 0;
    let reconnected = 0;
    client.onDisconnected(() => disconnected++);
    await client.connect();
    client.onConnected(() => {
      reconnected++;
    });
    const before = metro.connections();

    metro.dropAll();
    await settle(120);

    assert.equal(disconnected, 1);
    assert.equal(reconnected, 1);
    assert.equal(client.connected, true);
    assert.equal(metro.connections(), before + 1);
    assert.deepEqual(await client.send("Network.enable"), { echoed: "Network.enable" });
  });

  it("rejects commands still in flight when the socket closes instead of waiting for the timeout", async () => {
    const client = make({ commandTimeoutMs: 5000 });
    await client.connect();
    const pending = client.send("Never.answer");
    metro.dropAll();
    await assert.rejects(pending, /CDP connection closed/);
  });

  it("does not reconnect after disconnect()", async () => {
    const client = make();
    await client.connect();
    const before = metro.connections();
    await client.disconnect();
    await settle(80);
    assert.equal(metro.connections(), before);
    assert.equal(client.connected, false);
  });

  it("connect() replaces an existing socket instead of leaking it", async () => {
    const client = make();
    await client.connect();
    await client.connect();
    await settle(30);
    assert.equal(client.connected, true);
    assert.equal(metro.openSockets(), 1);
    // the superseded socket's close must not have scheduled a reconnect
    const before = metro.connections();
    await settle(60);
    assert.equal(metro.connections(), before);
  });

  it("keeps retrying a reconnect while Metro has no target, then recovers", async () => {
    const flaky = await startFakeMetro();
    try {
      const client = new CDPClient(flaky.port, "localhost", { reconnectDelayMs: 20, log: () => {} });
      clients.push(client);
      await client.connect();
      // Take Metro away entirely, wait a few reconnect ticks, bring it back on the same port
      const port = flaky.port;
      await flaky.close();
      await settle(80);
      assert.equal(client.connected, false);
      const revived = await startFakeMetroOn(port);
      try {
        await settle(120);
        assert.equal(client.connected, true);
      } finally {
        await client.disconnect();
        await revived.close();
      }
    } catch (err) {
      await flaky.close().catch(() => {});
      throw err;
    }
  });
});

/** A fake Metro that refuses every debugger socket (401) — for the error-message test. */
async function startFakeMetroRefusingAll() {
  const server = createServer((req, res) => {
    if (req.url === "/json") {
      const { port } = server.address() as AddressInfo;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: "1", title: "x", type: "node", webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug` }]));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server, verifyClient: () => false });
  await new Promise<void>((r) => server.listen(0, r));
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((done) => { wss.close(); server.close(() => done()); }),
  };
}

/** Same as startFakeMetro but bound to a specific port (to simulate Metro coming back). */
async function startFakeMetroOn(port: number) {
  const server = createServer((req, res) => {
    if (req.url === "/json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: "1", title: "app", description: "React Native Bridgeless", type: "node", webSocketDebuggerUrl: `ws://localhost:${port}/inspector/debug` }]));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => socket.on("message", (raw) => { const m = JSON.parse(raw.toString()); socket.send(JSON.stringify({ id: m.id, result: {} })); }));
  await new Promise<void>((r) => server.listen(port, r));
  return { close: () => new Promise<void>((done) => { for (const c of wss.clients) c.terminate(); wss.close(); server.close(() => done()); }) };
}
