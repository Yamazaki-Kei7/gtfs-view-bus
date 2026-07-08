FROM node:22-slim

WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY pipeline/package.json pipeline/package.json
COPY packages/gtfs-core/package.json packages/gtfs-core/package.json

RUN pnpm install --frozen-lockfile

COPY pipeline pipeline
COPY packages/gtfs-core packages/gtfs-core

WORKDIR /workspace/pipeline

ENV NODE_ENV=production
ENV PORT=8080
ENV R2_BASE_URL=http://r2.internal

EXPOSE 8080

CMD ["pnpm", "exec", "tsx", "container-app/src/server.ts"]
