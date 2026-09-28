import WebSocket from "ws";
import type { CDPTarget } from "./types.js";

export type CDPEventHandler = (method: string, params: Record<string, unknown>) => void;
export type CDPConnectHandler = () => void | Promise<void>;

const RECONNECT_DELAY_MS = 3000;
const COMMAND_TIMEOUT_MS = 10_000;

/**
 * Minimal CDP client that connects to Metro's inspector proxy via WebSocket.
 * Sends CDP commands and dispatches events to registered handlers.
 */
export class CDPClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pendingCallbacks = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private eventHandlers: CDPEventHandler[] = [];
  private connectHandlers: CDPConnectHandler[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;
  private closedByUser = false;

  constructor(
    private metroPort: number,
    private metroHost: string = "localhost",
  ) {}

  get connected(): boolean {
    return this._connected;
  }

  onEvent(handler: CDPEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Register a handler that runs after every connection established AFTER the
   * handler was registered — i.e. on reconnects. Metro forgets all enabled CDP
   * domains when the socket drops (app reload, Metro restart), so captures use
   * this to re-send their `*.enable` commands.
   */
  onConnected(handler: CDPConnectHandler): void {
    this.connectHandlers.push(handler);
  }

  /**
   * Discover available CDP targets from Metro's /json endpoint,
   * then connect to the first suitable one.
   */
  async connect(): Promise<void> {
    this.closedByUser = false;
    const targets = await this.discoverTargets();
    const target = this.pickTarget(targets);

    if (!target?.webSocketDebuggerUrl) {
      throw new Error(
        `No debuggable React Native target found on ${this.metroHost}:${this.metroPort}. ` +
          `Is Metro running? Found ${targets.length} target(s): ${targets.map((t) => t.title).join(", ") || "(none)"}`,
      );
    }

    await this.connectWebSocket(target.webSocketDebuggerUrl);
  }

  /** Send a CDP command and wait for the result. */
  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP client is not connected");
    }

    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingCallbacks.has(id)) {
          this.pendingCallbacks.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }
      }, COMMAND_TIMEOUT_MS);

      this.pendingCallbacks.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws!.send(message);
    });
  }

  async disconnect(): Promise<void> {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  private async discoverTargets(): Promise<CDPTarget[]> {
    const url = `http://${this.metroHost}:${this.metroPort}/json`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to discover CDP targets: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as CDPTarget[];
  }

  private pickTarget(targets: CDPTarget[]): CDPTarget | undefined {
    // Prefer React Native targets, fall back to first available
    return (
      targets.find(
        (t) =>
          t.title?.includes("React Native") ||
          t.title?.includes("Hermes") ||
          t.type === "node",
      ) ?? targets[0]
    );
  }

  /**
   * Origin sent with the WebSocket upgrade.
   *
   * Since RN 0.8x, `@react-native/dev-middleware` guards the debugger socket
   * with a `verifyClient` hook that only admits requests whose Origin is
   * Metro's own origin or whose hostname is `localhost`/`127.0.0.1`. A request
   * with no Origin header — the `ws` default for non-browser clients — is
   * rejected with `401 Unauthorized`. Presenting Metro's own origin is what
   * React Native DevTools (served by Metro) does, so it is accepted everywhere.
   */
  private get originHeader(): string {
    return `http://${this.metroHost}:${this.metroPort}`;
  }

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { origin: this.originHeader });
      this.ws = ws;

      ws.on("open", () => {
        this._connected = true;
        resolve();
        void this.fireConnected();
      });

      // `ws` emits this instead of "error" when the upgrade gets a non-101 response.
      ws.on("unexpected-response", (_req, res) => {
        reject(
          new Error(
            `Metro refused the debugger WebSocket (HTTP ${res.statusCode}). ` +
              `Sent Origin "${this.originHeader}"; Metro only accepts its own origin or a localhost hostname.`,
          ),
        );
      });

      ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      ws.on("close", () => {
        this._connected = false;
        if (this.closedByUser) return;
        this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        if (!this._connected) {
          reject(err);
        }
        // If already connected, the close handler will trigger reconnect
      });
    });
  }

  /** Retry every RECONNECT_DELAY_MS until a target is back (e.g. after an app reload). */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => this.scheduleReconnect());
    }, RECONNECT_DELAY_MS);
  }

  private async fireConnected(): Promise<void> {
    for (const handler of this.connectHandlers) {
      try {
        await handler();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[mobile-network-mcp] onConnected handler failed: ${message}`);
      }
    }
  }

  private handleMessage(raw: string): void {
    let msg: { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Response to a command we sent
    if (msg.id !== undefined && this.pendingCallbacks.has(msg.id)) {
      const cb = this.pendingCallbacks.get(msg.id)!;
      this.pendingCallbacks.delete(msg.id);
      if (msg.error) {
        cb.reject(new Error(msg.error.message));
      } else {
        cb.resolve(msg.result);
      }
      return;
    }

    // Event from the target
    if (msg.method && msg.params) {
      for (const handler of this.eventHandlers) {
        handler(msg.method, msg.params);
      }
    }
  }
}
