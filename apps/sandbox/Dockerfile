# The OpenCron script sandbox. It talks to the host's Docker daemon to start one locked-down container per run, so it
# holds the Docker socket; keep it on an internal network only. See docs/docker.md.
FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY src ./src
COPY package.json ./
ENV NODE_ENV=production PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "src/server.mjs"]
