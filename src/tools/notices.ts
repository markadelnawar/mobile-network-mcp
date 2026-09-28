import type { CapturedFlow } from "../capture/types.js";

/**
 * Warning line for responses the capture source delivered incompletely.
 * Shared by the response tools so the AI sees the same caveat everywhere.
 */
export function truncationNotice(flow: CapturedFlow): string {
  const t = flow.response?.truncated;
  if (!t) return "";
  const missing = t.expectedBytes - t.capturedBytes;
  const repaired = flow._jsonRepaired
    ? " JSON was auto-repaired so schema/query still work, but the last value(s) may be cut short and anything after the cut is missing."
    : "";
  return `⚠ Body truncated by the capture source: ${t.capturedBytes} of ${t.expectedBytes} bytes captured (${missing} missing; ${t.reason}).${repaired}\n\n`;
}
