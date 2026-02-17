FROM ghcr.io/puppeteer/puppeteer:24.2.1

USER root
RUN apt-get update && apt-get install -y tini && rm -rf /var/lib/apt/lists/*
USER pptruser

WORKDIR /app

ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_CACHE_DIR=/home/pptruser/.cache/puppeteer

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json index.ts ./
RUN npx tsc

ENTRYPOINT ["tini", "--"]
CMD ["node", "dist/index.js"]
