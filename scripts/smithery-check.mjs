#!/usr/bin/env node
/**
 * Offline pre-publish check for Smithery (publishes NOTHING).
 * Rebuilds the exact release payload that `smithery mcp publish <bundle.mcpb>` (CLI 4.x) derives from the bundle,
 * then validates it against Smithery's published OpenAPI `StdioDeployPayload` schema.
 * Usage: node scripts/smithery-check.mjs [build/plumbline.mcpb]
 */
import { readFileSync, statSync } from "node:fs";
import { unzipSync, strFromU8 } from "fflate";
import Ajv from "ajv";
import addFormats from "ajv-formats";

const bundlePath = process.argv[2] ?? "build/plumbline.mcpb";
const fail = (m) => (console.error(`FAIL: ${m}`), process.exit(1));

const size = statSync(bundlePath).size;
if (size > 25 * 1024 * 1024) fail(`bundle ${size} bytes exceeds Smithery's 25 MB limit`);
const files = unzipSync(readFileSync(bundlePath));
if (!files["manifest.json"]) fail("manifest.json not at archive root");
const m = JSON.parse(strFromU8(files["manifest.json"]));
if (!m.name || !m.version) fail("manifest needs name and version");
// Registry bug (smithery-ai/cli#770): a serverCard with only serverInfo fails with 400 "No values to set".
if (m.tools === undefined && m.prompts === undefined && m.resources === undefined) {
  fail('manifest has no "tools" key; Smithery rejects that with 400 "No values to set" (add "tools": [])');
}
if (m.tools !== undefined) {
  if (!Array.isArray(m.tools)) fail("manifest tools must be an array");
  for (const t of m.tools) if (!t.inputSchema) fail(`manifest tool "${t.name}" has no inputSchema; Smithery's ServerCard requires it (this caused the 400s)`);
}
if (!files[m.server?.entry_point]) fail(`entry_point ${m.server?.entry_point} missing from bundle`);
const runtime = m.server?.type === "python" ? "python" : m.server?.type === "node" ? "node" : m.server?.type === "binary" ? "binary" : fail("unknown runtime");

// Same shape as the CLI's bundle -> payload conversion.
const payload = {
  type: "stdio",
  runtime,
  serverCard: {
    serverInfo: { name: m.name, version: m.version },
    ...(m.tools ? { tools: m.tools } : {}),
    ...(m.prompts ? { prompts: m.prompts } : {}),
    ...(m.resources ? { resources: m.resources } : {}),
  },
};

const res = await fetch("https://smithery.ai/docs/openapi.json");
if (!res.ok) fail(`could not fetch Smithery OpenAPI (${res.status})`);
const spec = await res.json();
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
// OpenAPI uses a draft-04 style string "id" on some schemas; Ajv 8 rejects it, so strip string-valued "id" keys.
const clean = (v) => (Array.isArray(v) ? v.map(clean) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).filter(([k, x]) => !(k === "id" && typeof x === "string")).map(([k, x]) => [k, clean(x)])) : v);
ajv.addSchema({ $id: "smithery", components: clean(spec.components) });
const validate = ajv.compile({ $ref: "smithery#/components/schemas/StdioDeployPayload" });
if (!validate(payload)) fail(`payload rejected by StdioDeployPayload schema:\n${JSON.stringify(validate.errors, null, 2)}`);

console.log(`OK: ${bundlePath} (${(size / 1048576).toFixed(1)} MB, ${Object.keys(files).length} files)`);
console.log(`payload: ${JSON.stringify(payload)}`);
