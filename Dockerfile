FROM node:22-bookworm-slim

# better-sqlite3 needs a native build toolchain as a fallback when no
# prebuilt binary matches the container's platform/architecture.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
ENV DB_PATH=/data/finance.db
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
