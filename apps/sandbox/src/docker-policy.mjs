/**
 * What the Docker API guard (docker-guard.mjs) lets through to the daemon. Pure, so it can be tested without Docker.
 *
 * The sandbox needs only a handful of calls: ping, image inspect and pull for the configured images, and create, attach,
 * start, wait and kill for its own run containers. Everything else is refused. A container create request is not passed
 * on as sent: the guard rebuilds it from the few fields a run needs and forces the hardening flags, so a sandbox that is
 * taken over still cannot start a privileged container, mount the host or join another network.
 */

export const RUN_NAME = /^opencron-run-[0-9a-f]{16}$/;
export const MAX_MEMORY = 1024 * 1024 * 1024;
export const MAX_PIDS = 64;
export const MAX_NANO_CPUS = 1_000_000_000;
export const RUN_USER = "65534:65534";
const ULIMITS = { nofile: 256, fsize: 268_435_456 };
const TMPFS_OPTIONS = /^(rw|exec|noexec|nosuid|nodev|size=\d+[kmg]?)$/;

export class Refused extends Error {}

/** `node:22-alpine`, `docker.io/library/node:22-alpine` and the like compare equal. */
export function normalizeImage(ref) {
  let image = String(ref ?? "").trim();
  image = image.replace(/^(docker\.io|index\.docker\.io|registry-1\.docker\.io)\//, "");
  image = image.replace(/^library\//, "");
  return image;
}

/** Splits `/v1.54/containers/abc/start` into its parts; the API version prefix is optional. */
export function parsePath(url) {
  const { pathname, searchParams } = new URL(url, "http://docker");
  const path = pathname.replace(/^\/v\d+(\.\d+)?(?=\/)/, "");
  return { path, query: searchParams };
}

/**
 * Classifies a request. Returns `{ kind }` for the calls the guard knows, and throws Refused for everything else.
 * `kind` is one of ping, image-inspect, image-pull, create, container.
 */
export function classify(method, url, { images }) {
  const { path, query } = parsePath(url);
  const allowedImage = (ref) => images.has(normalizeImage(ref));

  if ((method === "GET" || method === "HEAD") && (path === "/_ping" || path === "/version")) return { kind: "ping" };

  let match = path.match(/^\/images\/(.+)\/json$/);
  if (match && method === "GET") {
    const ref = decodeURIComponent(match[1]);
    if (!allowedImage(ref)) throw new Refused(`image ${ref} is not one of the sandbox images`);
    return { kind: "image-inspect" };
  }

  if (path === "/images/create" && method === "POST") {
    for (const key of query.keys()) {
      if (!["fromImage", "tag", "platform"].includes(key)) throw new Refused(`image pull option ${key} is not allowed`);
    }
    const from = query.get("fromImage") ?? "";
    const tag = query.get("tag") ?? "";
    const ref = tag ? `${from}${tag.startsWith("sha256:") ? "@" : ":"}${tag}` : from;
    // a pinned image may be pulled as name:tag@digest or as name@digest
    const matches = [...images].some((image) => image === normalizeImage(ref) || image.replace(/:[^:/@]+@/, "@") === normalizeImage(ref));
    if (!matches) throw new Refused(`image ${ref} is not one of the sandbox images`);
    return { kind: "image-pull" };
  }

  if (path === "/containers/create" && method === "POST") {
    for (const key of query.keys()) {
      if (!["name", "platform"].includes(key)) throw new Refused(`container option ${key} is not allowed`);
    }
    if (!RUN_NAME.test(query.get("name") ?? "")) throw new Refused("run containers must be named opencron-run-<16 hex>");
    return { kind: "create", name: query.get("name") };
  }

  match = path.match(/^\/containers\/([^/]+)(?:\/(attach|start|wait|kill|json))?$/);
  if (match) {
    const [, ref, action] = match;
    const allowed = action === "json" ? method === "GET" : action ? method === "POST" : method === "DELETE";
    if (allowed) return { kind: "container", ref: decodeURIComponent(ref), action: action ?? "remove" };
  }

  throw new Refused(`${method} ${path} is not needed by the sandbox`);
}

const isEmpty = (value) => value === null || value === undefined || value === false || value === 0 || value === ""
  || (Array.isArray(value) && value.length === 0)
  || (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0);

const strings = (value, field) => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Refused(`${field} must be a list of strings`);
  return value;
};

// HostConfig fields the docker CLI fills for a sandbox run. Each one is checked; any other field that is set is refused.
const HOST_FIELDS = new Set([
  "AutoRemove", "CapDrop", "ConsoleSize", "IpcMode", "LogConfig", "Memory", "MemorySwap", "MemorySwappiness",
  "NanoCpus", "NetworkMode", "PidsLimit", "ReadonlyRootfs", "RestartPolicy", "Runtime", "SecurityOpt", "Tmpfs", "Ulimits",
]);
const CONFIG_FIELDS = new Set([
  "AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "Entrypoint", "Env", "HostConfig", "Image", "Labels",
  "NetworkingConfig", "OpenStdin", "StdinOnce", "Tty", "User", "WorkingDir",
]);

/**
 * Checks a container create body and returns the body to send instead: only the fields a run needs, with the
 * hardening flags set by the guard rather than taken from the request. Throws Refused when the request asks for more.
 */
export function sanitizeCreate(body, { images, network, runtime }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Refused("expected a JSON object");
  for (const [key, value] of Object.entries(body)) {
    if (!CONFIG_FIELDS.has(key) && !isEmpty(value)) throw new Refused(`${key} is not allowed`);
  }
  const host = body.HostConfig ?? {};
  if (typeof host !== "object" || Array.isArray(host)) throw new Refused("HostConfig must be an object");
  for (const [key, value] of Object.entries(host)) {
    if (!HOST_FIELDS.has(key) && !isEmpty(value)) throw new Refused(`HostConfig.${key} is not allowed`);
  }

  if (!images.has(normalizeImage(body.Image))) throw new Refused(`image ${body.Image} is not one of the sandbox images`);
  if (body.User !== RUN_USER) throw new Refused(`runs must use user ${RUN_USER}`);
  if (body.Tty) throw new Refused("runs have no terminal");
  const endpoints = body.NetworkingConfig?.EndpointsConfig ?? {};
  if (Object.keys(endpoints).some((name) => name !== network)) throw new Refused("runs join no other network");

  if ((host.NetworkMode || "none") !== network) throw new Refused(`runs must use network ${network}`);
  if (host.Runtime && host.Runtime !== runtime) throw new Refused(`runtime ${host.Runtime} is not allowed`);
  if (host.LogConfig?.Type && host.LogConfig.Type !== "none") throw new Refused("runs keep no logs");
  if (host.RestartPolicy?.Name && host.RestartPolicy.Name !== "no") throw new Refused("runs are never restarted");
  if (host.MemorySwappiness !== undefined && host.MemorySwappiness !== -1) throw new Refused("runs cannot change swappiness");
  if (host.ConsoleSize !== undefined && !(Array.isArray(host.ConsoleSize) && host.ConsoleSize.every(Number.isInteger))) {
    throw new Refused("ConsoleSize must be two numbers");
  }

  const memory = Number(host.Memory);
  if (!(memory > 0 && memory <= MAX_MEMORY)) throw new Refused(`memory must be set and at most ${MAX_MEMORY} bytes`);
  if (host.MemorySwap !== undefined && host.MemorySwap !== memory) throw new Refused("runs cannot use swap");
  const pids = Number(host.PidsLimit);
  if (!(pids > 0 && pids <= MAX_PIDS)) throw new Refused(`the process limit must be between 1 and ${MAX_PIDS}`);
  const cpus = Number(host.NanoCpus);
  if (!(cpus > 0 && cpus <= MAX_NANO_CPUS)) throw new Refused("runs get at most one CPU");

  const tmpfs = host.Tmpfs ?? {};
  if (Object.keys(tmpfs).some((path) => path !== "/tmp")) throw new Refused("only /tmp may be a tmpfs");
  const tmpOptions = String(tmpfs["/tmp"] ?? "").split(",");
  if (!tmpOptions.every((option) => TMPFS_OPTIONS.test(option)) || !tmpOptions.includes("nosuid") || !tmpOptions.includes("nodev")
    || !tmpOptions.some((option) => option.startsWith("size="))) {
    throw new Refused("/tmp must be a size-limited nosuid,nodev tmpfs");
  }

  const ulimits = (host.Ulimits ?? []).map(({ Name, Soft, Hard }) => {
    if (!(Name in ULIMITS) || !(Soft > 0 && Hard > 0 && Soft <= ULIMITS[Name] && Hard <= ULIMITS[Name])) {
      throw new Refused(`ulimit ${Name} is not allowed`);
    }
    return { Name, Soft, Hard };
  });

  const securityOpt = strings(host.SecurityOpt, "SecurityOpt") ?? [];
  if (!securityOpt.every((option) => /^no-new-privileges(:true)?$/.test(option))) throw new Refused("security options cannot be loosened");

  const labels = body.Labels ?? {};
  if (typeof labels !== "object" || !Object.values(labels).every((value) => typeof value === "string")) {
    throw new Refused("labels must be strings");
  }

  const hostConfig = {
    AutoRemove: true,
    CapDrop: ["ALL"],
    IpcMode: "none",
    LogConfig: { Type: "none", Config: {} },
    Memory: memory,
    MemorySwap: memory,
    MemorySwappiness: -1,
    NanoCpus: cpus,
    NetworkMode: network,
    PidsLimit: pids,
    ReadonlyRootfs: true,
    RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
    SecurityOpt: ["no-new-privileges"],
    Tmpfs: { "/tmp": tmpOptions.join(",") },
    Ulimits: ulimits,
  };
  if (runtime) hostConfig.Runtime = runtime;
  if (Array.isArray(host.ConsoleSize)) hostConfig.ConsoleSize = host.ConsoleSize;

  return {
    AttachStdin: Boolean(body.AttachStdin),
    AttachStdout: Boolean(body.AttachStdout),
    AttachStderr: Boolean(body.AttachStderr),
    OpenStdin: Boolean(body.OpenStdin),
    StdinOnce: Boolean(body.StdinOnce),
    Tty: false,
    User: RUN_USER,
    Image: body.Image,
    Env: strings(body.Env, "Env") ?? [],
    Cmd: strings(body.Cmd, "Cmd"),
    Entrypoint: strings(body.Entrypoint, "Entrypoint"),
    WorkingDir: typeof body.WorkingDir === "string" ? body.WorkingDir : "",
    Labels: labels,
    HostConfig: hostConfig,
    NetworkingConfig: { EndpointsConfig: {} },
  };
}
