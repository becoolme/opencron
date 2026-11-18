import { getDatabase, type Database, type Statement } from "./database";
import { decryptSecret, encryptSecret } from "./secrets";
import type { Env, NotifyTarget } from "./types";

/**
 * Alert channels: a destination (a webhook, a chat bot) saved once in a workspace and shared by its jobs. A channel
 * belongs to the whole workspace or to one project; a job can use the workspace-wide channels and those of its own
 * project. Its config holds webhook URLs and tokens, so it is stored encrypted and the API only returns it masked.
 */

export const CHANNEL_TYPES = ["http", "lark", "telegram", "dingtalk", "slack", "discord"] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const MAX_CHANNELS_PER_WORKSPACE = 50;
export const MAX_CHANNELS_PER_JOB = 20;
export const MAX_CHANNEL_NAME_LENGTH = 60;
const MAX_HEADERS = 20;

/** The name the config is sealed under, together with the channel id. */
const SEAL_NAME = "alert-channel";

export function isChannelType(value: unknown): value is ChannelType {
  return typeof value === "string" && (CHANNEL_TYPES as readonly string[]).includes(value);
}

const ALLOWED_KEYS: Record<ChannelType, readonly string[]> = {
  http: ["url", "headers"],
  lark: ["url", "sign_secret"],
  telegram: ["bot_token", "chat_id"],
  dingtalk: ["url", "sign_secret"],
  slack: ["url"],
  discord: ["url"],
};

/** Checks the settings of a channel (without its type) and returns them as a target, or an error message. */
export function parseChannelConfig(type: ChannelType, raw: unknown): NotifyTarget | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "config must be an object" };
  const config = raw as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (key === "type") continue;
    if (!ALLOWED_KEYS[type].includes(key)) return { error: `config has unknown field "${key}" for type ${type}` };
  }
  switch (type) {
    case "http": {
      if (typeof config.url !== "string" || !config.url) return { error: "config.url is required" };
      if (!/^https?:\/\//.test(config.url) || !validUrl(config.url)) return { error: "config.url must be an http:// or https:// URL" };
      let headers: Record<string, string> | undefined;
      if (config.headers !== undefined && config.headers !== null) {
        if (typeof config.headers !== "object" || Array.isArray(config.headers)) return { error: "config.headers must be an object" };
        const entries = Object.entries(config.headers as Record<string, unknown>);
        if (entries.length > MAX_HEADERS) return { error: `config.headers can have at most ${MAX_HEADERS} entries` };
        for (const [name, value] of entries) {
          if (typeof value !== "string") return { error: "config.headers values must be strings" };
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return { error: `config.headers has an invalid name "${name}"` };
        }
        if (entries.length > 0) headers = Object.fromEntries(entries) as Record<string, string>;
      }
      return { type, url: config.url, ...(headers ? { headers } : {}) };
    }
    case "lark":
    case "dingtalk": {
      if (typeof config.url !== "string" || !config.url) return { error: "config.url is required" };
      if (!config.url.startsWith("https://") || !validUrl(config.url)) return { error: "config.url must be an https:// URL" };
      if (config.sign_secret !== undefined && config.sign_secret !== null && config.sign_secret !== "") {
        if (typeof config.sign_secret !== "string") return { error: "config.sign_secret must be a string" };
        return { type, url: config.url, sign_secret: config.sign_secret };
      }
      return { type, url: config.url };
    }
    case "slack":
    case "discord": {
      if (typeof config.url !== "string" || !config.url) return { error: "config.url is required" };
      if (!config.url.startsWith("https://") || !validUrl(config.url)) return { error: "config.url must be an https:// URL" };
      return { type, url: config.url };
    }
    case "telegram": {
      if (typeof config.bot_token !== "string" || !config.bot_token) return { error: "config.bot_token is required" };
      if (typeof config.chat_id !== "string" || !config.chat_id) return { error: "config.chat_id is required" };
      return { type, bot_token: config.bot_token, chat_id: config.chat_id };
    }
  }
}

function validUrl(url: string): boolean {
  try { new URL(url); return true; } catch { return false; }
}

export const HIDDEN = "***";

/** The last characters of a long value, so a person can tell two apart without reading them. */
function tail(value: string): string {
  return value.length > 12 ? `…${value.slice(-4)}` : "…";
}

function maskUrl(url: string): string {
  try { return `${new URL(url).origin}/${tail(url)}`; } catch { return HIDDEN; }
}

