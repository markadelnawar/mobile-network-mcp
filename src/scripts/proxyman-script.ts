/**
 * Generates the Proxyman scripting-tool interceptor with the ingest port baked in.
 * Emitted by `mobile-network-mcp --print-proxyman-script` for copy-paste into
 * Proxyman → Tools → Scripting. Keeps the user from hand-editing the port (and
 * from hitting the `[object Object]` body bug — bodies are stringified here).
 */
export function buildProxymanScript(port: number): string {
  return `/**
 * mobile-network-mcp — Proxyman scripting interceptor (generated)
 *
 * Setup:
 *   1. Open Proxyman -> Tools -> Scripting, and enable the Scripting Tool
 *   2. New script (Cmd+N): set URL to "*" and check both Request and Response
 *   3. Paste this whole script, then Save (Cmd+S)
 *
 * Posts captured flows to this machine's MCP ingest server on port ${port}.
 */

const INGEST_URL = "http://localhost:${port}/flows";

// Proxyman hands JSON bodies to the script as PARSED objects/arrays, but the
// ingest contract expects a string. Re-serialize anything that isn't already a
// string so JSON bodies survive (otherwise they become "[object Object]").
function asString(body) {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  try {
    return JSON.stringify(body);
  } catch (e) {
    return String(body);
  }
}

async function onResponse(context, url, request, response) {
  try {
    await $http.post(INGEST_URL, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          url: url,
          method: request.method,
          headers: request.headers,
          body: asString(request.body),
        },
        response: {
          status: response.statusCode,
          statusText: "",
          headers: response.headers,
          body: asString(response.body),
        },
      }),
    });
  } catch (e) {
    // Silently ignore — MCP server may not be running
  }

  return response;
}
`;
}
