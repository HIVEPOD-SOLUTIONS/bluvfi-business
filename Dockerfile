# Bluvfi Business: one image for the hosted demo and the live app. Which one runs is decided when the container starts
# (BLUVFI_DEMO=1 for the demo), not at build time: no page reads a setting at build, so the same image serves both.
# Build: docker build -t bluvfi-business .   Deploy on EC2: docs/DEPLOY.md
FROM node:22-alpine
ENV NEXT_TELEMETRY_DISABLED=1
# Runs as the unprivileged "node" user (uid 1000), not root. /app belongs to it so the app can write its .data folder
# and, during browser setup, its .env.local.
RUN mkdir -p /app/.data && chown -R node:node /app
WORKDIR /app
USER node
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node scripts/only-npm.cjs ./scripts/only-npm.cjs
# Dev dependencies stay installed: the demo launcher and the background zero-knowledge prover run with tsx.
RUN npm ci --no-audit --no-fund
COPY --chown=node:node . .
RUN npm run build
ARG GIT_SHA=unknown
ENV NODE_ENV=production PORT=3000 BLUVFI_VERSION=$GIT_SHA
LABEL org.opencontainers.image.source="https://github.com/HIVEPOD-SOLUTIONS/bluvfi-business" \
      org.opencontainers.image.revision=$GIT_SHA \
      org.opencontainers.image.licenses="MIT"
# Records live here: mount a volume so they survive restarts and redeploys. Several instances may share one volume
# (a ReadWriteMany volume, EFS or NFS): writes are locked and each instance re-reads what another wrote (lib/shared-file.ts).
# Secrets come from the environment or a mounted /app/.env.local, never the image.
VOLUME /app/.data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" >/dev/null || exit 1
# BLUVFI_DEMO=1 serves the hosted demo (fixtures, no keys, no funds); otherwise the mainnet app.
# exec: the app itself receives docker stop's SIGTERM, instead of a shell that ignores it until it is killed.
CMD ["sh", "-c", "if [ \"$BLUVFI_DEMO\" = 1 ]; then exec npm run demo:serve; else exec npm start; fi"]
