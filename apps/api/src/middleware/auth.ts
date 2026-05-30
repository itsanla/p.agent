import type { MiddlewareHandler } from "hono";

// Simple shared-secret gate for the web endpoints (/chat, /usage, /history).
// The frontend stores WEB_AUTH_SECRET in localStorage and sends it as a header.
export const requireSecret: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.WEB_AUTH_SECRET;
  if (!expected) return c.json({ error: "Server auth not configured" }, 500);

  const provided = c.req.header("x-linda-secret") ?? "";
  if (provided !== expected) return c.json({ error: "Unauthorized" }, 401);

  await next();
};
