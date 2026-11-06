import { request as httpRequest, createServer } from "node:http";
import { connect } from "node:net";
import { DEFAULT_IMAGES } from "./docker-args.mjs";
import { Refused, classify, normalizeImage, sanitizeCreate } from "./docker-policy.mjs";

/**
 * The Docker API guard: the only service that holds the Docker socket. The sandbox reaches the daemon through it
 * (DOCKER_HOST=tcp://docker-guard:2375) and gets only the calls in docker-policy.mjs, for containers it created itself.
 * If the sandbox is ever taken over, this is what keeps it from starting a privileged container or mounting the host.
 */

const SOCKET = process.env.DOCKER_SOCKET || "/var/run/docker.sock";
const PORT = Number(process.env.PORT ?? 2375);
const NETWORK = process.env.SANDBOX_NETWORK || "none";
const RUNTIME = process.env.SANDBOX_DOCKER_RUNTIME || undefined;
const IMAGES = new Set([
  process.env.SANDBOX_IMAGE_NODE || DEFAULT_IMAGES.javascript,
  process.env.SANDBOX_IMAGE_PYTHON || DEFAULT_IMAGES.python,
  process.env.SANDBOX_IMAGE_GO || DEFAULT_IMAGES.go,
].map(normalizeImage));
const MAX_CREATE_BODY = 256 * 1024;
// runs last at most 300 s plus startup grace; forget containers well after that
const TRACK_MS = 15 * 60_000;

if (NETWORK === "host" || NETWORK.startsWith("container:")) {
  console.error(`SANDBOX_NETWORK=${NETWORK} would share a network namespace with the host or another container`);
  process.exit(1);
}

/** Containers this guard created, by id and by name. Only these can be attached, started, waited on or killed. */
const created = new Map();
function track(id, name) {
  const entry = { id, name, at: Date.now() };
  created.set(id, entry);
  created.set(name, entry);
}
function known(ref) {
  const now = Date.now();
  for (const [key, entry] of created) if (now - entry.at > TRACK_MS) created.delete(key);
  if (created.has(ref)) return true;
  // the CLI may use a unique id prefix
  return ref.length >= 12 && /^[0-9a-f]+$/.test(ref) && [...created.keys()].some((key) => key.startsWith(ref));
}

const policy = { images: IMAGES, network: NETWORK, runtime: RUNTIME };

function refuse(res, message, status = 403) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ message: `refused by the OpenCron Docker guard: ${message}` }));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Refused("request body too large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Sends a request to the daemon and streams the answer back; long calls (wait, pull) stream as they come. */
function forward(req, res, { path = req.url, body, onBody } = {}) {
  const headers = { ...req.headers, host: "docker" };
  delete headers.connection;
  // the create answer is read here, so keep it uncompressed
  delete headers["accept-encoding"];
  if (body) headers["content-length"] = String(body.length);
  const upstream = httpRequest({ socketPath: SOCKET, method: req.method, path, headers }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    // the CLI waits for the headers of some calls (wait) before making the next one
    res.flushHeaders();
    if (onBody) {
      const chunks = [];
      answer.on("data", (chunk) => { chunks.push(chunk); res.write(chunk); });
      answer.on("end", () => { onBody(answer.statusCode, Buffer.concat(chunks)); res.end(); });
    } else {
      answer.pipe(res);
    }
  });
  upstream.on("error", (error) => { if (!res.headersSent) refuse(res, `daemon unavailable: ${error.message}`, 502); else res.destroy(); });
  res.on("close", () => upstream.destroy());
  if (body) upstream.end(body); else req.pipe(upstream);
}

const server = createServer(async (req, res) => {
  try {
    const call = classify(req.method, req.url, policy);
    if (call.kind === "container" && !known(call.ref)) throw new Refused(`container ${call.ref} was not started by the sandbox`);
    if (call.kind === "create") {
      const input = JSON.parse((await readBody(req, MAX_CREATE_BODY)).toString("utf8") || "null");
      const body = Buffer.from(JSON.stringify(sanitizeCreate(input, policy)));
      const version = req.url.match(/^\/v\d+(\.\d+)?/)?.[0] ?? "";
      forward(req, res, {
        path: `${version}/containers/create?name=${encodeURIComponent(call.name)}`,
        body,
        onBody: (status, answer) => {
          if (status !== 201) return;
          try { track(JSON.parse(answer.toString("utf8")).Id, call.name); } catch { /* the daemon answered something else */ }
        },
      });
      return;
    }
    forward(req, res);
  } catch (error) {
    if (error instanceof Refused || error instanceof SyntaxError) {
      console.warn(`refused ${req.method} ${req.url}: ${error.message}`);
      return refuse(res, error.message, error instanceof SyntaxError ? 400 : 403);
    }
    console.error(error);
    refuse(res, "guard error", 500);
  }
});

// `docker run -i` attaches to the container's stdin and output over an upgraded connection.
server.on("upgrade", (req, socket, head) => {
  let call;
  try {
    call = classify(req.method, req.url, policy);
    if (call.kind !== "container" || call.action !== "attach" || !known(call.ref)) throw new Refused("only attaching to a run container can upgrade");
  } catch (error) {
    console.warn(`refused ${req.method} ${req.url}: ${error.message}`);
    socket.end("HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\nconnection: close\r\n\r\n"
      + JSON.stringify({ message: `refused by the OpenCron Docker guard: ${error.message}` }));
    return;
  }
  const upstream = connect(SOCKET, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`, "host: docker"];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() !== "host") lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
});

server.listen(PORT, () => console.log(`OpenCron Docker guard listening on :${PORT} for ${[...IMAGES].join(", ")}`));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
