# GlotKids API (Coolify). One process, one data folder (/data, a persistent
# volume): docs/URETIM-KURULUMU.md. Deployed with docker-compose.yml, which
# pins the hostname so a crashed container's server.lock can be taken over.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY builtin ./builtin
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
# node itself is PID 1: it gets SIGTERM and releases server.lock (src/storage/lock.ts)
CMD ["node", "dist/server.js"]
