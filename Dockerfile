# syntax=docker/dockerfile:1

FROM node:24-slim AS deps
WORKDIR /app
RUN corepack enable pnpm
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable pnpm
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# adapter-node's default request body limit (512K) rejects photo uploads.
# The attachment route enforces its own per-file limit; this is just the global ceiling.
ENV BODY_SIZE_LIMIT=1G
RUN corepack enable pnpm && groupadd -r app && useradd -r -g app app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
RUN pnpm prune --prod
COPY --from=build /app/build ./build
COPY migrations ./migrations
COPY skills/defaults ./skills/defaults
RUN mkdir -p /data /memory /skills /documents /workspaces && chown -R app:app /data /memory /skills /documents /workspaces
VOLUME ["/data", "/memory", "/skills", "/documents", "/workspaces"]
EXPOSE 3000
USER app
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "build"]
