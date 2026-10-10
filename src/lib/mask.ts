/** Hide an email until the user asks to see it. Keeps the first letter and the domain suffix. */
export function maskEmail(email: string, shown: boolean): string {
  const value = email.trim();
  if (!value) return "";
  if (shown) return value;
  const at = value.indexOf("@");
  if (at <= 0) return "••••••••";
  const name = value.slice(0, at);
  const host = value.slice(at + 1);
  const dot = host.lastIndexOf(".");
  const hidden = (part: string) => (part ? `${part.slice(0, 1)}${"•".repeat(Math.max(1, part.length - 1))}` : "");
  const domain = dot > 0 ? `${hidden(host.slice(0, dot))}${host.slice(dot)}` : hidden(host);
  return `${hidden(name)}@${domain}`;
}
