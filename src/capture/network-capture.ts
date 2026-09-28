import type { CDPClient } from "./cdp-client.js";
import type { RequestStore } from "../store/request-store.js";
import type { CapturedFlow, CapturedRequest, CapturedResponse } from "./types.js";
import { compileIgnorePatterns, matchesAnyPattern } from "./url-filter.js";

export interface NetworkCaptureOptions {
  /** URL patterns (regex or literal) to drop before they reach the store — same semantics as `-i`. */
  ignoreUrls?: string[];
}

/**
 * Listens to CDP Network.* events and populates the RequestStore.
 * Eagerly fetches response bodies on loadingFinished so they aren't evicted.
 */
export class NetworkCapture {
  /** In-flight requests keyed by CDP requestId (string) */
  private inflight = new Map<string, CapturedFlow>();
  private ignorePatterns: RegExp[];

  constructor(
    private cdp: CDPClient,
    private store: RequestStore,
    options: NetworkCaptureOptions = {},
  ) {
    this.ignorePatterns = compileIgnorePatterns(options.ignoreUrls);
  }

  /** Enable network tracking and start capturing. */
  async start(): Promise<void> {
    this.cdp.onEvent((method, params) => {
      switch (method) {
        case "Network.requestWillBeSent":
          this.onRequestWillBeSent(params);
          break;
        case "Network.responseReceived":
          this.onResponseReceived(params);
          break;
        case "Network.loadingFinished":
          this.onLoadingFinished(params);
          break;
        case "Network.loadingFailed":
          this.onLoadingFailed(params);
          break;
      }
    });

    // Metro drops the Network domain with the socket (app reload, Metro restart):
    // re-enable it on every reconnect, and forget requests the old session left open.
    this.cdp.onConnected(async () => {
      this.inflight.clear();
      await this.enableNetworkDomain();
      console.error("[mobile-network-mcp] Reconnected to Metro — network capture re-enabled");
    });

    await this.enableNetworkDomain();
  }

  private enableNetworkDomain(): Promise<unknown> {
    return this.cdp.send("Network.enable", { maxTotalBufferSize: 10_000_000 });
  }

  private onRequestWillBeSent(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const req = params.request as Record<string, unknown>;
    const url = req.url as string;

    // Dropping here means the later response/finished events for this id find
    // nothing in `inflight` and are discarded too — no body fetch, no store entry.
    if (matchesAnyPattern(url, this.ignorePatterns)) return;

    const captured: CapturedRequest = {
      url,
      method: req.method as string,
      headers: (req.headers as Record<string, string>) ?? {},
      body: req.postData as string | undefined,
      timestamp: (params.wallTime as number) ?? Date.now() / 1000,
    };

    const flow: CapturedFlow = {
      id: 0, // assigned by store on commit
      request: captured,
      timing: { startTime: Date.now() },
    };

    this.inflight.set(requestId, flow);
  }

  private onResponseReceived(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const flow = this.inflight.get(requestId);
    if (!flow) return;

    const resp = params.response as Record<string, unknown>;
    const headers = (resp.headers as Record<string, string>) ?? {};

    // Estimate body size from Content-Length header if available
    const contentLength = headers["content-length"] ?? headers["Content-Length"];

    flow.response = {
      status: resp.status as number,
      statusText: (resp.statusText as string) ?? "",
      headers,
      mimeType: (resp.mimeType as string) ?? "",
      bodySize: contentLength ? parseInt(contentLength, 10) : 0,
      encodedDataLength: 0,
    };
  }

  private async onLoadingFinished(params: Record<string, unknown>): Promise<void> {
    const requestId = params.requestId as string;
    const flow = this.inflight.get(requestId);
    if (!flow) return;

    this.inflight.delete(requestId);

    flow.timing.endTime = Date.now();
    flow.timing.duration = flow.timing.endTime - flow.timing.startTime;

    if (flow.response) {
      flow.response.encodedDataLength = (params.encodedDataLength as number) ?? 0;

      // Eagerly fetch body before CDP evicts it
      try {
        const result = (await this.cdp.send("Network.getResponseBody", {
          requestId,
        })) as { body?: string; base64Encoded?: boolean } | undefined;

        if (result?.body) {
          if (result.base64Encoded) {
            // Store base64 bodies as-is — they're binary (images, etc.)
            flow.response.body = `[base64 encoded, ${result.body.length} chars]`;
          } else {
            flow.response.body = result.body;
            flow.response.bodySize = result.body.length;
            markIfTruncated(flow.response, result.body);
          }
        }
      } catch {
        // Body may not be available — that's okay
      }
    }

    this.store.add(flow);
  }

  private onLoadingFailed(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const flow = this.inflight.get(requestId);
    if (!flow) return;

    this.inflight.delete(requestId);

    flow.timing.endTime = Date.now();
    flow.timing.duration = flow.timing.endTime - flow.timing.startTime;

    // Store failed requests with a synthetic error response
    flow.response = {
      status: 0,
      statusText: (params.errorText as string) ?? "Network error",
      headers: {},
      mimeType: "",
      bodySize: 0,
      encodedDataLength: 0,
    };

    this.store.add(flow);
  }
}

/**
 * RN reports `encodedDataLength` as the number of body bytes it received. If the
 * body it hands back is shorter, the inspector's copy was cut. (A gzip'd
 * response reports its *compressed* length on some platforms — smaller than the
 * text — so a body longer than expected is never flagged.)
 */
function markIfTruncated(response: CapturedResponse, body: string): void {
  const expected = response.encodedDataLength;
  if (!expected) return;
  const captured = Buffer.byteLength(body, "utf8");
  if (captured < expected) {
    response.truncated = {
      capturedBytes: captured,
      expectedBytes: expected,
      reason: "React Native inspector stored a short copy of the body",
    };
  }
}
