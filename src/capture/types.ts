export interface CapturedRequest {
  url: string;
  method: string;
  // (mark) btw this doesnt handle the mutliple headers cases , multiple set-cookies for example
  headers: Record<string, string>;
  body?: string;
  timestamp: number;
}

export interface CapturedResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  mimeType: string;
  body?: string;
  bodySize: number;
  // compressed
  encodedDataLength: number;
  /**
   * Set when the capture source handed us fewer body bytes than the response
   * really had — e.g. RN 0.87 iOS's inspector drops the tail of any body with
   * non-ASCII text (RCTNetworkConversions.h sizes the UTF-8 copy by UTF-16 length).
   */
  truncated?: { capturedBytes: number; expectedBytes: number; reason: string };
}

export interface CapturedFlow {
  id: number;
  request: CapturedRequest;
  response?: CapturedResponse;
  timing: {
    startTime: number;
    endTime?: number;
    duration?: number;
  };
  /** Lazily parsed JSON body — populated on first schema/query access */
  _parsedJson?: unknown;
  _jsonParseAttempted?: boolean;
  /** True when `_parsedJson` came from repairing a truncated body (see store/json-repair.ts). */
  _jsonRepaired?: boolean;
}

export interface CDPTarget {
  id: string;
  title: string;
  type: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}
