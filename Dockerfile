FROM node:22-slim AS build
WORKDIR /src
COPY . .
RUN npm install --ignore-scripts --no-audit --no-fund && npm run build && npm run package

FROM node:22-slim
LABEL org.opencontainers.image.source="https://github.com/xerrors/aBridge" \
      org.opencontainers.image.description="aBridge MCP and device gateway" \
      org.opencontainers.image.licenses="Apache-2.0"
ENV NODE_ENV=production ABRIDGE_HOST=0.0.0.0 ABRIDGE_PORT=8765 ABRIDGE_DB=/data/server.db
WORKDIR /app
COPY --from=build /src/.local/release/server/ ./
RUN npm ci --omit=dev --no-audit --no-fund \
    && mkdir /data && chown node:node /data
USER node
EXPOSE 8765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8765/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "cli.js", "serve"]
