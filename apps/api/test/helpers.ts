import { env, SELF, applyD1Migrations } from "cloudflare:test";

export interface TestAccount {
  email: string;
  password: string;
  userId: string;
  headers: Record<string, string>;
}

export async function applyMigrations() {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

export async function clearDb() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM executions"),
    env.DB.prepare("DELETE FROM script_records"),
    env.DB.prepare("DELETE FROM script_storage"),
    env.DB.prepare("DELETE FROM jobs"),
    env.DB.prepare("DELETE FROM secrets"),
    env.DB.prepare("DELETE FROM api_keys"),
    env.DB.prepare("DELETE FROM invitation"),
    env.DB.prepare("DELETE FROM member"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM organization"),
    env.DB.prepare("DELETE FROM sqlite_sequence WHERE name IN ('jobs','executions','secrets')"),
  ]);
}

export async function createTestAccount(label = "user"): Promise<TestAccount> {
  const email = `${label}-${crypto.randomUUID()}@example.com`;
  const password = "opencron-test-password";
  const response = await SELF.fetch("https://w/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://cron.example.com" },
    body: JSON.stringify({ name: `Test ${label}`, email, password }),
  });

  if (!response.ok) {
    throw new Error(`Could not create test account (${response.status}): ${await response.text()}`);
  }

  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) throw new Error("Sign-up response did not set a session cookie");
  const cookie = setCookie
    .split(/,(?=\s*[^;,]+=)/)
    .map((value) => value.split(";", 1)[0].trim())
    .join("; ");
  const data = await response.json() as { user: { id: string } };

  return {
    email,
    password,
    userId: data.user.id,
    headers: { "content-type": "application/json", cookie },
  };
}

/**
 * The personal workspace and its Default project for an account, recreated by the API if `clearDb` removed it. Use it
 * before inserting jobs directly.
 */
export async function personalWorkspace(account: TestAccount): Promise<{ workspaceId: string; projectId: string }> {
  const response = await SELF.fetch("https://w/api/projects", { headers: account.headers });
  if (!response.ok) throw new Error(`Could not load projects (${response.status})`);
  return { workspaceId: `ws_${account.userId}`, projectId: `pj_${account.userId}` };
}
