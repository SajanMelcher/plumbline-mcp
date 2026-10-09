/**
 * Smoke test: spawns the built server (stdio by default, or --http) and calls every tool via the official MCP client.
 * Usage: npm run smoke   |   npm run smoke:http
 */
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const useHttp = process.argv.includes("--http");
const POOL = process.env.SMOKE_POOL ?? "SUI_USDC";

const calls: [string, Record<string, unknown>][] = [
  ["list_pools", { asset: "SUI" }],
  ["get_mid_price", { pool: POOL }],
  ["get_order_book", { pool: POOL, levels: 5, within_pct: [0.5, 1, 2] }],
  ["get_volume", { pool: POOL }],
  ["get_volume", { top: 5 }],
  ["get_volume", { pool: POOL, window_hours: 6 }],
  ["get_pool_params", { pool: POOL }],
  ["get_recent_trades", { pool: POOL, limit: 5 }],
  ["get_ohlcv", { pool: POOL, interval: "1h", limit: 5 }],
  ["get_indexer_status", {}],
  // expected, friendly errors:
  ["get_mid_price", { pool: "USDC_SUI" }],
  ["get_order_book", { pool: POOL, levels: 0 }],
];

async function main() {
  const client = new Client({ name: "plumbline-smoke", version: "0.0.0" });
  let child: ReturnType<typeof spawn> | undefined;
  if (useHttp) {
    const port = 18000 + Math.floor(Math.random() * 1000);
    child = spawn(process.execPath, ["dist/index.js", "--http", "--port", String(port)], { stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child!.stderr!.on("data", (d) => String(d).includes("streamable HTTP") && resolve());
      setTimeout(() => reject(new Error("HTTP server did not start")), 8000);
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  } else {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: ["dist/index.js"], stderr: "ignore" }));
  }

  const { tools } = await client.listTools();
  console.log(`transport=${useHttp ? "http" : "stdio"} tools=${tools.length}: ${tools.map((t) => t.name).join(", ")}`);
  let failures = 0;
  for (const [name, args] of calls) {
    const t0 = Date.now();
    let text = "";
    let isError = false;
    try {
      const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
      text = res.content.map((c) => c.text).join("\n");
      isError = Boolean(res.isError);
    } catch (err) {
      text = `protocol error: ${(err as Error).message}`;
      isError = true;
    }
    const expectError = name === "get_mid_price" && args.pool === "USDC_SUI" || (name === "get_order_book" && args.levels === 0);
    const pass = expectError ? isError : !isError;
    if (!pass) failures++;
    console.log(`\n[${pass ? "PASS" : "FAIL"}] ${name} ${JSON.stringify(args)} (${Date.now() - t0} ms, ${text.length} chars)${expectError ? " [expected error]" : ""}`);
    console.log(text.length > 1500 ? text.slice(0, 1500) + " …" : text);
  }
  await client.close();
  child?.kill();
  console.log(`\nSmoke ${failures ? "FAILED" : "OK"}: ${calls.length - failures}/${calls.length} passed`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
