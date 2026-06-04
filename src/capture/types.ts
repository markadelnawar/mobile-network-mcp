export interface CapturedRequest {
  url: string;
  method: string;
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
  encodedDataLength: number;
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
}

export interface CDPTarget {
  id: string;
  title: string;
  type: string;
  webSocketDebuggerUrl?: string;
  devtoolsFrontendUrl?: string;
}
