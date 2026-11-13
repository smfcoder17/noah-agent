export type SensitivePart = { value: string; masked: string; sensitive: boolean };
export function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
  let sum = 0;
  for (let i = digits.length - 1, double = false; i >= 0; i--, double = !double) { let n = Number(digits[i]); if (double) { n *= 2; if (n > 9) n -= 9; } sum += n; }
  return sum % 10 === 0;
}
/** Une vraie carte : Luhn, et le début que son réseau donne à cette longueur. Un identifiant de post X (19 chiffres, commence
 * par 1 ou 2) passe Luhn une fois sur dix : écrit seul dans une phrase, il n'est plus pris pour une carte. */
export function card(value: string): boolean {
  const d = value.replace(/\D/g, "");
  const starts = d.length === 13 ? /^4/ : d.length === 14 ? /^3[068]/ : d.length === 15 ? /^3[47]/ : d.length === 16 ? /^[2-6]/ : /^[46]/;
  return luhn(value) && starts.test(d);
}
/** Adresses web (avec ou sans schéma) et chemins : leurs nombres sont des identifiants, jamais des cartes ni des téléphones. */
const ADDRESS = /(?:\b(?:https?|ftp):\/\/|\bwww\.)[^\s<>"'`]+|\b[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}\/[^\s<>"'`]*|(?:\b[A-Za-z]:)?(?:[\\/][\p{L}\p{N}_.-]+){2,}/gu;
/** Un nombre collé à une lettre, un chiffre ou l'un de / = # _ - \ appartient à un identifiant. */
const GLUED = /[\p{L}\p{N}/=#_\\-]/u;
export function sensitiveParts(text: string): SensitivePart[] {
  const matches: { start: number; end: number; masked: string }[] = [];
  const addresses = [...text.matchAll(ADDRESS)].map((m) => ({ start: m.index!, end: m.index! + m[0].length }));
  const identifier = (start: number, end: number) => addresses.some((a) => start < a.end && end > a.start)
    || GLUED.test(text[start - 1] ?? "") || GLUED.test(text[end] ?? "") || /^\.\p{L}/u.test(text.slice(end, end + 2));
  const add = (r: RegExp, mask: (value: string) => string | null, input = text, numeric = false) => {
    for (const match of input.matchAll(r)) { const value = match[1] ?? match[0]; const start = match.index!, end = start + value.length; if (matches.some((m) => start < m.end && end > m.start)) continue; if (numeric && identifier(start, end)) continue; const masked = mask(value); if (masked) matches.push({ start, end, masked }); }
  };
  add(/[\p{L}\p{N}.!#$%&'*+\/=?^_`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?(?:\.[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?)+/gu, (v) => { const [local, host] = v.split("@"); return `${local.slice(0, 2)}•••@${host[0]}•••.${host.split(".").pop()}`; });
  add(/(?<!\d)(?=((?:(?:\d{4}[ -]){2}\d{4}[ -]\d{1,4}(?:[ -]\d{1,3})?|\d{4}[ -]\d{6}[ -]\d{5}|\d{13,19}))(?!\d))/g, (v) => card(v) ? `•••• •••• •••• ${v.replace(/\D/g, "").slice(-4)}` : null, text, true);
  const phonesOnly = matches.reduce((s, m) => s.slice(0, m.start) + "x".repeat(m.end - m.start) + s.slice(m.end), text);
  add(/(?<![\w\d])(?:\+\d{1,3}[ .()-]*|0)(?:\d[ .()-]*){8,13}\d(?!\d)|(?<![\w\d])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/g, (v) => { const n = v.replace(/\D/g, ""); return n.length >= 10 && n.length <= 15 && !luhn(v) ? `${v.startsWith("+") ? "+" : ""}${n.slice(0, 2)} ••• •• ${n.slice(-2)}` : null; }, phonesOnly, true);
  matches.sort((a, b) => a.start - b.start);
  const parts: SensitivePart[] = []; let at = 0;
  for (const m of matches) { if (m.start > at) parts.push({ value: text.slice(at, m.start), masked: text.slice(at, m.start), sensitive: false }); parts.push({ value: text.slice(m.start, m.end), masked: m.masked, sensitive: true }); at = m.end; }
  if (at < text.length) parts.push({ value: text.slice(at), masked: text.slice(at), sensitive: false });
  return parts;
}
