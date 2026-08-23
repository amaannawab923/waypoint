FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
# Reuse the build stage's node_modules instead of a second `npm ci` here —
# it already installed the full dependency set (build stage sets no
# NODE_ENV, so nothing was omitted), and this avoids installing the exact
# same thing twice. This also sidesteps a real fragility the previous
# version of this Dockerfile had: NODE_ENV=production was set *after*
# `npm ci` specifically so npm wouldn't treat it as an implicit
# --omit=dev, which is correct but depends on line order — moving the ENV
# line up (e.g. during a merge) would silently drop drizzle-kit and tsx,
# the devDependencies the entrypoint needs at container start to run
# migrations and the seed-if-empty check. Copying the already-built
# node_modules removes that ordering dependency entirely.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# drizzle-kit's `migrate` reads drizzle.config.ts, which points at the
# TypeScript schema source (see drizzle.config.ts) — keep src/ alongside
# dist/ in this image rather than only shipping compiled output, so the
# entrypoint's migration step resolves the exact same config as local dev.
COPY src ./src
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh && chown -R node:node /app

USER node
EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
