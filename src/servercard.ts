import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, NAME, VERSION } from "./server.js";
import type { PaymentRuntime } from "./payments.js";

/**
 * Static server card (SEP-1649), served at /.well-known/mcp/server-card.json in HTTP mode.
 * Registries such as Smithery read it when they cannot scan a server. Built from the live server, so it never drifts.
 */
export async function buildServerCard(payments: PaymentRuntime | null): Promise<Record<string, unknown>> {
  const server = createServer({ payments, clientId: "server-card" });
  const client = new Client({ name: "server-card", version: VERSION });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    const [{ tools }, { prompts }, { resources }] = await Promise.all([client.listTools(), client.listPrompts(), client.listResources()]);
    return {
      serverInfo: {
        name: NAME,
        title: "The Spice Melange Trading Desk: DeepBook market data connector (read-only)",
        version: VERSION,
        description: "Free, read-only Sui DeepBook v3 market data for AI agents. No keys, no wallet. Education only, not financial advice.",
        websiteUrl: "https://github.com/SajanMelcher/plumbline-mcp",
      },
      authentication: { required: false },
      tools,
      prompts,
      resources,
    };
  } finally {
    await client.close();
    await server.close();
  }
}
