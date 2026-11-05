/** Run against an isolated local wrangler dev instance (real Worker Loader, no mocks). */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const base = process.env.SMOKE_BASE_URL;
if (!base || !["127.0.0.1", "localhost"].includes(new URL(base).hostname)) {
  throw new Error("Set SMOKE_BASE_URL to an isolated local test server");
}
const password = randomUUID();
async function account() {
  const email = `smoke-${randomUUID()}@example.com`;
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base! },
    body: JSON.stringify({ name: "Database smoke test", email, password }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  const cookie = response.headers.getSetCookie().map((header) => header.split(";")[0]).join("; ");
  assert(cookie);
  return { email, headers: { cookie, "content-type": "application/json", origin: base! } };
}
async function request(path: string, headers: Record<string, string>, method = "GET", body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
  return response.status === 204 ? null : response.json();
}
const alice = await account();
const bob = await account();
const jobs: { id: number; headers: Record<string, string> }[] = [];
try {
  const login = await request("/api/auth/sign-in/email", alice.headers, "POST", { email: alice.email, password });
  assert.equal(login.user.email, alice.email);
  assert.equal((await fetch(`${base}/api/jobs`)).status, 401);
  const script = `export default { async fetch(request, env) {
    const created = await env.db.insert("products", { name: "Coffee", price: 20 });
    const updated = await env.db.update("products", { where: { id: created.id }, set: { price: 25, available: false } });
    const selected = await env.db.select("products", { where: { available: false }, limit: 5 });
    const deleted = await env.db.delete("products", { where: { id: created.id } });
    await env.db.insert("products", { name: "Private" });
    await env.D1.put("legacy", "compatible");
    await env.DB.put("old", "compatible");
    if ((await env.DB.list("ol")).length !== 1 || (await env.D1.list("leg")).length !== 1) {
      throw new Error("Legacy storage listing failed");
    }
    let blocked = false;
    try { await env.db.select("user"); } catch { blocked = true; }
    return Response.json({ created, updatedPrice: updated[0].price, selectedAvailable: selected[0].available, deleted,
      legacy: (await env.D1.get("legacy")).data, old: await env.DB.get("old"), blocked,
      credentialsHidden: !env.DATABASE_URL && !env.HYPERDRIVE && !env.BETTER_AUTH_SECRET });
  } }`;
  async function job(headers: Record<string, string>, source: string) {
    const { job } = await request("/api/jobs", headers, "POST", {
      name: "Database smoke test", type: "script", script: source, cron: "0 0 * * *", enabled: false,
    });
    jobs.push({ id: job.id, headers });
    return job;
  }
  const first = await job(alice.headers, script);
  const { result } = await request(`/api/jobs/${first.id}/run`, alice.headers, "POST");
  assert.equal(result.ok, true, JSON.stringify(result));
  const data = JSON.parse(result.response_snippet);
  assert.equal(data.created.available, true);
  assert.equal(data.updatedPrice, 25);
  assert.equal(data.selectedAvailable, false);
  assert.equal(data.deleted.deleted, 1);
  assert.equal(data.legacy, "compatible");
  assert.equal(data.old, "compatible");
  assert.equal(data.blocked, true);
  assert.equal(data.credentialsHidden, true);
  const reader = `export default { async fetch(request, env) { return Response.json(await env.db.select("products")); } }`;
  for (const headers of [alice.headers, bob.headers]) {
    const other = await job(headers, reader);
    const run = await request(`/api/jobs/${other.id}/run`, headers, "POST");
    assert.equal(run.result.ok, true, JSON.stringify(run));
    assert.deepEqual(JSON.parse(run.result.response_snippet), []);
  }
  assert.equal((await fetch(`${base}/api/jobs/${first.id}`, { headers: bob.headers })).status, 404);
  await request(`/api/jobs/${first.id}`, alice.headers, "PATCH", { name: "Updated" });
  assert.equal((await request(`/api/jobs/${first.id}`, alice.headers)).job.name, "Updated");
  const history = await request(`/api/jobs/${first.id}/executions`, alice.headers);
  assert.equal(history.executions.length, 1);
  assert.equal(typeof history.executions[0].started_at, "number");
  assert.equal(typeof first.next_run_at, "number");
  const allHistory = await request("/api/executions", alice.headers);
  assert.equal(allHistory.executions.length, 2);
  console.log("PASS: registration, login, jobs, real Worker Loader CRUD, D1/DB compatibility, isolation, history");
} finally {
  for (const { id, headers } of jobs) await request(`/api/jobs/${id}`, headers, "DELETE");
  for (const user of [alice, bob]) {
    await request("/api/auth/sign-out", user.headers, "POST", {});
    assert.equal((await fetch(`${base}/api/jobs`, { headers: user.headers })).status, 401);
  }
}
