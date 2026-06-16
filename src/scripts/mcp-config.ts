/**
 * Generates ready-to-paste MCP client config for adding this server to Claude
 * Code and Codex, with the ingest port set as an explicit CLI arg. Emitted by
 * `mobile-network-mcp --print-mcp-config`.
 */

const DEFAULT_IGNORE = "tracking|analytics|adtracker";

/** Claude Code `.mcp.json` block. */
export function buildClaudeConfig(port: number): string {
  return JSON.stringify(
    {
      mcpServers: {
        "rn-network": {
          command: "npx",
          args: ["-y", "mobile-network-mcp", "--ingest-port", String(port), "-i", DEFAULT_IGNORE],
        },
      },
    },
    null,
    2,
  );
}

/** Codex `.codex/config.toml` block. */
export function buildCodexConfig(port: number): string {
  return `[mcp_servers.rn-network]
command = "npx"
args = ["-y", "mobile-network-mcp", "--ingest-port", "${port}", "-i", "${DEFAULT_IGNORE}"]`;
}

/** Full help text printed by --print-mcp-config. */
export function buildMcpConfigHelp(port: number): string {
  return `# Add mobile-network-mcp to your MCP client (ingest port ${port})

## Claude Code
Add to your project's .mcp.json (or run: claude mcp add):

${buildClaudeConfig(port)}

## Codex
Add to .codex/config.toml:

${buildCodexConfig(port)}

Tip: change --ingest-port to run on a different port, and edit the -i regex to
ignore noisy URLs. After adding, restart the client so it picks up the server.`;
}
