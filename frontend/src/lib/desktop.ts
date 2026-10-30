// Pont avec l'application de bureau (Electron) : présent seulement quand l'interface tourne dans sa fenêtre.
export type NoahDesktop = {
  /** Ouvre le sélecteur de dossier du système ; rend le chemin choisi ou null. */
  pickFolder(): Promise<string | null>;
  /** Ouvre un dossier ou un fichier de l'ordinateur dans l'explorateur. */
  openPath(path: string): Promise<void>;
  version: string;
};

declare global {
  interface Window {
    noahDesktop?: NoahDesktop;
  }
}

export const desktop = (): NoahDesktop | undefined => window.noahDesktop;
