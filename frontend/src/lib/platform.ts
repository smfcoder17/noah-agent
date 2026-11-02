// Où tourne l'interface : navigateur, app de bureau (Electron) ou app mobile (Capacitor, interface du serveur ouverte
// dans la fenêtre de l'app). Les apps se relient par un code ou une autorisation, jamais par le mot de passe.

type Shell = { kind: "desktop" | "android"; forget(): Promise<unknown> };

declare global {
  interface Window {
    Capacitor?: { Plugins?: Record<string, Record<string, (arg?: unknown) => Promise<unknown>>> };
  }
}

export function appShell(): Shell | null {
  if (window.noahDesktop?.forgetServer) return { kind: "desktop", forget: () => window.noahDesktop!.forgetServer!() };
  const native = window.Capacitor?.Plugins?.NoahShell;
  if (native) return { kind: "android", forget: () => native.forget() };
  return null;
}
