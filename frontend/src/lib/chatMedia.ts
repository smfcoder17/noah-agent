// Ce qu'un message montre : les vidéos des plateformes reconnues et les images de la machine de l'agent, une seule fois chacune.
// Module pur, sans navigateur : tests/chat/medias_test.mjs le lance dans Node. L'agent peut écrire n'importe quoi : aucune adresse
// de cadre ni de lien ne reprend son texte, tout est reconstruit à partir d'identifiants validés.

export type VideoPlatform = "youtube" | "vimeo" | "x" | "tiktok" | "instagram";

export type VideoRef = {
  platform: VideoPlatform;
  /** Nom montré : « Ouvrir dans YouTube ». */
  name: string;
  /** « Vidéo YouTube », « Publication X » : le titre quand on n'en connaît pas d'autre. */
  label: string;
  /** Identifie la vidéo : deux adresses de la même vidéo ont la même clé. */
  key: string;
  openUrl: string;
  /** Null : la plateforme ne donne pas de lecteur pour cette adresse (lien raccourci). La carte ouvre alors dehors. */
  embedUrl: string | null;
  portrait: boolean;
};

/** Les seuls hôtes admis en cadre. tests/chat/medias_test.mjs vérifie qu'ils sont ceux de frame-src dans server/noah/exposition.py. */
export const EMBED_HOSTS = ["www.youtube-nocookie.com", "player.vimeo.com", "platform.twitter.com", "www.tiktok.com", "www.instagram.com"];

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{6,12}$/;
const VIMEO_HASH = /^[0-9a-f]{6,20}$/;
const TWEET_ID = /^\d{5,25}$/;
const X_USER = /^[A-Za-z0-9_]{1,15}$/;
const TIKTOK_ID = /^\d{10,25}$/;
const TIKTOK_USER = /^@[A-Za-z0-9_.]{1,40}$/;
const TIKTOK_SHORT = /^[A-Za-z0-9]{5,15}$/;
const INSTAGRAM_CODE = /^[A-Za-z0-9_-]{5,40}$/;

const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"]);
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);
const X_HOSTS = new Set(["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
const TIKTOK_HOSTS = new Set(["tiktok.com", "www.tiktok.com", "m.tiktok.com"]);
const TIKTOK_SHORT_HOSTS = new Set(["vm.tiktok.com", "vt.tiktok.com"]);
const INSTAGRAM_HOSTS = new Set(["instagram.com", "www.instagram.com"]);

/** « 90 », « 90s », « 1m30s », « 1h2m3s » en secondes ; le reste vaut 0. */
function startOf(value: string | null) {
  const m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m)?(?:(\d{1,6})s?)?$/.exec(value ?? "");
  return m ? Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) : 0;
}

function youtube(id: string | null | undefined, kind: "watch" | "shorts", start: number): VideoRef | null {
  if (!id || !YOUTUBE_ID.test(id)) return null;
  const at = start > 0 ? start : 0;
  return {
    platform: "youtube",
    name: "YouTube",
    label: "Vidéo YouTube",
    key: `youtube:${id}`,
    openUrl: kind === "shorts" ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}${at ? `&t=${at}s` : ""}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&playsinline=1${at ? `&start=${at}` : ""}`,
    portrait: kind === "shorts",
  };
}

function fromYoutube(u: URL, path: string[]) {
  const start = startOf(u.searchParams.get("t") ?? u.searchParams.get("start"));
  if (u.hostname === "youtu.be") return path.length === 1 ? youtube(path[0], "watch", start) : null;
  if (path.length === 1 && path[0] === "watch") return youtube(u.searchParams.get("v"), "watch", start);
  if (path.length === 2 && path[0] === "shorts") return youtube(path[1], "shorts", 0);
  if (path.length === 2 && ["embed", "live", "v"].includes(path[0])) return youtube(path[1], "watch", start);
  return null;
}

function fromVimeo(u: URL, path: string[]): VideoRef | null {
  let id: string | undefined;
  let hash = u.searchParams.get("h");
  if (u.hostname === "player.vimeo.com") id = path[0] === "video" && path.length === 2 ? path[1] : undefined;
  else if (path.length === 1) id = path[0];
  else if (path.length === 2 && VIMEO_HASH.test(path[1])) [id, hash] = path; // vidéo non répertoriée : vimeo.com/ID/CLÉ
  else if (path.length === 3 && path[0] === "channels") id = path[2];
  else if (path.length === 4 && path[0] === "groups" && path[2] === "videos") id = path[3];
  if (!id || !VIMEO_ID.test(id)) return null;
  const secret = hash && VIMEO_HASH.test(hash) ? hash : "";
  return {
    platform: "vimeo",
    name: "Vimeo",
    label: "Vidéo Vimeo",
    key: `vimeo:${id}`,
    openUrl: `https://vimeo.com/${id}${secret ? `/${secret}` : ""}`,
    embedUrl: `https://player.vimeo.com/video/${id}?autoplay=1&dnt=1${secret ? `&h=${secret}` : ""}`,
    portrait: false,
  };
}