/** The config as the API shows it: URLs cut to their origin, tokens and secrets hidden, the chat id as it is. */
export function maskConfig(target: NotifyTarget): Record<string, unknown> {
  switch (target.type) {
    case "http":
      return {
        url: maskUrl(target.url),
        ...(target.headers ? { headers: Object.fromEntries(Object.keys(target.headers).map((name) => [name, HIDDEN])) } : {}),
      };
    case "lark":
    case "dingtalk":
      return { url: maskUrl(target.url), ...(target.sign_secret ? { sign_secret: HIDDEN } : {}) };
    case "telegram":
      return { bot_token: tail(target.bot_token), chat_id: target.chat_id };
    default:
      return { url: maskUrl(target.url) };
  }
}

/**
 * Applies a change to a saved config. A secret field that is missing, empty or still shows its masked value keeps what
 * is saved, so a form can send back what it was shown. `sign_secret: null` removes the signing secret; a header whose
 * value is `***` keeps its saved value.
 */
export function mergeConfig(saved: NotifyTarget, raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const input = { ...(raw as Record<string, unknown>) };
  const masked = maskConfig(saved) as Record<string, unknown>;
  const current = saved as unknown as Record<string, unknown>;
  const keep = (key: string) => {
    const value = input[key];
    if (value === undefined || value === "" || (value !== null && value === masked[key])) {
      if (current[key] === undefined) delete input[key];
      else input[key] = current[key];
    }
  };
  if (saved.type === "telegram") {
    keep("bot_token");
    keep("chat_id");
  } else {
    keep("url");
  }
  if (saved.type === "lark" || saved.type === "dingtalk") {
    if (input.sign_secret === null) delete input.sign_secret;
    else keep("sign_secret");
  }
  if (saved.type === "http" && input.headers && typeof input.headers === "object" && !Array.isArray(input.headers)) {
    const savedHeaders = saved.headers ?? {};
    input.headers = Object.fromEntries(Object.entries(input.headers as Record<string, unknown>).map(([name, value]) =>
      [name, value === HIDDEN && savedHeaders[name] !== undefined ? savedHeaders[name] : value]));
  } else if (saved.type === "http" && input.headers === undefined && saved.headers) {
    input.headers = saved.headers;
  }
  return input;
}

export async function sealConfig(env: Pick<Env, "BETTER_AUTH_SECRET">, channelId: string, target: NotifyTarget): Promise<string> {
  return encryptSecret(env, channelId, SEAL_NAME, JSON.stringify(target));
}

export async function openConfig(env: Pick<Env, "BETTER_AUTH_SECRET">, channelId: string, stored: string): Promise<NotifyTarget> {
  return JSON.parse(await decryptSecret(env, channelId, SEAL_NAME, stored)) as NotifyTarget;
}

export interface ChannelRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  type: ChannelType;
  name: string;
  config: string;
  enabled: number;
  auto_enable: number;
  created_at: number;
  updated_at: number;
}

export interface ChannelDto {
  id: string;
  name: string;
  type: ChannelType;
  project_id: string | null;
  enabled: boolean;
  auto_enable: boolean;
  /** Masked; null when the config can no longer be decrypted (BETTER_AUTH_SECRET changed). */
  config: Record<string, unknown> | null;
  job_count: number;
  created_at: number;
  updated_at: number;
}

