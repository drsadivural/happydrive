/** Normalise Japanese phone input to E.164 (+81...). */
export function normalizePhone(input: string): string {
  const digits = input.replace(/[^0-9+]/g, '');
  if (digits.startsWith('+81')) return digits;
  if (digits.startsWith('0')) return `+81${digits.slice(1)}`;
  return digits;
}

export function maskPhone(e164: string): string {
  const local = e164.startsWith('+81') ? `0${e164.slice(3)}` : e164;
  return `${local.slice(0, 3)}-****-${local.slice(-4)}`;
}
