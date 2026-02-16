FROM ghcr.io/puppeteer/puppeteer:24.2.1

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json index.ts ./
RUN npx tsc

CMD ["node", "dist/index.js"]
