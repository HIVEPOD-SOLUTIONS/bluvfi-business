FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
ENV NODE_ENV=production PORT=3000
# State snapshot lives here; mount a volume so it survives restarts. Secrets come from the environment, never the image.
VOLUME /app/.data
EXPOSE 3000
# BLUVFI_DEMO=1 serves the hosted demo (fixtures, no keys, no funds); otherwise the mainnet app.
CMD ["sh", "-c", "if [ \"$BLUVFI_DEMO\" = 1 ]; then npm run demo:serve; else npm start; fi"]
