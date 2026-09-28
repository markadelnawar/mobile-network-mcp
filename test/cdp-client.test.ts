import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import { CDPClient } from "../src/capture/cdp-client.js";

/**
 * Minimal Metro look-alike: serves the /json target list and guards the
 * debugger WebSocket the way `@react-native/dev-middleware` 0.8x does — the
 * Origin must have a localhost hostname, otherwise the upgrade is refused (401).
 */
function startFakeMetro(): Promise<{ port: number; rejectedOrigins: Array<string | undefined>; close: () => Promise<void> }> {
  const rejectedOrigins: Array<string | undefined> = [];
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
  // Echo every command back as a result so `send` round-trips can be asserted.
  wss.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string };
      socket.send(JSON.stringify({ id: msg.id, result: { echoed: msg.method } }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        rejectedOrigins,
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

describe("CDPClient", () => {
  let metro: Awaited<ReturnType<typeof startFakeMetro>>;
  before(async () => {
    metro = await startFakeMetro();
  });
  after(async () => {
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

  it("connects with Metro's own origin and round-trips commands", async () => {
    const client = new CDPClient(metro.port, "localhost");
    await client.connect();
    assert.equal(client.connected, true);

    const result = await client.send("Network.enable", { maxTotalBufferSize: 1 });
    assert.deepEqual(result, { echoed: "Network.enable" });

    await client.disconnect();
    assert.equal(client.connected, false);
    // Only the deliberately origin-less socket from the previous test was refused
    assert.equal(metro.rejectedOrigins.length, 1);
  });
});
