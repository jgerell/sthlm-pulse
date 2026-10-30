# Builds the web app, then runs the server, which serves the API and the built site.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps apps
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev -w @sthlm-pulse/server && npm cache clean --force
COPY apps/server apps/server
COPY --from=build /app/apps/web/dist apps/web/dist
# GTFS downloads and caches; mounted as a volume so they survive restarts.
RUN mkdir data && chown node:node data
USER node
EXPOSE 4280
CMD ["node_modules/.bin/tsx", "apps/server/src/index.ts"]
