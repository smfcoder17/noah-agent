// Le titre d'une carte de lien, sans le nom du site qu'il répète déjà (« … on X », « … | YouTube », « … - Le Monde »).

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Les noms sous lesquels un site se cite : son nom donné, sans parenthèse (« X (formerly Twitter) » → « X »), son domaine. */
function siteNames(site: string, host: string) {
  const domain = host.replace(/^www\./, "");
  const brand = domain.split(".").slice(-2, -1)[0] ?? "";
  const names = [site, site.replace(/\s*\([^)]*\)\s*$/, ""), ...(site.match(/\(formerly ([^)]+)\)/i)?.slice(1) ?? []), domain, brand];
  if (brand === "x") names.push("Twitter"); // i18n-ignore : nom du site, comparé au titre de la page
  return [...new Set(names.map((n) => n.trim()).filter((n) => n.length > 0))].sort((a, b) => b.length - a.length);
}

export function linkTitle(title: string, site: string, host: string): string {
  let out = title.trim();
  const names = siteNames(site, host);
  for (let changed = true; changed;) {
    changed = false;
    for (const name of names) {
      // « on X », « sur YouTube », ou un séparateur : | · • - – — / :
      const suffix = new RegExp(`(?:\\s+(?:on|sur)\\s+|\\s*[|·•/]\\s*|\\s+[-–—:]\\s+)${escape(name)}\\s*$`, "i");
      const next = out.replace(suffix, "").trim();
      if (next && next !== out) { out = next; changed = true; }
    }
  }
  return out || title.trim();
}
