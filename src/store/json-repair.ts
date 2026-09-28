/**
 * Best-effort recovery of JSON whose *tail* was cut off — e.g. by the React
 * Native 0.87 iOS inspector, which sizes its UTF-8 copy of the body with the
 * UTF-16 length (RCTNetworkConversions.h) and so drops a few hundred bytes from
 * any response containing non-ASCII text.
 *
 * Strategy: close whatever strings/arrays/objects are still open; if that does
 * not parse, drop the trailing partial token (back to the previous `,` / `[` /
 * `{` outside strings) and try again. Bounded, deterministic, no dependencies.
 * The result is a prefix of the real document: everything up to the cut is
 * exact, the last value may be shortened, and anything after the cut is gone.
 */
export interface RepairedJson {
  value: unknown;
  /** Characters removed from the end of the input before it could be closed. */
  droppedChars: number;
}

const MAX_ATTEMPTS = 64;

export function repairTruncatedJson(text: string): RepairedJson | undefined {
  let candidate = text.trimEnd();
  const first = candidate.trimStart()[0];
  if (first !== "{" && first !== "[") return undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && candidate.length > 0; attempt++) {
    const closed = closeOpenStructures(candidate);
    if (closed !== undefined) {
      try {
        return { value: JSON.parse(closed), droppedChars: text.trimEnd().length - candidate.length };
      } catch {
        // fall through and cut further back
      }
    }
    const cut = lastSeparatorOutsideStrings(candidate);
    if (cut <= 0) return undefined;
    candidate = candidate.slice(0, cut).trimEnd();
  }
  return undefined;
}

interface ScanState {
  stack: string[];
  inString: boolean;
  escaped: boolean;
}

function scan(text: string, onSeparator?: (index: number, ch: string) => void): ScanState {
  const state: ScanState = { stack: [], inString: false, escaped: false };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (state.inString) {
      if (state.escaped) state.escaped = false;
      else if (ch === "\\") state.escaped = true;
      else if (ch === '"') state.inString = false;
      continue;
    }
    if (ch === '"') state.inString = true;
    else if (ch === "{" || ch === "[") {
      state.stack.push(ch);
      onSeparator?.(i, ch);
    } else if (ch === "}" || ch === "]") state.stack.pop();
    else if (ch === ",") onSeparator?.(i, ch);
  }
  return state;
}

/** Append the closers needed to make `text` well-formed, or undefined if it ends on a dangling `:`. */
function closeOpenStructures(text: string): string | undefined {
  const state = scan(text);
  let out = text;
  if (state.inString) {
    if (state.escaped) return undefined; // cut right after a backslash — caller trims further
    out += '"';
  }
  out = out.trimEnd();
  if (out.endsWith(",")) out = out.slice(0, -1).trimEnd();
  if (out.endsWith(":")) return undefined;
  for (let i = state.stack.length - 1; i >= 0; i--) {
    out += state.stack[i] === "{" ? "}" : "]";
  }
  return out;
}

/** Index to slice to so the trailing partial token is removed: before the last `,`, or just after the last `[`/`{`. */
function lastSeparatorOutsideStrings(text: string): number {
  let cut = -1;
  scan(text, (index, ch) => {
    cut = ch === "," ? index : index + 1;
  });
  // Never cut to an empty prefix, and never cut *inside* the last separator we found if it's the only char.
  return cut > 0 ? cut : -1;
}
