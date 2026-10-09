/** Offline checks: capabilities, prompts, resources, config defaults and the static server card. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, VERSION } from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { buildServerCard } from "../src/servercard.ts";

test("versions agree: package.json, manifest.json, server.json, server", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const man = JSON.parse(readFileSync("manifest.json", "utf8"));
  const sj = JSON.parse(readFileSync("server.json", "utf8"));
  assert.equal(pkg.version, VERSION);
  assert.equal(man.version, VERSION);
  assert.equal(sj.version, VERSION);
  assert.equal(sj.packages[0].version, VERSION);
  assert.equal(sj.name, pkg.mcpName);
  assert.equal(sj.packages[0].identifier, pkg.name);
  assert.ok(sj.description.length <= 100);
});

test("empty or unsubstituted MCPB user_config values fall back to defaults", () => {
  const c = loadConfig({ PLUMBLINE_INDEXER_URL: "", PLUMBLINE_GRAPHQL_URL: "${user_config.graphql_url}", PLUMBLINE_TIMEOUT_MS: "" });
  assert.equal(c.indexerUrl, "https://deepbook-indexer.mainnet.mystenlabs.com");
  assert.equal(c.graphqlUrl, "https://graphql.mainnet.sui.io/graphql");
  assert.equal(c.timeoutMs, 8000);
  assert.equal(loadConfig({ PLUMBLINE_TIMEOUT_MS: "12000" }).timeoutMs, 12000);
});

test("prompts and resources are listed and readable", async () => {
  const server = createServer({ config: loadConfig() });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name).sort(), ["compare_pools", "liquidity_check", "market_snapshot"]);
  const p = await client.getPrompt({ name: "market_snapshot", arguments: { pool: "SUI_USDC" } });
  assert.match((p.messages[0].content as any).text, /SUI_USDC.*not financial advice/s);
  const { resources } = await client.listResources();
  assert.deepEqual(resources.map((r) => r.uri).sort(), ["plumbline://disclaimer", "plumbline://guide"]);
  const g = await client.readResource({ uri: "plumbline://guide" });
  assert.match((g.contents[0] as any).text, /BASE_QUOTE/);
  await client.close();
});

test("static server card lists tools with inputSchema and annotations", async () => {
  const card: any = await buildServerCard(null);
  assert.equal(card.serverInfo.version, VERSION);
  assert.equal(card.tools.length, 8);
  for (const t of card.tools) {
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.annotations.readOnlyHint, true);
    assert.ok(t.description.length > 20);
  }
  assert.equal(card.prompts.length, 3);
  assert.equal(card.resources.length, 2);
});
