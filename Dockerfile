FROM node:22-alpine AS builder

WORKDIR /usr/src/app

ARG YT_DLP_VERSION=2026.08.19

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    curl \
    && curl -fL "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" -o /usr/local/bin/yt-dlp \
    && echo "Verifying yt-dlp version ${YT_DLP_VERSION}" \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && /usr/local/bin/yt-dlp --version

COPY package*.json ./

RUN npm ci --omit=dev

FROM node:22-alpine

WORKDIR /usr/src/app

RUN apk add --no-cache \
    ffmpeg \
    ca-certificates \
    python3

COPY --from=builder /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=builder /usr/src/app/node_modules ./node_modules

COPY . .

RUN mkdir -p temp \
    && chown -R node:node /usr/src/app \
    && chmod -R 755 /usr/src/app \
    && chmod -R 777 temp

USER node

ENV NODE_ENV=production

CMD ["node", "src/index.js"]

