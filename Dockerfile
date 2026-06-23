# syntax=docker/dockerfile:1

# ---- builder: install production dependencies only ----
FROM node:24-alpine AS builder
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---- runtime ----
FROM node:24-alpine AS runtime
ENV NODE_ENV=production \
    NPM_CONFIG_LOGLEVEL=warn \
    METRICS_PORT=3001
# dumb-init reaps zombies and forwards signals to the Node process (PID 1).
# Also remove the base image's bundled npm/npx: it is not needed at runtime
# (the app runs `node bin/daemon.js`) and ships transitive CVEs scanners flag.
RUN apk add --no-cache dumb-init \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --chown=node:node package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node bin ./bin
COPY --chown=node:node lib ./lib
COPY --chown=node:node config ./config
COPY --chown=node:node charts/kubernetes-external-secrets/crds ./charts/kubernetes-external-secrets/crds
# Run as the non-root uid 1000 (numeric, so Kubernetes runAsNonRoot admission can verify it)
USER 1000
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${METRICS_PORT}/metrics" >/dev/null 2>&1 || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "bin/daemon.js"]
