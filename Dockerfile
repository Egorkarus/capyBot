FROM node:20-alpine AS builder

WORKDIR /usr/src/app

RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp

COPY package*.json ./

RUN npm ci --omit=dev

FROM node:20-alpine

WORKDIR /usr/src/app

RUN apk add --no-cache \
    ffmpeg \
    ca-certificates \
    python3

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]

