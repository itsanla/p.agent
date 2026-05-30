// Single-owner gate: only the owner's number may use action tools (Trello) and
// the web chat. Set OWNER_PHONE in the environment (digits only or with +).

function normalize(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function isOwner(env: { OWNER_PHONE?: string }, phone: string): boolean {
  const owner = env.OWNER_PHONE;
  if (!owner) return false; // no owner configured → tools disabled for everyone
  return normalize(owner) === normalize(phone);
}