export async function channelToDto(env: Env, row: ChannelRow & { job_count?: number }): Promise<ChannelDto> {
  let config: Record<string, unknown> | null = null;
  try { config = maskConfig(await openConfig(env, row.id, row.config)); } catch { config = null; }
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    project_id: row.project_id ?? null,
    enabled: Number(row.enabled) === 1,
    auto_enable: Number(row.auto_enable) === 1,
    config,
    job_count: Number(row.job_count ?? 0),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

/** Whether a job in `projectId` may use a channel that belongs to `channelProjectId`. */
export function channelFitsProject(channelProjectId: string | null, projectId: string | null): boolean {
  return channelProjectId === null || channelProjectId === projectId;
}

/** The enabled default channels a new job in `projectId` starts with. */
export async function defaultChannelIds(env: Env, workspaceId: string, projectId: string): Promise<string[]> {
  const { results } = await getDatabase(env).prepare(
    `SELECT id FROM alert_channels
      WHERE organization_id = ? AND enabled = 1 AND auto_enable = 1 AND (project_id IS NULL OR project_id = ?)
      ORDER BY created_at, id LIMIT ?`,
  ).bind(workspaceId, projectId, MAX_CHANNELS_PER_JOB).all<{ id: string }>();
  return results.map((row) => row.id);
}

/** Checks the channel_ids of a request for a job in `projectId`; returns them without duplicates, or an error. */
export async function parseChannelIds(env: Env, workspaceId: string, projectId: string, raw: unknown): Promise<string[] | { error: string }> {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) return { error: "channel_ids must be an array of channel ids" };
  const ids = [...new Set(raw as string[])];
  if (ids.length > MAX_CHANNELS_PER_JOB) return { error: `A job can use at most ${MAX_CHANNELS_PER_JOB} channels` };
  if (ids.length === 0) return [];
  const { results } = await getDatabase(env).prepare(
    `SELECT id, project_id FROM alert_channels WHERE organization_id = ? AND id IN (${ids.map(() => "?").join(", ")})`,
  ).bind(workspaceId, ...ids).all<{ id: string; project_id: string | null }>();
  const found = new Map(results.map((row) => [row.id, row.project_id]));
  for (const id of ids) {
    if (!found.has(id)) return { error: `channel_ids: ${id} is not a channel of this workspace` };
    if (!channelFitsProject(found.get(id) ?? null, projectId)) return { error: `channel_ids: ${id} belongs to another project` };
  }
  return ids;
}

/** Statements that make `ids` the channels of a job, for one batch. */
export function setJobChannelStatements(db: Database, jobId: number, ids: string[]): Statement[] {
  return [
    db.prepare("DELETE FROM job_channels WHERE job_id = ?").bind(jobId),
    ...ids.map((id) => db.prepare("INSERT INTO job_channels (job_id, channel_id) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(jobId, id)),
  ];
}

/** Removes the links of a job that moved to `projectId` to channels of other projects. */
export function dropForeignChannelsStatement(db: Database, jobId: number, projectId: string): Statement {
  return db.prepare(
    `DELETE FROM job_channels WHERE job_id = ? AND channel_id IN
       (SELECT id FROM alert_channels WHERE project_id IS NOT NULL AND project_id <> ?)`,
  ).bind(jobId, projectId);
}

/** The channel ids of each job, in one query. */
export async function channelIdsByJob(env: Env, jobIds: number[]): Promise<Map<number, string[]>> {
  const map = new Map<number, string[]>(jobIds.map((id) => [id, []]));
  if (jobIds.length === 0) return map;
  // D1 caps bound parameters per query at 100
  for (let i = 0; i < jobIds.length; i += 90) {
    const chunk = jobIds.slice(i, i + 90);
    const { results } = await getDatabase(env).prepare(
      `SELECT jc.job_id, jc.channel_id FROM job_channels jc JOIN alert_channels ch ON ch.id = jc.channel_id
        WHERE jc.job_id IN (${chunk.map(() => "?").join(", ")}) ORDER BY ch.created_at, ch.id`,
    ).bind(...chunk).all<{ job_id: number; channel_id: string }>();
    for (const row of results) map.get(Number(row.job_id))?.push(row.channel_id);
  }
  return map;
}

/** The enabled channels of a job, decrypted, for sending an alert. A channel that no longer decrypts is skipped. */
export async function targetsForJob(env: Env, jobId: number): Promise<Array<{ id: string; name: string; target: NotifyTarget }>> {
  const { results } = await getDatabase(env).prepare(
    `SELECT ch.id, ch.name, ch.config FROM job_channels jc JOIN alert_channels ch ON ch.id = jc.channel_id
      WHERE jc.job_id = ? AND ch.enabled = 1 ORDER BY ch.created_at, ch.id`,
  ).bind(jobId).all<{ id: string; name: string; config: string }>();
  const targets: Array<{ id: string; name: string; target: NotifyTarget }> = [];
  for (const row of results) {
    try {
      targets.push({ id: row.id, name: row.name, target: await openConfig(env, row.id, row.config) });
    } catch {
      console.error(`[notify] channel ${row.id} cannot be decrypted (was BETTER_AUTH_SECRET changed?)`);
    }
  }
  return targets;
}

export function channelTypeLabel(type: ChannelType): string {
  switch (type) {
    case "http": return "Webhook";
    case "lark": return "Lark";
    case "telegram": return "Telegram";
    case "dingtalk": return "DingTalk";
    case "slack": return "Slack";
    case "discord": return "Discord";
  }
}
