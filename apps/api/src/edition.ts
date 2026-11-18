import type { Hono } from "hono";
import type { AppHonoEnv, Env } from "./types";

/**
 * What one workspace may use. The open-source edition has no plans: `plan()` returns null and only the fixed limits in
 * the code apply. A hosted deployment supplies its own edition to sell plans.
 */
export interface Plan {
  id: string;
  name: string;
  /** Jobs that may be turned on at once; null for no limit beyond the fixed one. */
  maxActiveJobs: number | null;
  /** Where an owner or admin can pick a larger plan, if there is one. */
  upgradeUrl?: string;
  /** Where an owner or admin manages the paid subscription. */
  manageUrl?: string;
  /** The paid plan ends at the end of the period instead of renewing. */
  cancelAtPeriodEnd?: boolean;
  /** Unix seconds: when the current paid period ends. */
  renewsAt?: number | null;
}

/** A plan the workspace can move to, as the app's plan picker shows it. */
export interface PlanOffer {
  id: string;
  name: string;
  priceUsd: number;
  maxActiveJobs: number | null;
  /** Opens checkout for this plan; absent for the free plan. */
  checkoutUrl?: string;
}

export interface Edition {
  /** Reported by GET /api/usage; "community" for the open-source edition. */
  id: string;
  plan(env: Env, workspaceId: string): Promise<Plan | null>;
  /** The plans offered to a workspace, cheapest first. */
  offers?(env: Env, workspaceId: string): Promise<PlanOffer[]>;
  /**
   * Adds the edition's own routes. `app` is public and sees requests before the session check; `api` is under /api,
   * behind the session and workspace checks.
   */
  mount?(routes: { app: Hono<AppHonoEnv>; api: Hono<AppHonoEnv> }): void;
}

export const community: Edition = {
  id: "community",
  plan: async () => null,
};
