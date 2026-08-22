FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app

COPY package.json package-lock.json ./
# NODE_ENV must not be set to "production" yet here — npm treats that as an
# implicit --omit=dev and silently skips drizzle-kit/tsx, which the
# entrypoint needs to run migrations and the seed-if-empty check below.
RUN npm ci
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
# drizzle-kit's `migrate` reads drizzle.config.ts, which points at the
# TypeScript schema source (see drizzle.config.ts) — keep src/ alongside
# dist/ in this image rather than only shipping compiled output, so the
# entrypoint's migration step resolves the exact same config as local dev.
COPY src ./src
COPY drizzle ./drizzle
COPY drizzle.config.ts ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 4000
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
