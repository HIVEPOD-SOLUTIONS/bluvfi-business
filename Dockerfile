FROM node:22-alpine
ENV NEXT_TELEMETRY_DISABLED=1
# Runs as the unprivileged "node" user, not root. /app belongs to it so the app can write its .data folder and, during
# browser setup, its .env.local.
RUN mkdir -p /app/.data && chown -R node:node /app
WORKDIR /app
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
RUN npm run build
ENV NODE_ENV=production PORT=3000
# Records live here: mount a volume so they survive restarts. Several instances may share one volume (a ReadWriteMany
# volume, EFS or NFS): writes are locked and each instance re-reads what another wrote (lib/shared-file.ts).
# Secrets come from the environment, never the image.
VOLUME /app/.data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
# BLUVFI_DEMO=1 serves the hosted demo (fixtures, no keys, no funds); otherwise the mainnet app.
CMD ["sh", "-c", "if [ \"$BLUVFI_DEMO\" = 1 ]; then npm run demo:serve; else npm start; fi"]
