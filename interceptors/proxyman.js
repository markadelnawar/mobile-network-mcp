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

async function onResponse(context, url, request, response) {
  try {
    await $http.post(INGEST_URL, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          url: url,
          method: request.method,
          headers: request.headers,
          body: request.body,
        },
        response: {
          status: response.statusCode,
          statusText: "",
          headers: response.headers,
          body: response.body,
        },
      }),
    });
  } catch (e) {
    // Silently ignore — MCP server may not be running
  }

  return response;
}