function fromX(path: string[]): VideoRef | null {
  let user: string | undefined;
  let id: string | undefined;
  let rest: string[] = [];
  if (path[0] === "i" && path[1] === "web" && path[2] === "status") [id, ...rest] = path.slice(3);
  else if (path[1] === "status") {
    user = path[0];
    [id, ...rest] = path.slice(2);
  }
  if (!id || !TWEET_ID.test(id)) return null;
  if (user !== undefined && !X_USER.test(user)) return null;
  if (rest.length && !(rest.length === 2 && rest[0] === "video" && /^\d{1,2}$/.test(rest[1]))) return null;
  return {
    platform: "x",
    name: "X",
    label: "Publication X",
    key: `x:${id}`,
    openUrl: `https://x.com/${user && user !== "i" ? user : "i"}/status/${id}`,
    embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${id}&dnt=true`,
    portrait: true,
  };
}

function fromTiktok(path: string[]): VideoRef | null {
  let user = "@";
  let id: string | undefined;
  if (path.length === 3 && path[1] === "video" && TIKTOK_USER.test(path[0])) [user, , id] = path;
  else if (path.length === 3 && path[0] === "embed" && path[1] === "v2") id = path[2];
  else if (path.length === 2 && path[0] === "embed") id = path[1];
  else if (path.length === 2 && path[0] === "t") return tiktokShort(`www.tiktok.com/t`, path[1]);
  if (!id || !TIKTOK_ID.test(id)) return null;
  return {
    platform: "tiktok",
    name: "TikTok",
    label: "Vidéo TikTok",
    key: `tiktok:${id}`,
    openUrl: `https://www.tiktok.com/${user}/video/${id}`,
    embedUrl: `https://www.tiktok.com/embed/v2/${id}`,
    portrait: true,
  };
}

function tiktokShort(base: string, code: string | undefined): VideoRef | null {
  if (!code || !TIKTOK_SHORT.test(code)) return null;
  return { platform: "tiktok", name: "TikTok", label: "Vidéo TikTok", key: `tiktok:${code}`, openUrl: `https://${base}/${code}/`, embedUrl: null, portrait: true };
}

function fromInstagram(path: string[]): VideoRef | null {
  const at = path.length === 3 ? 1 : 0; // instagram.com/compte/reel/CODE
  if (path.length !== at + 2 || !["p", "reel", "reels", "tv"].includes(path[at])) return null;
  const code = path[at + 1];
  if (!INSTAGRAM_CODE.test(code)) return null;
  const kind = path[at] === "reels" ? "reel" : path[at];
  return {
    platform: "instagram",
    name: "Instagram",
    label: kind === "p" ? "Publication Instagram" : "Vidéo Instagram",
    key: `instagram:${code}`,
    openUrl: `https://www.instagram.com/${kind}/${code}/`,
    embedUrl: `https://www.instagram.com/${kind}/${code}/embed/`,
    portrait: true,
  };
}

