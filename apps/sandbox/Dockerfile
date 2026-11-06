# The OpenCron script sandbox. It starts one locked-down container per run through the Docker API guard, which is the
# same image run as `node src/docker-guard.mjs` and the only service that holds the Docker socket. See docs/docker.md.
FROM node:22-alpine
RUN apk add --no-cache docker-cli
WORKDIR /app
COPY src ./src
COPY package.json ./
ENV NODE_ENV=production PORT=8787 DOCKER_CONFIG=/tmp/.docker
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1
# the sandbox needs no root; the guard is started as root in docker-compose.yml to open the socket
USER node
CMD ["node", "src/server.mjs"]
