import WebSocket from "ws";
import type { CDPTarget } from "./types.js";

export type CDPEventHandler = (method: string, params: Record<string, unknown>) => void;
export type CDPConnectHandler = () => void | Promise<void>;

/** What captures need from a CDP connection — lets tests substitute a fake. */
export interface CDPClientLike {
  readonly connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onEvent(handler: CDPEventHandler): void;
  onConnected(handler: CDPConnectHandler): void;
  onDisconnected(handler: () => void): void;
}

export interface CDPClientOptions {
  /** Delay between reconnect attempts after an established socket drops. */
  reconnectDelayMs?: number;
  /** How long a CDP command may wait for its result. */
  commandTimeoutMs?: number;
  /** Timeout for the Metro `/json` target discovery request. */
  discoverTimeoutMs?: number;
  log?: (line: string) => void;
}

const DEFAULT_RECONNECT_DELAY_MS = 3000;
const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;
const DEFAULT_DISCOVER_TIMEOUT_MS = 5_000;
const UNSUPPORTED_RE = /unsupported method|not supported|-32601/i;

/** Hermes on React Native < 0.83 answers `Network.enable` with a JSON-RPC "method not found". */
export function isNetworkDomainUnsupported(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return UNSUPPORTED_RE.test(message);
}

/**
 * Minimal CDP client that connects to Metro's inspector proxy via WebSocket.
 * Sends CDP commands and dispatches events to registered handlers.
 *
 * Ownership of reconnection: callers drive `connect()` until it succeeds once;
 * from then on the client reconnects by itself whenever the established socket
 * drops, until `disconnect()` is called. Exactly one socket is live at a time —
 * `connect()` tears down whatever socket existed before opening a new one, and
 * events from a superseded socket are ignored.
 */
export class CDPClient implements CDPClientLike {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pendingCallbacks = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private eventHandlers: CDPEventHandler[] = [];
  private connectHandlers: CDPConnectHandler[] = [];
  private disconnectHandlers: Array<() => void> = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private _connected = false;
  private closedByUser = false;
  private readonly reconnectDelayMs: number;
  private readonly commandTimeoutMs: number;
  private readonly discoverTimeoutMs: number;
  private readonly log: (line: string) => void;

  constructor(
    private metroPort: number,
    private metroHost: string = "localhost",
    options: CDPClientOptions = {},
  ) {
    this.reconnectDelayMs = options.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    this.discoverTimeoutMs = options.discoverTimeoutMs ?? DEFAULT_DISCOVER_TIMEOUT_MS;
    this.log = options.log ?? ((line) => console.error(`[mobile-network-mcp] ${line}`));
  }

  get connected(): boolean {
    return this._connected;
  }

  onEvent(handler: CDPEventHandler): void {
    this.eventHandlers.push(handler);
  }

  /**
   * Register a handler that runs after every connection established AFTER the
   * handler was registered — i.e. on reconnects. Metro forgets all enabled CDP
   * domains when the socket drops (app relaunch, Metro restart), so captures use
   * this to re-send their `*.enable` commands.
   */
  onConnected(handler: CDPConnectHandler): void {
    this.connectHandlers.push(handler);
  }

  /** Runs when an established connection drops (not on a failed connect attempt). */
  onDisconnected(handler: () => void): void {
    this.disconnectHandlers.push(handler);
  }

  /**
   * Discover available CDP targets from Metro's /json endpoint, then connect to
   * the first suitable one. Replaces any existing socket. Rejects when Metro is
   * unreachable, has no debuggable target, or refuses the handshake — the caller
   * decides whether to retry. Once resolved, reconnection is automatic.
   */
  async connect(): Promise<void> {
    this.closedByUser = false;
    this.teardownSocket(new Error("CDP connection replaced"));
    const targets = await this.discoverTargets();
    if (this.closedByUser) return; // disconnect() raced the discovery request
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
      }, this.commandTimeoutMs);

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
    this.teardownSocket(new Error("CDP client disconnected"));
    this._connected = false;
  }

  /** Close and forget the current socket without triggering reconnect logic. */
  private teardownSocket(reason: Error): void {
    const old = this.ws;
    this.ws = null;
    this._connected = false;
    this.rejectPending(reason);
    if (!old) return;
    old.removeAllListeners();
    old.on("error", () => {
      // a socket we no longer care about must not crash the process
    });
    if (old.readyState === WebSocket.OPEN) old.close();
    else old.terminate();
  }

  private rejectPending(reason: Error): void {
    for (const cb of this.pendingCallbacks.values()) cb.reject(reason);
    this.pendingCallbacks.clear();
  }

  private async discoverTargets(): Promise<CDPTarget[]> {
    const url = `http://${this.metroHost}:${this.metroPort}/json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(this.discoverTimeoutMs) });
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
   * Metro's own origin or whose hostname is on a localhost allow-list. A request
   * with no Origin header — the `ws` default for non-browser clients — is
   * rejected with `401 Unauthorized`. A localhost origin is on the allow-list no
   * matter which host Metro was started on, so it also works with `--host`.
   */
  private get originHeader(): string {
    return `http://localhost:${this.metroPort}`;
  }

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl, { origin: this.originHeader, handshakeTimeout: this.commandTimeoutMs });
      this.ws = ws;
      const isCurrent = () => this.ws === ws;

      ws.on("open", () => {
        if (!isCurrent()) {
          ws.terminate();
          return;
        }
        this._connected = true;
        this.reconnectAttempts = 0;
        resolve();
        void this.fireConnected();
      });

      // `ws` emits this instead of "error" when the upgrade gets a non-101 response
      // and leaves the request hanging — abort it ourselves.
      ws.on("unexpected-response", (req, res) => {
        req.destroy();
        if (isCurrent()) this.ws = null;
        const status = res.statusCode ?? 0;
        const hint =
          status === 401 || status === 403
            ? ` Sent Origin "${this.originHeader}"; Metro only accepts its own origin or a localhost hostname.`
            : "";
        reject(new Error(`Metro refused the debugger WebSocket (HTTP ${status}).${hint}`));
      });

      ws.on("message", (data: WebSocket.Data) => {
        if (isCurrent()) this.handleMessage(data.toString());
      });

      ws.on("close", () => {
        if (!isCurrent()) return;
        this.ws = null;
        const wasConnected = this._connected;
        this._connected = false;
        this.rejectPending(new Error("CDP connection closed"));
        if (this.closedByUser || !wasConnected) return; // a failed handshake is reported via "error"/"unexpected-response"
        for (const handler of this.disconnectHandlers) {
          try {
            handler();
          } catch {
            // observers must not break reconnect
          }
        }
        this.scheduleReconnect();
      });

      ws.on("error", (err) => {
        if (!isCurrent()) return;
        if (!this._connected) {
          this.ws = null;
          reject(err);
        }
        // If already connected, the close handler will trigger reconnect
      });
    });
  }

  /** Retry every reconnectDelayMs until a target is back (e.g. after an app relaunch). */
  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      this.reconnectAttempts++;
      try {
        await this.connect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Log the first few and then every 20th (~1/min at 3s) so a missing app doesn't flood stderr.
        if (this.reconnectAttempts <= 3 || this.reconnectAttempts % 20 === 0) {
          this.log(`Reconnect attempt ${this.reconnectAttempts} failed: ${message} — retrying every ${this.reconnectDelayMs / 1000}s`);
        }
        this.scheduleReconnect();
      }
    }, this.reconnectDelayMs);
  }

  private async fireConnected(): Promise<void> {
    for (const handler of this.connectHandlers) {
      try {
        await handler();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.log(`onConnected handler failed: ${message}`);
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
