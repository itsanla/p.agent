// Presentation helpers shared across UI components.

/** Mask a phone number: "6281234561234" → "+62 8xx-xxxx-1234". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return phone;
  const last4 = digits.slice(-4);
  // Heuristic country-code split: take leading 2 digits as CC when long enough.
  if (digits.length >= 11) {
    const cc = digits.slice(0, 2);
    const next = digits.slice(2, 3);
    return `+${cc} ${next}xx-xxxx-${last4}`;
  }
  return `xxxx-${last4}`;
}

/** Format a ms duration as "2m 14s" / "18h 42m" / "3d 4h". */
export function formatDuration(ms: number | null): string {
  if (ms == null || ms <= 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;

  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Compact number formatting with thousands separators. */
export function formatNumber(n: number | null): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

/** Relative time like "2m ago" / "3h ago" / "just now". */
export function timeAgo(ts: number | string | null): string {
  if (ts == null) return "—";
  const then = typeof ts === "string" ? new Date(ts).getTime() : ts;
  if (!Number.isFinite(then) || then === 0) return "—";
  const diff = Date.now() - then;
  if (diff < 60_000) return "just now";
  const m = Math.floor(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Percentage of remaining vs limit, clamped to 0–100. Null limit → null. */
export function remainingPct(remaining: number | null, limit: number | null): number | null {
  if (remaining == null || limit == null || limit <= 0) return null;
  return Math.max(0, Math.min(100, (remaining / limit) * 100));
}

export type StatusLevel = "green" | "yellow" | "red";

/** Health level from a remaining percentage (or limited flag). */
export function statusLevel(pct: number | null, isLimited: boolean): StatusLevel {
  if (isLimited) return "red";
  if (pct == null) return "green"; // no data yet → assume healthy
  if (pct < 20) return "red";
  if (pct < 50) return "yellow";
  return "green";
}
