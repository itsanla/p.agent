import { NextRequest } from "next/server";
import { logger } from "@/lib/logger";
import { notifyOwner } from "@/lib/notify";
import { getRedis } from "@/lib/redis";
import { getDueSoonCards, isTrelloConfigured, type DueCard } from "@/lib/trello";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const log = logger("cron");
const REMIND_WINDOW_HOURS = 24;

// Notify the owner about Trello cards due within 24h. Idempotent per card+due via
// a Redis marker, so repeated cron runs don't spam. Trigger hourly (see vercel.json).
export async function GET(req: NextRequest): Promise<Response> {
  // Auth: allow Vercel Cron, or a matching CRON_SECRET bearer/query.
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get("authorization");
    const fromVercel = req.headers.get("x-vercel-cron");
    const qs = req.nextUrl.searchParams.get("secret");
    if (auth !== `Bearer ${secret}` && qs !== secret && !fromVercel) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  const owner = process.env.OWNER_PHONE;
  if (!owner) {
    void log.error("trello-reminder.skip", { reason: "OWNER_PHONE not set" });
    return Response.json({ ok: false, reason: "OWNER_PHONE not set" }, { status: 200 });
  }
  if (!isTrelloConfigured()) {
    void log.error("trello-reminder.skip", { reason: "Trello not configured" });
    return Response.json({ ok: false, reason: "Trello not configured" }, { status: 200 });
  }

  try {
    const due = await getDueSoonCards(REMIND_WINDOW_HOURS);
    const fresh: DueCard[] = [];
    for (const card of due) {
      if (await claimReminder(card)) fresh.push(card);
    }

    let channel: string | null = null;
    if (fresh.length > 0) {
      // Router picks WhatsApp (within 24h window) or Slack (older) — never both.
      ({ channel } = await notifyOwner(owner, formatReminder(fresh)));
    }
    void log.info("trello-reminder.run", { dueSoon: due.length, notified: fresh.length, channel });
    return Response.json({ ok: true, dueSoon: due.length, notified: fresh.length, channel });
  } catch (err) {
    void log.error("trello-reminder.failed", { err: err instanceof Error ? err : String(err) });
    return Response.json({ ok: false, error: "reminder failed" }, { status: 500 });
  }
}

// One marker per (card, due value); 26h TTL so a rescheduled due re-notifies.
async function claimReminder(card: DueCard): Promise<boolean> {
  try {
    const key = `trello:reminded:${card.id}:${card.due}`;
    const res = await getRedis().set(key, "1", { nx: true, ex: 26 * 3600 });
    return res === "OK";
  } catch {
    return true; // fail open: better to remind than to silently drop
  }
}

function formatReminder(cards: DueCard[]): string {
  const lines = cards.map((c) => {
    const h = c.hoursLeft;
    const when =
      h < 0
        ? `⚠️ TERLEWAT ${fmtDur(-h)} lalu`
        : `⏰ ${fmtDur(h)} lagi`;
    return `• ${c.name} (${c.boardName}) — ${when}`;
  });
  const head =
    cards.length === 1
      ? "Halo! Ada 1 tugas Trello yang mendekati deadline:"
      : `Halo! Ada ${cards.length} tugas Trello yang mendekati deadline:`;
  return `${head}\n\n${lines.join("\n")}`;
}

function fmtDur(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} menit`;
  if (hours < 24) return `${Math.round(hours)} jam`;
  return `${Math.round(hours / 24)} hari`;
}
