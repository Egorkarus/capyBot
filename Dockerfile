FROM node:20-slim AS builder

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --omit=dev

FROM node:20-slim

WORKDIR /usr/src/app

RUN apt-get update && apt-get install -y \
    ffmpeg \
    ca-certificates \
    python3 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY . .

ENV NODE_ENV=production

CMD ["node", "index.js"]
