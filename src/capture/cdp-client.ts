import WebSocket from "ws";
import type { CDPTarget } from "./types.js";

export type CDPEventHandler = (method: string, params: Record<string, unknown>) => void;

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
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _connected = false;

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
   * Discover available CDP targets from Metro's /json endpoint,
   * then connect to the first suitable one.
   */
  async connect(): Promise<void> {
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
      this.pendingCallbacks.set(id, { resolve, reject });
      this.ws!.send(message);

      // Timeout after 10s
      setTimeout(() => {
        if (this.pendingCallbacks.has(id)) {
          this.pendingCallbacks.delete(id);
          reject(new Error(`CDP command timed out: ${method}`));
        }
      }, 10_000);
    });
  }

  async disconnect(): Promise<void> {
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

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on("open", () => {
        this._connected = true;
        resolve();
      });

      this.ws.on("message", (data: WebSocket.Data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("close", () => {
        this._connected = false;
        // Auto-reconnect after 3s
        this.reconnectTimer = setTimeout(() => {
          this.connect().catch(() => {
            // Silently retry — will keep attempting
          });
        }, 3000);
      });

      this.ws.on("error", (err) => {
        if (!this._connected) {
          reject(err);
        }
        // If already connected, the close handler will trigger reconnect
      });
    });
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
