// Où tourne l'interface : navigateur, app de bureau (Electron) ou app mobile (Capacitor, interface du serveur ouverte
// dans la fenêtre de l'app). Les apps se relient par un code ou une autorisation, jamais par le mot de passe.

type Shell = { kind: "desktop" | "android"; forget(): Promise<unknown>; version(): Promise<string> };

declare global {
  interface Window {
    Capacitor?: { Plugins?: Record<string, Record<string, (arg?: unknown) => Promise<unknown>>> };
    /** Bouton Retour d'Android : vrai si l'interface a fermé quelque chose. */
    noahRetour?: () => boolean;
  }
}

/** Dans l'app Android : la fenêtre n'affiche pas les PDF ni les CSV, et n'a pas d'onglets. */
export const inAndroidApp = () => appShell()?.kind === "android";

/** Enregistre un fichier fabriqué dans la page, là où un lien blob: ne téléchargerait rien. Faux : au navigateur de le faire. */
export function nativeSave(name: string, mime: string, text: string) {
  const save = window.Capacitor?.Plugins?.NoahShell?.saveFile;
  if (!save) return false;
  void save({ name, mime, text }).catch(() => {});
  return true;
}

export function appShell(): Shell | null {
  const d = window.noahDesktop;
  if (d?.forgetServer) return { kind: "desktop", forget: () => d.forgetServer!(), version: async () => (typeof d.version === "function" ? await d.version() : d.version) ?? "0.1.0" };
  const native = window.Capacitor?.Plugins?.NoahShell;
  if (native) return { kind: "android", forget: () => native.forget(), version: async () => ((await native.info()) as { version: string }).version };
  return null;
}

/** Un appel commence ou finit : l'app Android garde le micro hors de l'application et propose sa fenêtre flottante. */
export function nativeCall(active: boolean, agent: string, color: string, shape?: string, detail?: string) {
  void window.Capacitor?.Plugins?.NoahShell?.callState?.({ active, agent, color, shape, detail })?.catch(() => {});
}

const parts = (v: string) => (v.split("-")[0].match(/\d+/g) ?? ["0"]).slice(0, 3).map(Number);

/** Version d'app plus ancienne que la plus ancienne que le serveur sert encore (G5.6). */
export function tooOld(version: string, min: string | undefined): boolean {
  if (!min) return false;
  const [a, b] = [parts(version), parts(min)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
}

/** Fichiers : seules les apps proposent les gestes du système. Le web garde Télécharger. */
export function nativeElement(kind: string, url: string, name: string, failed: () => void): boolean {
  const plugin = window.Capacitor?.Plugins?.NoahShell;
  const method = kind === "image" ? plugin?.openImage : kind === "pdf" ? plugin?.openPdf : undefined;
  if (!method) return false;
  void method({ url: new URL(url, location.origin).href, name }).catch(failed);
  return true;
}
export async function elementAction(action: "openWith" | "share", url: string, name: string): Promise<void> {
  const method = window.Capacitor?.Plugins?.NoahShell?.[action];
  if (method) { await method({ url: new URL(url, location.origin).href, name }); return; }
  if (action === "openWith" && window.noahDesktop?.fileMenu) { await window.noahDesktop.fileMenu(new URL(url, location.origin).href, name); return; }
  throw new Error("Ce geste demande l'application Noah.");
}
