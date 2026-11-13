FROM node:22-slim AS build
WORKDIR /src
COPY . .
RUN npm ci --no-audit --no-fund && npm run build && npm run package

FROM node:22-slim
ENV NODE_ENV=production ABRIDGE_HOST=0.0.0.0 ABRIDGE_PORT=8765 ABRIDGE_DB=/data/server.db
WORKDIR /app
COPY --from=build /src/.local/release/server/ ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && mkdir /data && chown node:node /data
USER node
EXPOSE 8765
CMD ["node", "cli.js", "serve"]