/** La vidéo que désigne cette adresse. Null pour tout le reste : hôte inconnu ou ressemblant, autre protocole, identifiant douteux. */
export function videoFromUrl(raw: unknown): VideoRef | null {
  if (typeof raw !== "string" || raw.length > 500 || !/^https?:\/\//i.test(raw) || /[\s"'<>\\`]/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.username || u.password || u.port) return null; // youtube.com@evil.com, ou un service local derrière un nom connu
  const path = u.pathname.split("/").filter(Boolean);
  const host = u.hostname.toLowerCase();
  if (host === "youtu.be" || YOUTUBE_HOSTS.has(host)) return fromYoutube(u, path);
  if (VIMEO_HOSTS.has(host)) return fromVimeo(u, path);
  if (X_HOSTS.has(host)) return fromX(path);
  if (TIKTOK_SHORT_HOSTS.has(host)) return path.length === 1 ? tiktokShort(host, path[0]) : null;
  if (TIKTOK_HOSTS.has(host)) return fromTiktok(path);
  if (INSTAGRAM_HOSTS.has(host)) return fromInstagram(path);
  return null;
}

// --- Le texte d'un message --------------------------------------------------------------

const IMAGE_PATH = String.raw`\/(?:opt\/data|tmp)\/[^\s"'\x60)\]>]+\.(?:png|jpe?g|gif|webp)`;
// « ![nom](/chemin.png) » ou « [nom](/chemin.png) », puis « MEDIA:/chemin.png » ou un chemin nu, pas celui qui finit une adresse web.
const IMAGE_MENTION = new RegExp(String.raw`!?\[[^\]\n]*\]\(\s*<?(?:MEDIA:\s*)?(${IMAGE_PATH})>?\s*\)|\x60?(?:MEDIA:\s*|(?<![\w:/.~%-]))(${IMAGE_PATH})\x60?`, "gi");
// « MEDIA: » occupe toute la ligne : son chemin peut contenir des espaces.
const MEDIA_LINE = /^\s*MEDIA:\s*(\/(?:opt\/data|tmp)\/(?:(?!\s\/|\s*MEDIA:)[^"'`])+\.(?:png|jpe?g|gif|webp))\s*$/i;
const LIST_MARK = /^ {0,3}(?:[-*+]|\d{1,3}[.)]) +/;
// Un autre fichier de l'espace de travail devient un lien qui s'ouvre dans la visionneuse.
const FILE_RE = /(?:MEDIA:\s*)?`?(\/opt\/data\/workspace\/[^\s"'`)\]]+\.[a-z0-9]{1,6})`?/gi;
// Une app, un PDF, un son ou une vidéo se montre en aperçu intégré, même si l'agent n'a donné que le chemin.
const PREVIEW_EXT = /\.(html?|pdf|mp3|wav|ogg|m4a|mp4|webm|mov)$/i;
const LONE_URL = /^ {0,3}(?:[-*+] +)?(?:\*\*|__)?(?:<(https?:\/\/[^\s<>]+)>|\[([^\]\n]{0,200})\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/\S+?))(?:\*\*|__)?[.,;:!?]*\s*$/i;
// Les blocs de code gardent leur texte. Le bloc pas encore fermé d'une réponse en cours va jusqu'à la fin.
const CODE_BLOCKS = /(```[\s\S]*?(?:```|(?![\s\S]))|^~~~[\s\S]*?(?:^~~~|(?![\s\S])))/m;
const WIDGET_BLOCK = /```noah\s*\n?([\s\S]*?)(?:```|(?![\s\S]))/g;

const samePath = (path: string) => path.replace(/^\/opt\/data\/workspace\//, "").replace(/^\.\//, "");
const fileName = (path: string) => path.split("/").pop() || path;
const fence = (spec: Record<string, unknown>) => `\`\`\`noah\n${JSON.stringify(spec)}\n\`\`\``;

function widgetsIn(text: string) {
  const out: Record<string, unknown>[] = [];
  for (const [, body] of text.matchAll(WIDGET_BLOCK)) {
    try {
      const spec = JSON.parse(body);
      if (spec && typeof spec === "object") out.push(spec);
    } catch {
      // Le JSON qui arrive : son chemin compte déjà, pour ne pas montrer la même image un instant.
      const partial = /"(?:path|image)"\s*:\s*"([^"]+)"/.exec(body);
      if (partial) out.push({ type: "preview", path: partial[1] });
    }
  }
  return out;
}

