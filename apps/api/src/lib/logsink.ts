// HTTP log shipping to the logs service (apps/logs). Tail Workers are Paid-plan
// only, so we push logs over HTTP instead — works on every plan and locally too.
// Each log line is buffered (by the logger) and flushed once per request/task via
// waitUntil, so we send one batched request instead of one fetch per log line.

export interface SinkRow {
  ts: number;
  level: string;
  service: string;
  message: string;
}

const MAX_BUFFER = 1000;
let buffer: SinkRow[] = [];

/** Append a log row to the in-memory buffer (called by the logger). */
export function pushLog(row: SinkRow): void {
  buffer.push(row);
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER);
}

/** Drain and return the current buffer. */
function drain(): SinkRow[] {
  const b = buffer;
  buffer = [];
  return b;
}

/**
 * Ship buffered logs to LOGS_INGEST_URL. Fire-and-forget via ctx.waitUntil when
 * given (so it doesn't block the response); otherwise awaited (background tasks).
 * Never throws — logging must not break the app.
 */
export function flushLogs(
  env: { LOGS_INGEST_URL?: string },
  ctx?: { waitUntil(promise: Promise<unknown>): void },
): void {
  const url = env.LOGS_INGEST_URL;
  if (!url) return; // shipping disabled
  const rows = drain();
  if (rows.length === 0) return;
  const p = fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(rows),
  })
    .then(() => undefined)
    .catch(() => undefined);
  if (ctx) ctx.waitUntil(p);
}

/** Awaitable flush for background tasks (no ExecutionContext available). */
export async function flushLogsAsync(env: { LOGS_INGEST_URL?: string }): Promise<void> {
  const url = env.LOGS_INGEST_URL;
  if (!url) return;
  const rows = drain();
  if (rows.length === 0) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rows),
    });
  } catch {
    /* ignore */
  }
}
