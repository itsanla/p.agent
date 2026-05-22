// Single-owner gate: only the owner's WhatsApp number may use action tools
// (Trello, etc.). Set OWNER_PHONE in the environment (digits only or with +).

function normalize(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function isOwner(phone: string): boolean {
  const owner = process.env.OWNER_PHONE;
  if (!owner) return false; // no owner configured → tools disabled for everyone
  return normalize(owner) === normalize(phone);
}
