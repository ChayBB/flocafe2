FROM oven/bun:1 AS base
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
USER bun
CMD ["bun","run","apps/api/src/index.ts"]
