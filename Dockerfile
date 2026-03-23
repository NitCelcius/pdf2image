# syntax=docker/dockerfile:1

FROM node:24-slim AS base

ENV TZ=Asia/Tokyo \
    NODE_ENV=production

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && \
    apt-get install -y --no-install-recommends \
        imagemagick \
        ghostscript

WORKDIR /app

FROM base AS builder

COPY package.json pnpm-lock.yaml ./

RUN npm install -g pnpm && pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src

RUN pnpm run build

FROM base AS production

COPY package.json pnpm-lock.yaml ./

RUN npm install -g pnpm && pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY config ./config

USER node

EXPOSE 3000

CMD ["npm", "start"]