/** Les fichiers que des widgets montrent déjà : aperçu, et images d'une grille, d'un post ou d'un produit. */
function shownByWidgets(text: string) {
  const out = new Set<string>();
  for (const spec of widgetsIn(text)) {
    if (spec.type === "preview" && typeof spec.path === "string") out.add(samePath(spec.path));
    const items = Array.isArray(spec.items) ? spec.items as { image?: unknown; images?: unknown }[] : spec.type === "post" ? [spec as { image?: unknown; images?: unknown }] : [];
    for (const item of items) {
      for (const image of [item?.image, ...(Array.isArray(item?.images) ? item.images : [])]) if (typeof image === "string") out.add(samePath(image));
    }
  }
  return out;
}

function imagesMentioned(text: string) {
  const out = new Set<string>();
  text.split(CODE_BLOCKS).forEach((chunk, i) => {
    if (i % 2) return;
    for (const line of chunk.split("\n")) {
      const whole = MEDIA_LINE.exec(line);
      if (whole) out.add(samePath(whole[1]));
      else for (const m of line.matchAll(IMAGE_MENTION)) out.add(samePath(m[1] ?? m[2]));
    }
  });
  return out;
}

export type MessageContext = {
  /** Adresse d'un fichier de l'espace de travail, pour un lien. */
  fileUrl: (path: string) => string;
  /** Le texte des parties du même message avant et après celle-ci : une réponse se coupe à chaque outil utilisé. */
  before?: string;
  after?: string;
  /** La réponse s'écrit encore : sa dernière ligne n'est peut-être pas finie. */
  streaming?: boolean;
};

/**
 * Transforme le texte d'un message avant le Markdown. Chaque image de l'agent devient un seul widget d'aperçu, quel que soit le nombre
 * de fois où il la cite et sous quelle forme. Une adresse de vidéo reconnue, seule sur sa ligne, devient un widget vidéo.
 * Les blocs de code restent intacts.
 */
