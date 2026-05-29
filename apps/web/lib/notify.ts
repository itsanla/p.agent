import { maskPhone } from "./format";
import { logger } from "./logger";
import { getLastInbound } from "./redis";
import { isSlackConfigured, sendSlackMessage } from "./slack";
import { sendWhatsAppMessage } from "./whatsapp";

const log = logger("notify");

// WhatsApp's customer-service window is 24h; we stay just under it. Past this,
// Meta rejects free-form WhatsApp messages, so we fall back to Slack instead.
const WINDOW_MS = 23 * 60 * 60 * 1000;

export type NotifyChannel = "whatsapp" | "slack";

/**
 * Route a proactive notification to EXACTLY ONE channel, decided by how long ago
 * the user last messaged us: WhatsApp if within 23h, otherwise Slack. Never both.
 * If we have no record of an inbound message, we treat it as outside the window.
 */
export async function notifyOwner(
  phone: string,
  text: string,
): Promise<{ channel: NotifyChannel; ok: boolean }> {
  const lastInbound = await getLastInbound(phone);
  const elapsedMs = lastInbound != null ? Date.now() - lastInbound : Number.POSITIVE_INFINITY;
  const withinWindow = elapsedMs < WINDOW_MS;
  const elapsedH = Number.isFinite(elapsedMs) ? Math.round((elapsedMs / 3.6e6) * 10) / 10 : null;

  if (withinWindow) {
    const ok = await sendWhatsAppMessage(phone, text);
    void log.info("route", { phone: maskPhone(phone), channel: "whatsapp", elapsedH, ok });
    return { channel: "whatsapp", ok };
  }

  const ok = await sendSlackMessage(text);
  void log.info("route", {
    phone: maskPhone(phone),
    channel: "slack",
    elapsedH,
    slackConfigured: isSlackConfigured(),
    ok,
  });
  return { channel: "slack", ok };
}
