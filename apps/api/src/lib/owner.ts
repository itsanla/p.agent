// Single-owner gate: only the owner's number may use action tools (Trello) and
// the web chat. Set OWNER_PHONE in the environment (digits only or with +).

import { maskPhone } from "./format";
import { logger } from "./logger";

const log = logger("owner");

function normalize(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function isOwner(env: { OWNER_PHONE?: string }, phone: string): boolean {
  const owner = env.OWNER_PHONE;
  const result = owner ? normalize(owner) === normalize(phone) : false;
  log.info("isOwner", { phone: maskPhone(phone), result });
  return result;
}
