import { logger } from "./logger";

const log = logger("slack");

export function isSlackConfigured(): boolean {
  return Boolean(process.env.SLACK_WEBHOOK_URL);
}

/** Post a message to Slack via an incoming webhook (SLACK_WEBHOOK_URL). */
export async function sendSlackMessage(text: string): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    void log.error("send.skipped", { reason: "SLACK_WEBHOOK_URL missing" });
    return false;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      void log.error("send.failed", { status: res.status, body: await res.text() });
      return false;
    }
    void log.info("send.ok", { status: res.status });
    return true;
  } catch (err) {
    void log.error("send.error", { err: err instanceof Error ? err : String(err) });
    return false;
  }
}
