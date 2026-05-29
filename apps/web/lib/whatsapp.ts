import { maskPhone } from "./format";
import { logger } from "./logger";

const log = logger("whatsapp");

/** Send a text message to a WhatsApp number via the Meta Graph API. */
export async function sendWhatsAppMessage(phone: string, body: string): Promise<boolean> {
  const masked = maskPhone(phone);
  const phoneNumberId = process.env.WA_PHONE_NUMBER_ID;
  const accessToken = process.env.WA_ACCESS_TOKEN;
  if (!phoneNumberId || !accessToken) {
    void log.error("send.skipped", { reason: "WA_PHONE_NUMBER_ID or WA_ACCESS_TOKEN missing" });
    return false;
  }

  try {
    const res = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: phone,
        type: "text",
        text: { body },
      }),
    });
    if (!res.ok) {
      void log.error("send.failed", { phone: masked, status: res.status, body: await res.text() });
      return false;
    }
    void log.info("send.ok", { phone: masked, status: res.status });
    return true;
  } catch (err) {
    void log.error("send.error", { phone: masked, err: err instanceof Error ? err : String(err) });
    return false;
  }
}
