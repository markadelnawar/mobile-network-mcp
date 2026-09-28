import { CDPClient, isNetworkDomainUnsupported, type CDPClientLike } from "./cdp-client.js";
import { NetworkCapture } from "./network-capture.js";
import type { RequestStore } from "../store/request-store.js";

export { isNetworkDomainUnsupported };

export type CdpState = "connecting" | "connected" | "reconnecting" | "unsupported";

export interface CdpStatus {
  state: CdpState;
  /** Connect attempts so far (1-based once the loop has started). */
  attempts: number;
  /** Last failure or the reason CDP is unavailable. */
  detail?: string;
}

export interface CdpSourceOptions {
  store: RequestStore;
  metroHost: string;
  metroPort: number;
  ignoreUrls?: string[];
  retryDelayMs?: number;
  log?: (line: string) => void;
  /** Test seam — defaults to a real CDPClient. */
  createClient?: () => CDPClientLike;
}

export interface CdpSourceHandle {
  status(): CdpStatus;
  stop(): Promise<void>;
  /** Resolves when the startup loop ends: connected, unsupported, or stopped. */
  done: Promise<void>;
}

const DEFAULT_RETRY_DELAY_MS = 3000;
const ENABLE_ATTEMPTS = 3;

/**
 * Attach to Metro's inspector and capture `Network.*` events into the store.
 *
 * This loop drives `connect()` until it succeeds once — MCP clients launch the
 * server at session start, usually before the developer has started the app.
 * From the first connection on, CDPClient owns reconnection (app relaunch,
 * Metro restart) and NetworkCapture re-enables the domain via onConnected, so
 * the loop ends there. It also ends when the runtime says the Network domain
 * does not exist (React Native < 0.83): retrying would never help, and the
 * ingest server remains the way in.
 */
export function startCdpSource(opts: CdpSourceOptions): CdpSourceHandle {
  const log = opts.log ?? ((line: string) => console.error(`[mobile-network-mcp] ${line}`));
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const sleep = () => new Promise((r) => setTimeout(r, retryDelayMs));
  const where = `${opts.metroHost}:${opts.metroPort}`;
  const cdp = (opts.createClient ?? (() => new CDPClient(opts.metroPort, opts.metroHost, { log })))();
  const capture = new NetworkCapture(cdp, opts.store, { ignoreUrls: opts.ignoreUrls });
  const status: CdpStatus = { state: "connecting", attempts: 0 };
  let stopped = false;

  cdp.onDisconnected(() => {
    if (stopped) return;
    status.state = "reconnecting";
    status.detail = "Metro closed the debugger socket (app relaunch or Metro restart)";
    log(`Lost the Metro debugger socket on ${where} — reconnecting`);
  });
  cdp.onConnected(() => {
    status.state = "connected";
    status.detail = undefined;
  });

  const done = (async () => {
    for (;;) {
      if (stopped) return;
      status.attempts++;
      try {
        await cdp.connect();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        status.detail = message;
        // Log the first few failures and then every 20th (~1/min at 3s) so a missing app doesn't flood stderr.
        if (status.attempts <= 3 || status.attempts % 20 === 0) {
          log(`Metro connection attempt ${status.attempts} failed: ${message} — retrying every ${retryDelayMs / 1000}s`);
        }
        await sleep();
        continue;
      }

      // Connected. Enable the Network domain; from here on reconnection belongs to the client.
      for (let enableAttempt = 1; enableAttempt <= ENABLE_ATTEMPTS; enableAttempt++) {
        if (stopped) return;
        try {
          await capture.start();
          status.state = "connected";
          status.detail = undefined;
          log(`Connected to Metro on ${where}${status.attempts > 1 ? ` (attempt ${status.attempts})` : ""}`);
          return;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (isNetworkDomainUnsupported(err)) {
            status.state = "unsupported";
            status.detail = `the runtime has no CDP Network domain (React Native < 0.83): ${message}`;
            log(
              `CDP capture unavailable — ${status.detail}. Flows still arrive through the ingest server: ` +
                `add interceptor.js to the app or paste the Proxyman script (--print-proxyman-script).`,
            );
            await cdp.disconnect();
            return;
          }
          if (!cdp.connected) {
            status.state = "reconnecting";
            status.detail = `socket dropped while enabling capture (${message}); it will be re-enabled on reconnect`;
            log(status.detail);
            return;
          }
          log(`Network.enable failed (${message}) — retry ${enableAttempt}/${ENABLE_ATTEMPTS}`);
          await sleep();
        }
      }
      status.state = "reconnecting";
      status.detail = "Network.enable kept failing on an open socket; capture resumes if Metro reconnects";
      log(status.detail);
      return;
    }
  })();

  return {
    status: () => ({ ...status }),
    stop: async () => {
      stopped = true;
      await cdp.disconnect();
    },
    done,
  };
}
