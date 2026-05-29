import { appendFile, mkdir } from "fs/promises";
import path from "path";

// Event log for WhatsApp / webhook logic. Written to logs/next.log (and stdout).
// On read-only filesystems (e.g. some serverless targets) file writes fail
// silently and we keep logging to the console.

const LOG_DIR = path.join(process.cwd(), "logs");
const LOG_FILE = path.join(LOG_DIR, "next.log");

type Level = "INFO" | "WARN" | "ERROR";

let dirReady: Promise<void> | null = null;
function ensureDir(): Promise<void> {
  if (!dirReady) {
    dirReady = mkdir(LOG_DIR, { recursive: true }).then(() => undefined);
  }
  return dirReady;
}

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

async function write(level: Level, scope: string, event: string, meta?: Record<string, unknown>) {
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${event}${serializeMeta(meta)}`;

  // Console first so logs are never lost even if the file write fails.
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);

  try {
    await ensureDir();
    await appendFile(LOG_FILE, line + "\n", "utf8");
  } catch (err) {
    // Reset so a transient failure can retry creating the dir next time.
    dirReady = null;
    console.error(`[logger] failed to write ${LOG_FILE}:`, err);
  }
}

/** Scoped logger. Use `logger("whatsapp")` and call .info/.warn/.error. */
export function logger(scope: string) {
  return {
    info: (event: string, meta?: Record<string, unknown>) => write("INFO", scope, event, meta),
    warn: (event: string, meta?: Record<string, unknown>) => write("WARN", scope, event, meta),
    error: (event: string, meta?: Record<string, unknown>) => write("ERROR", scope, event, meta),
  };
}

export const LOG_FILE_PATH = LOG_FILE;
