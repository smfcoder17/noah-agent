// Pont avec l'application de bureau (Electron) : présent seulement quand l'interface tourne dans sa fenêtre.
export type NoahDesktop = {
  /** Ouvre le sélecteur de dossier du système ; rend le chemin choisi ou null. */
  pickFolder(): Promise<string | null>;
  /** Ouvre un dossier ou un fichier de l'ordinateur dans l'explorateur. */
  openPath(path: string): Promise<void>;
  /** Adresse de l'ordinateur sur le réseau local, et si Noah y est déjà ouvert. */
  lanStatus(): Promise<{ open: boolean; url: string | null }>;
  /** Ouvre Noah aux appareils du réseau local (l'utilisateur confirme dans une fenêtre du système). */
  openLan(): Promise<{ open: boolean; url: string | null }>;
  /** App reliée à un serveur : oublie ce serveur et revient à l'écran pour en relier un. */
  forgetServer?(): Promise<void>;
  /** Version de l'app de bureau (pas de l'interface, servie par le serveur) ; une chaîne avant la 0.2. */
  version?: string | (() => Promise<string>);
};

declare global {
  interface Window {
    noahDesktop?: NoahDesktop;
  }
}

export const desktop = (): NoahDesktop | undefined => window.noahDesktop;
