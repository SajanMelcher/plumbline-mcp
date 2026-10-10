import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig, type Config } from "./config.js";
import { DeepBookClient } from "./deepbook.js";
import { DISCLAIMER, registerTools } from "./tools.js";
import { registerPromptsAndResources } from "./prompts.js";
import type { PaymentRuntime } from "./payments.js";

export const NAME = "plumbline";
export const VERSION = "0.2.0";

// One shared client => one shared cache across sessions/transports.
let shared: DeepBookClient | undefined;

export function createServer(opts: { config?: Config; payments?: PaymentRuntime | null; clientId?: string } = {}): McpServer {
  const db = opts.config ? new DeepBookClient(opts.config) : (shared ??= new DeepBookClient(loadConfig()));
  const server = new McpServer(
    { name: NAME, title: "The Spice Melange Trading Desk: DeepBook market data connector", version: VERSION },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions:
        `The Spice Melange Trading Desk (DeepBook market data connector): read-only Sui DeepBook v3 market data (pools, mid, depth, volume, fees, trades, OHLCV). ` +
        `Pool names are BASE_QUOTE, e.g. SUI_USDC; call list_pools first if unsure. No keys, no wallets, no trading. ${DISCLAIMER}` +
        (opts.payments ? ` ${opts.payments.describe()}` : ""),
    },
  );
  registerTools(server, db, { payments: opts.payments, clientId: opts.clientId });
  registerPromptsAndResources(server);
  return server;
}

export default createServer;
