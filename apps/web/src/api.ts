interface ApiErrorBody {
  error?: string;
  code?: string;
  limit?: number;
  upgrade_url?: string | null;
}

/** A refusal from the API, with the fields some refusals carry (a plan's limit and where to upgrade). */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: ApiErrorBody) {
    super(message);
  }
}

/** Where to pick a larger plan, when `error` is a refusal for being over the plan's limit. */
export function upgradeUrl(error: unknown): string | null {
  return error instanceof ApiError && error.body.code === "job_limit" ? (error.body.upgrade_url ?? null) : null;
}

/** Fired when the API answers 401: the session expired or was signed out elsewhere. */
export const UNAUTHORIZED_EVENT = "opencron:unauthorized";

/**
 * The workspace and project the app is showing. Every request names them, so a tab keeps working in its own workspace
 * when another tab switches.
 */
export const scope: { workspace: string | null; project: string | null } = { workspace: null, project: null };

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(scope.workspace ? { "x-workspace-id": scope.workspace } : {}),
      ...(scope.project ? { "x-project-id": scope.project } : {}),
      ...options.headers,
    },
  });

  if (response.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as ApiErrorBody;
    throw new ApiError(body.error || "request failed", response.status, body);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
