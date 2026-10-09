#!/usr/bin/env bash
# Build a local MCPB bundle (for Smithery "Local (MCPB Bundle)" publishing). Local artifact only; publishes nothing.
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
rm -rf build/stage && mkdir -p build/stage
cp -r dist package.json package-lock.json manifest.json LICENSE README.md build/stage/
(cd build/stage && npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund >/dev/null)
npx -y @anthropic-ai/mcpb validate build/stage/manifest.json
npx -y @anthropic-ai/mcpb pack build/stage build/plumbline.mcpb
ls -lh build/plumbline.mcpb
