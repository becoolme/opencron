interface ApiErrorBody {
  error?: string;
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
    throw new Error(body.error || "request failed");
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}
