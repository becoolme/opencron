export interface NotifyEvent {
  job_id: number;
  job_name: string;
  error: string | null;
  status_code: number | null;
  started_at: number;   // unix seconds
  duration_ms: number;
}

export interface BuiltRequest {
  url: string;
  init: RequestInit;
}

export type NotifyAdapter = (event: NotifyEvent, cfg: any) => BuiltRequest | Promise<BuiltRequest>;
