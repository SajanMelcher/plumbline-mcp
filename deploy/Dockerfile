# Image for HOSTING Plumbline over streamable HTTP (Fly.io / Render / any container host).
# The root Dockerfile stays the stdio image for Smithery. Build from the repo root:
#   docker build -f deploy/Dockerfile .
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
RUN apk add --no-cache tini su-exec
WORKDIR /app
ENV NODE_ENV=production TRANSPORT=http HOST=0.0.0.0 PORT=8080
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md ./
COPY deploy/entrypoint.sh /usr/local/bin/plumbline-entrypoint
RUN chmod 0755 /usr/local/bin/plumbline-entrypoint
EXPOSE 8080
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/plumbline-entrypoint"]
