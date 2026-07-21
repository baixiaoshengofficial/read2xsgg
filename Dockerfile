FROM node:22-alpine

WORKDIR /app

ARG GIT_SHA=
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/data \
    GIT_SHA=${GIT_SHA}

COPY package.json package-lock.json LICENSE README.md ./
RUN apk add --no-cache imagemagick libwebp-tools su-exec \
    && npm ci --omit=dev \
    && mkdir -p /data \
    && chown node:node /data

COPY --chown=node:node package.json package-lock.json LICENSE README.md ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY docker-entrypoint.sh /usr/local/bin/read2xsgg-entrypoint
RUN chmod 0755 /usr/local/bin/read2xsgg-entrypoint

# The entrypoint fixes ownership of a host bind mount, then immediately drops
# to this unprivileged user with su-exec before starting Node.
USER root

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/read2xsgg-entrypoint"]
CMD ["node", "./bin/server.js"]
