interface ApiErrorBody {
  error?: string;
}

/** Fired when the API answers 401: the session expired or was signed out elsewhere. */
export const UNAUTHORIZED_EVENT = "opencron:unauthorized";

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
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
