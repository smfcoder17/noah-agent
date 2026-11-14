import { currentAuthEpoch, request } from "./api";
import { SEEN, seenGeneration } from "./seen";
import { t } from "@/i18n";

const pending = new Map<string, Promise<string>>();
let session = `${seenGeneration()}|${currentAuthEpoch()}`;

/** Les anciens mots de passe quittent aussi la mémoire, pas seulement les clés consultées. */
function syncSession() {
  const now = `${seenGeneration()}|${currentAuthEpoch()}`;
  if (now !== session) {
    for (const path of SEEN.keys()) if (path.endsWith("/screen-url")) SEEN.delete(path);
    pending.clear();
    session = now;
  }
  return session;
}
const key = (agentId: string) => `${syncSession()}|/api/agents/${agentId}/screen-url`;
window.addEventListener("noah:auth-epoch", syncSession);
window.addEventListener("storage", (event) => {
  if (event.key === "noah-auth-epoch" || event.key === null) syncSession();
});

/** Lien sensible en mémoire seulement, purgé au changement de connexion, relu seulement si absent ou refusé. */
export const peekScreenUrl = (agentId: string) => SEEN.get(key(agentId)) as string | undefined;

export function screenUrl(agentId: string): Promise<string> {
  const path = key(agentId);
  const known = peekScreenUrl(agentId);
  if (known) return Promise.resolve(known);
  const waiting = pending.get(path);
  if (waiting) return waiting;
  const generation = seenGeneration();
  const result = request(`/api/agents/${agentId}/screen-url?view_only=1`, { signal: AbortSignal.timeout(8000) })
    .then((r) => r.json() as Promise<{ url: string }>).then(({ url }) => {
    if (generation !== seenGeneration() || path !== key(agentId) || pending.get(path) !== result) throw new Error(t("La connexion ou le lien a changé."));
    SEEN.set(path, url);
    return url;
  }).finally(() => { if (pending.get(path) === result) pending.delete(path); });
  pending.set(path, result);
  return result;
}

/** Un refus explicite de l'écran invalide son lien ; une coupure passagère le conserve. */
export function refuseScreenUrl(agentId: string) {
  SEEN.delete(key(agentId));
  pending.delete(key(agentId));
}

// G7.7 : changer de mode reste un aller-retour serveur, même avec un lien déjà en mémoire.
export const screenControl = (agentId: string, control: boolean) =>
  request(`/api/agents/${agentId}/screen-url?view_only=${control ? 0 : 1}`, {
    method: "POST", body: "{}", signal: AbortSignal.timeout(8000),
  });

/** noVNC applique ce réglage à sa connexion existante, sans changer src ni détacher l'iframe. */
export function screenViewOnly(frame: HTMLIFrameElement | null, viewOnly: boolean): boolean {
  const input = frame?.contentDocument?.getElementById("noVNC_setting_view_only") as HTMLInputElement | null;
  if (!input) return false;
  input.checked = viewOnly;
  const event = input.ownerDocument.createEvent("Event"); // i18n-ignore : type d'événement DOM
  event.initEvent("change", true, false);
  input.dispatchEvent(event);
  return true;
}

/** noVNC marque sa page `noVNC_connected` tant que le flux passe. On suit ce marqueur au fil de l'eau, et non au relevé
 * suivant du serveur : un relevé tombé pendant la connexion cachait l'écran derrière « Connexion à l'écran… » jusqu'au
 * relevé d'après (30 à 60 s), puis le rendait : un écran qui « se recharge tout seul ». Une coupure plus courte que
 * `grace` (noVNC se reconnecte de lui-même) ne change rien à l'écran. */
export function watchScreenConnection(doc: Document, onChange: (connected: boolean) => void, grace = 3000): () => void {
  const root = doc.documentElement;
  let last: boolean | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const report = (connected: boolean) => { if (last !== connected) { last = connected; onChange(connected); } };
  const check = () => {
    if (root.classList.contains("noVNC_connected")) {
      clearTimeout(timer);
      timer = undefined;
      report(true);
    } else if (last === null) {
      report(false); // première connexion : l'écran attend, sans montrer la page de noVNC
    } else if (last && timer === undefined) {
      timer = setTimeout(() => { timer = undefined; if (!root.classList.contains("noVNC_connected")) report(false); }, grace);
    }
  };
  const observer = new MutationObserver(check);
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  check();
  return () => { observer.disconnect(); clearTimeout(timer); };
}
