import { allowPrivateTargets } from "@openuptime/kit/netguard";
import type { Env } from "./types";

/**
 * HTTP jobs and webhooks go to URLs that users type in. By default they must point at public addresses, so a job cannot
 * be used to probe the network the deployment sits in. Self-hosters who schedule calls to internal services set
 * ALLOW_PRIVATE_TARGETS=true. The value is constant per deployment, so setting it per request is safe.
 */
export function applyOutboundPolicy(env: Pick<Env, "ALLOW_PRIVATE_TARGETS">) {
  allowPrivateTargets(env.ALLOW_PRIVATE_TARGETS === "true");
}
