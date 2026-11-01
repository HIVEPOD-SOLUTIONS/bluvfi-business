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
CMD ["npm", "start"]
