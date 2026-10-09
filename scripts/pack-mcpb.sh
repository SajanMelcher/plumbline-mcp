#!/usr/bin/env bash
# Build build/plumbline.mcpb for Smithery "Local (MCPB Bundle)" publishing, then validate it. Publishes nothing.
# The old bundle is deleted first, so a failed step can never leave a stale bundle behind.
set -euo pipefail
cd "$(dirname "$0")/.."
MCPB=./node_modules/.bin/mcpb
[ -x "$MCPB" ] || { echo "Run npm install first (missing @anthropic-ai/mcpb devDependency)"; exit 1; }

rm -rf build/stage build/plumbline.mcpb
npm run build
mkdir -p build/stage
cp -r dist package.json package-lock.json manifest.json icon.png LICENSE README.md build/stage/
(cd build/stage && npm ci --omit=dev --omit=peer --ignore-scripts --no-audit --no-fund >/dev/null)
"$MCPB" validate build/stage/manifest.json
"$MCPB" pack build/stage build/plumbline.mcpb
node scripts/smithery-check.mjs build/plumbline.mcpb
ls -l --time-style=+%H:%M:%S build/plumbline.mcpb
sha256sum build/plumbline.mcpb
