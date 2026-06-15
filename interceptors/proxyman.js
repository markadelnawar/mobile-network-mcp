/**
 * mobile-network-mcp — Proxyman scripting interceptor
 *
 * Setup:
 *   1. Open Proxyman → Tools → Scripting
 *   2. Enable Scripting Tool
 *   3. Create a new script (Cmd+N)
 *   4. Set URL to: *
 *   5. Check both "Request" and "Response"
 *   6. Paste this entire file into the script editor
 *   7. Save (Cmd+S)
 *
 * The MCP server's ingest API must be running (default: localhost:7890).
 * Adjust INGEST_URL below if using a different port.
 */

const INGEST_URL = "http://localhost:7890/flows";

// Proxyman hands JSON bodies to the script as PARSED objects/arrays, but the
// ingest contract expects body to be a STRING. Re-serialize anything that
// isn't already a string so JSON bodies survive intact (otherwise the server
// would turn them into "[object Object]" or comma-joined text).
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
      headers: {
        "Content-Type": "application/json"
      },
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
