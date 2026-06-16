/**
 * Generates ready-to-paste MCP client config for adding this server to Claude
 * Code and Codex. Reflects the flags passed alongside --print-mcp-config (e.g.
 * --source, -d, -i, --ingest-port) so the chosen settings PERSIST in the config.
 */

const DEFAULT_IGNORE = "tracking|analytics|adtracker";

export interface McpConfigOptions {
  ingestPort: number;
  source?: string; // omitted from args when "ingest" (the default)
  domains?: string[];
  ignoreUrls?: string[];
}

/** The `args` array the MCP client launches the server with. */
function buildArgs(opts: McpConfigOptions): string[] {
  const args = ["-y", "mobile-network-mcp"];
  if (opts.source && opts.source !== "ingest") args.push("--source", opts.source);
  args.push("--ingest-port", String(opts.ingestPort));
  for (const d of opts.domains ?? []) args.push("-d", d);
  const ignores = opts.ignoreUrls && opts.ignoreUrls.length > 0 ? opts.ignoreUrls : [DEFAULT_IGNORE];
  for (const ig of ignores) args.push("-i", ig);
  return args;
}

/** Claude Code `.mcp.json` block. */
export function buildClaudeConfig(opts: McpConfigOptions): string {
  return JSON.stringify(
    { mcpServers: { "rn-network": { command: "npx", args: buildArgs(opts) } } },
    null,
    2,
  );
}

/** Codex `.codex/config.toml` block. */
export function buildCodexConfig(opts: McpConfigOptions): string {
  const args = buildArgs(opts)
    .map((a) => `"${a}"`)
    .join(", ");
  return `[mcp_servers.rn-network]
command = "npx"
args = [${args}]`;
}

/** Full help text printed by --print-mcp-config. */
export function buildMcpConfigHelp(opts: McpConfigOptions): string {
  return `# Add mobile-network-mcp to your MCP client (ingest port ${opts.ingestPort})

## Claude Code
Add to your project's .mcp.json (or run: claude mcp add):

${buildClaudeConfig(opts)}

## Codex
Add to .codex/config.toml:

${buildCodexConfig(opts)}

Tip: any flag you pass alongside --print-mcp-config (e.g. --source proxyman,
-d api.example.com) is baked into the args above, so the setting persists.
Restart the client after adding so it picks up the server.`;
}
