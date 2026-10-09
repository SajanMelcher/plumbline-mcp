#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer, NAME, VERSION } from "./server.js";
import { createPaymentRuntime, loadPaymentConfig, type PaymentRuntime } from "./payments.js";

const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    `${NAME} ${VERSION} - read-only DeepBook v3 market data MCP server\n\n` +
      `Usage: plumbline-mcp [--http] [--port N] [--host H]\n` +
      `  (default)   stdio transport\n` +
      `  --http      streamable HTTP transport at POST /mcp (stateless); GET /health\n` +
      `Env: PORT, HOST (default 127.0.0.1), PLUMBLINE_INDEXER_URL, PLUMBLINE_GRAPHQL_URL, PLUMBLINE_TIMEOUT_MS\n` +
      `Optional Sui USDC pay-per-call (off by default): PLUMBLINE_PAYMENTS=1, PAYTO_ADDRESS (receive-only Sui address),\n` +
      `  PLUMBLINE_SUI_NETWORK (testnet|mainnet), PLUMBLINE_PRICE_USDC, PLUMBLINE_MIN_PAYMENT_USDC, PLUMBLINE_FREE_CALLS_PER_DAY,\n` +
      `  PLUMBLINE_PAYMENT_MAX_AGE_SEC, PLUMBLINE_PAYMENTS_ALLOW_MAINNET, PLUMBLINE_REDEEMED_FILE, PLUMBLINE_TRUST_PROXY\n`,
  );
  process.exit(0);
}

const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

function clientIdFor(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(",")[0]?.trim();
    if (first) return `ip:${first}`;
  }
  return `ip:${req.socket.remoteAddress ?? "unknown"}`;
}

async function main() {
  const payCfg = loadPaymentConfig();
  let payments: PaymentRuntime | null = null;
  if (payCfg) {
    payments = createPaymentRuntime(payCfg);
    process.stderr.write(`Payments ENABLED (${payCfg.network}, scheme sui-digest): ${payments.describe()}\n`);
  }
  if (!args.includes("--http") && process.env.TRANSPORT !== "http") {
    const server = createServer({ payments, clientId: "stdio" });
    await server.connect(new StdioServerTransport());
    process.stderr.write(`${NAME} ${VERSION} running on stdio (read-only)\n`);
    return;
  }

  const port = Number(flag("--port") ?? process.env.PORT ?? 8081);
  const host = flag("--host") ?? process.env.HOST ?? "127.0.0.1";
  const http = createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, name: NAME, version: VERSION }));
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: "Not found. MCP endpoint is POST /mcp" }));
      return;
    }
    if (req.method !== "POST") {
      // Stateless server: no SSE stream / session resumption.
      res.writeHead(405, { allow: "POST", "content-type": "application/json" }).end(
        JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server; use POST)" }, id: null }),
      );
      return;
    }
    try {
      const body = await readBody(req);
      const server = createServer({ payments, clientId: clientIdFor(req, payCfg?.trustProxy ?? false) });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(400, { "content-type": "application/json" }).end(
          JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: `Bad request: ${(err as Error).message}` }, id: null }),
        );
      }
    }
  });
  http.listen(port, host, () => process.stderr.write(`${NAME} ${VERSION} streamable HTTP on http://${host}:${port}/mcp (read-only)\n`));
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
