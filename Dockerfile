FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/simulation-engine/package.json ./packages/simulation-engine/package.json
RUN npm ci

FROM dependencies AS build
COPY . .
RUN npm run build

FROM dependencies AS production-dependencies
RUN npm ci --omit=dev --workspace @shlab/api --workspace @shlab/engine

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=:: PORT=8080 DATABASE_MODE=server
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=node:node /app/apps/api ./apps/api
COPY --from=production-dependencies --chown=node:node /app/packages/simulation-engine ./packages/simulation-engine
COPY --from=production-dependencies --chown=node:node /app/apps/web/package.json ./apps/web/package.json
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/apps/api/src ./apps/api/src
COPY --from=build --chown=node:node /app/apps/api/migrations ./apps/api/migrations
COPY --from=build --chown=node:node /app/packages/simulation-engine/src ./packages/simulation-engine/src
COPY --from=build --chown=node:node /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /backup-status && chown node:node /backup-status
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
