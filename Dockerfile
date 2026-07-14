FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

COPY package.json package-lock.json LICENSE README.md ./
RUN apk add --no-cache imagemagick libwebp-tools \
    && npm ci --omit=dev

COPY --chown=node:node package.json package-lock.json LICENSE README.md ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "./bin/server.js"]
