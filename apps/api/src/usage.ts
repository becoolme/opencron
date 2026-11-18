import type { Context } from "hono";
import { getDatabase } from "./database";
import type { Plan, PlanOffer } from "./edition";
import type { AppHonoEnv } from "./types";

/** Jobs one workspace can keep, on or off; a plan that allows more jobs at once raises it to that. */
export const MAX_JOBS_PER_WORKSPACE = 200;

export function maxJobs(plan: Plan | null): number {
  return Math.max(MAX_JOBS_PER_WORKSPACE, plan?.maxActiveJobs ?? 0);
}

export async function jobCounts(c: Context<AppHonoEnv>): Promise<{ total: number; active: number }> {
  const row = await getDatabase(c.env)
    .prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS active FROM jobs WHERE organization_id = ?")
    .bind(c.get("workspaceId"))
    .first<{ total: number; active: number }>();
  return { total: Number(row?.total ?? 0), active: Number(row?.active ?? 0) };
}

/**
 * The refusal when turning on `add` more jobs would pass the plan's limit, or null when it fits. HTTP 402 with
 * `code: "job_limit"`, so the app can offer the upgrade.
 */
export async function overJobLimit(c: Context<AppHonoEnv>, add: number): Promise<Response | null> {
  const plan = await c.get("edition").plan(c.env, c.get("workspaceId"));
  if (!plan || plan.maxActiveJobs === null) return null;
  const { active } = await jobCounts(c);
  if (active + add <= plan.maxActiveJobs) return null;
  return c.json({
    error: `The ${plan.name} plan allows ${plan.maxActiveJobs} jobs turned on at once. Turn one off, or move to a larger plan.`,
    code: "job_limit",
    limit: plan.maxActiveJobs,
    active,
    plan: plan.id,
    upgrade_url: plan.upgradeUrl ?? null,
  }, 402);
}

export type UsageResponse =
  | { metered: false; edition: string; jobs: { total: number; active: number; max: number } }
  | {
    metered: true;
    edition: string;
    jobs: { total: number; active: number; max: number };
    plan: {
      id: string;
      name: string;
      max_active_jobs: number | null;
      upgrade_url: string | null;
      manage_url: string | null;
      cancel_at_period_end: boolean;
      renews_at: number | null;
    };
    offers: Array<{ id: string; name: string; price_usd: number; max_active_jobs: number | null; checkout_url: string | null }>;
  };

/** GET /api/usage: the workspace's plan, if this edition has plans, and its jobs against the limits. */
export async function usage(c: Context<AppHonoEnv>): Promise<UsageResponse> {
  const edition = c.get("edition");
  const workspaceId = c.get("workspaceId");
  const [plan, counts] = await Promise.all([edition.plan(c.env, workspaceId), jobCounts(c)]);
  const jobs = { ...counts, max: maxJobs(plan) };
  if (!plan) return { metered: false, edition: edition.id, jobs };
  const offers: PlanOffer[] = (await edition.offers?.(c.env, workspaceId)) ?? [];
  return {
    metered: true,
    edition: edition.id,
    jobs,
    plan: {
      id: plan.id,
      name: plan.name,
      max_active_jobs: plan.maxActiveJobs,
      upgrade_url: plan.upgradeUrl ?? null,
      manage_url: plan.manageUrl ?? null,
      cancel_at_period_end: plan.cancelAtPeriodEnd ?? false,
      renews_at: plan.renewsAt ?? null,
    },
    offers: offers.map((offer) => ({
      id: offer.id,
      name: offer.name,
      price_usd: offer.priceUsd,
      max_active_jobs: offer.maxActiveJobs,
      checkout_url: offer.checkoutUrl ?? null,
    })),
  };
}
