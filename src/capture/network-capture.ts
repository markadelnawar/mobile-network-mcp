import type { CDPClient } from "./cdp-client.js";
import type { RequestStore } from "../store/request-store.js";
import type { CapturedFlow, CapturedRequest, CapturedResponse } from "./types.js";

/**
 * Listens to CDP Network.* events and populates the RequestStore.
 * Eagerly fetches response bodies on loadingFinished so they aren't evicted.
 */
export class NetworkCapture {
  /** In-flight requests keyed by CDP requestId (string) */
  private inflight = new Map<string, CapturedFlow>();

  constructor(
    private cdp: CDPClient,
    private store: RequestStore,
  ) {}

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

    await this.cdp.send("Network.enable", { maxTotalBufferSize: 10_000_000 });
  }

  private onRequestWillBeSent(params: Record<string, unknown>): void {
    const requestId = params.requestId as string;
    const req = params.request as Record<string, unknown>;

    const captured: CapturedRequest = {
      url: req.url as string,
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
