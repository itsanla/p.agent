// Lightweight console logger for the Worker (no filesystem). Same API as the old
// Next.js logger so ported code keeps working: logger(scope).info/warn/error.
// Returns void (not a promise) — callers may still `void log.info(...)`.

type Level = "INFO" | "WARN" | "ERROR";

function serializeMeta(meta?: Record<string, unknown>): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined) continue;
    let val: string;
    if (v instanceof Error) val = v.message;
    else if (typeof v === "object") {
      try {
        val = JSON.stringify(v);
      } catch {
        val = String(v);
      }
    } else val = String(v);
    parts.push(`${k}=${val}`);
  }
  return parts.length ? " " + parts.join(" ") : "";
}

function write(level: Level, scope: string, event: string, meta?: Record<string, unknown>): void {
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${event}${serializeMeta(meta)}`;
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}

export function logger(scope: string) {
  return {
    info: (event: string, meta?: Record<string, unknown>) => write("INFO", scope, event, meta),
    warn: (event: string, meta?: Record<string, unknown>) => write("WARN", scope, event, meta),
    error: (event: string, meta?: Record<string, unknown>) => write("ERROR", scope, event, meta),
  };
}