export function linkMessage(text: string, { fileUrl, before = "", after = "", streaming = false }: MessageContext) {
  const later = new Set([...shownByWidgets(text), ...shownByWidgets(after)]);
  const shown = shownByWidgets(before);
  // Une partie précédente a cité l'image sans la montrer si un widget plus loin s'en charge : c'est à ce widget de la montrer.
  for (const path of imagesMentioned(before)) if (!later.has(path)) shown.add(path);
  const seenBefore = new Set(shown);
  for (const path of later) shown.add(path);
  const files = new Set<string>(shown);
  const videos = new Set<string>();
  for (const spec of widgetsIn(`${before}\n${text}`)) {
    if (spec.type === "video") {
      const known = videoFromUrl(spec.url);
      if (known) videos.add(known.key);
    }
  }
  for (const line of before.split("\n")) {
    const lone = LONE_URL.exec(line);
    const known = lone && videoFromUrl(lone[1] ?? lone[3] ?? lone[4]);
    if (known) videos.add(known.key);
  }
  const body = text.split(CODE_BLOCKS);
  const lastProse = body.length - 1 - ((body.length - 1) % 2);
  return body
    .map((chunk, i) => {
      if (i % 2) return repeatedPreview(chunk, seenBefore) ? "" : chunk;
      const lines = chunk.split("\n");
      const out: string[] = [];
      let waiting: string[] = [];
      const release = () => {
        if (waiting.length) out.push("", ...waiting.flatMap((w) => [w, ""]));
        waiting = [];
      };
      lines.forEach((line, n) => {
        const unfinished = streaming && i === lastProse && n === lines.length - 1;
        // Le chemin d'une image en train d'arriver ne s'affiche pas : il laissera place au widget.
        if (unfinished && /^\s*MEDIA:\s*\//i.test(line) && !MEDIA_LINE.test(line)) return;
        if (!unfinished) {
          const lone = LONE_URL.exec(line);
          const video = lone && videoFromUrl(lone[1] ?? lone[3] ?? lone[4]);
          if (video && !videos.has(video.key)) {
            videos.add(video.key);
            release();
            const title = lone?.[2]?.trim();
            out.push("", fence({ type: "video", url: video.openUrl, ...(title ? { title } : {}) }), "");
            return;
          }
        }
        const { rest, widgets } = imagesOf(line, shown);
        const linked = rest === null ? null : linkFiles(rest, fileUrl, files);
        waiting.push(...widgets);
        if (linked !== null) {
          // Une ligne de tableau ne se coupe pas : le widget attend la fin du tableau.
          if (!linked.trimStart().startsWith("|")) {
            out.push(linked);
            release();
          } else out.push(linked);
        } else release();
      });
      release();
      return out.join("\n");
    })
    .join("");
}

/** Un widget d'aperçu répété dans une autre partie du message : par exemple un flux repris. */
function repeatedPreview(chunk: string, seen: Set<string>) {
  const [spec] = chunk.startsWith("```noah") ? widgetsIn(chunk) : [];
  if (spec?.type !== "preview" || typeof spec.path !== "string") return false;
  const key = samePath(spec.path);
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

/** Une ligne, sans ses images. rest : ce qu'il reste à afficher ; null si la ligne n'était faite que d'images. */
function imagesOf(line: string, shown: Set<string>): { rest: string | null; widgets: string[] } {
  const widgets: string[] = [];
  const show = (path: string) => {
    const key = samePath(path);
    if (shown.has(key)) return;
    shown.add(key);
    widgets.push(fence({ type: "preview", path }));
  };
  const whole = MEDIA_LINE.exec(line);
  if (whole) {
    show(whole[1]);
    return { rest: null, widgets };
  }
  if (/^(?: {4}|\t)/.test(line) && !/MEDIA:/i.test(line)) return { rest: line, widgets }; // bloc de code indenté
  let found = false;
  const prose = line.replace(IMAGE_MENTION, (_m, linked: string | undefined, bare: string | undefined) => {
    const path = (linked ?? bare)!;
    found = true;
    show(path);
    return `\u0000${fileName(path)}\u0000`;
  });
  if (!found) return { rest: line, widgets };
  // Plus rien d'autre sur la ligne que le nom des images : le widget les remplace. Sinon le nom reste dans la phrase.
  const words = prose.replace(LIST_MARK, "").replace(/\u0000[^\u0000]*\u0000/g, "").replace(/[\s,;:.·*_]+/g, "");
  if (!words) return { rest: null, widgets };
  return { rest: prose.replace(/\u0000([^\u0000]*)\u0000/g, "`$1`"), widgets };
}

function linkFiles(line: string, fileUrl: (path: string) => string, previewed: Set<string>) {
  return line.replace(FILE_RE, (m, path: string, offset: number, all: string) => {
    if (all.slice(Math.max(0, offset - 2), offset).includes("](") || all[offset - 1] === "(") return m;
    const key = samePath(path);
    if (PREVIEW_EXT.test(path) && !previewed.has(key)) {
      previewed.add(key);
      return `\n\n${fence({ type: "preview", path })}\n\n`;
    }
    return `[${fileName(path)}](${fileUrl(path)})`;
  });
}

const VIDEO_WIDGET = /```noah\s*\{"type":"video","url":"([^"]+)"[^\n]*\}\s*```/g;
const PREVIEW_WIDGET = /```noah\s*\{"type":"preview","path":"([^"]+)"\}\s*```/g;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp)$/i;

/** Pour l'appel : un aperçu compte comme un artefact à ouvrir, une image reste une image, une vidéo reste son adresse. */
export function plainWidgets(linked: string, fileUrl: (path: string) => string, imageUrl: (path: string) => string) {
  return linked
    .replace(PREVIEW_WIDGET, (_m, path: string) => (IMAGE_FILE.test(path) ? `![${fileName(path)}](${imageUrl(path)})` : `[${fileName(path)}](${fileUrl(path)})`))
    .replace(VIDEO_WIDGET, (_m, url: string) => videoFromUrl(url)?.openUrl ?? "");
}
