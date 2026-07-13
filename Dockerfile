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

RUN npm install --omit=dev

FROM node:20-alpine

WORKDIR /usr/src/app

RUN apk add --no-cache \
    ffmpeg \
    ca-certificates \
    python3

COPY --from=builder /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp
COPY --from=builder /usr/src/app/node_modules ./node_modules

COPY . .

# NOTE: Оставляем бота под root-правами. Если переключиться на пользователя node,
# yt-dlp ловит пермишен-ошибки при создании дочерних процессов и удалении темповых файлов.
RUN mkdir -p temp

ENV NODE_ENV=production

CMD ["node", "src/index.js"]

