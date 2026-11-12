# Sidequest PDF renderer — headless Chromium (shell build only) behind a tiny HTTP server.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
 && npx playwright-core install --with-deps --only-shell chromium \
 # Fonts for every script a destination may be written in: Japanese, Chinese and Korean (Noto CJK),
 # plus broad Latin/Greek/Cyrillic/Arabic/Hebrew/Thai/Devanagari coverage and colour emoji.
 && apt-get update \
 && apt-get install -y --no-install-recommends fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/* \
 && fc-cache -f

COPY server.mjs ./
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
