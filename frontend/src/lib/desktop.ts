// Pont avec l'application de bureau (Electron) : présent seulement quand l'interface tourne dans sa fenêtre.
export type ComputerFolder = { id: string; nom: string; ecriture: boolean };
export type AlwaysCommand = { commande: string; dossier: string; nom: string };
export type ComputerFolders = { dossiers: ComputerFolder[]; coupe: boolean; toujours: AlwaysCommand[] };

export type NoahDesktop = {
  /** Dossiers confiés à l'agent depuis cet ordinateur : absents d'une application trop ancienne. */
  dossiers?(): Promise<ComputerFolders | null>;
  dossierAjouter?(): Promise<ComputerFolders | null>;
  dossierRetirer?(id: string): Promise<ComputerFolders | null>;
  dossierDroit?(id: string, ecriture: boolean): Promise<ComputerFolders | null>;
  couper?(coupe: boolean): Promise<ComputerFolders | null>;
  dossierOuvrir?(id: string): Promise<void>;
  commandeOublier?(commande: string, dossier: string): Promise<ComputerFolders | null>;
  /** Ouvre le sélecteur de dossier du système ; rend le chemin choisi ou null. */
  pickFolder(): Promise<string | null>;
  /** Ouvre un dossier ou un fichier de l'ordinateur dans l'explorateur. */
  openPath(path: string): Promise<void>;
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
