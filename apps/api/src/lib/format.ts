/** Mask a phone number for logs: "6281234561234" → "+62 8xx-xxxx-1234". */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 6) return phone;
  const last4 = digits.slice(-4);
  if (digits.length >= 11) {
    const cc = digits.slice(0, 2);
    const next = digits.slice(2, 3);
    return `+${cc} ${next}xx-xxxx-${last4}`;
  }
  return `xxxx-${last4}`;
}
