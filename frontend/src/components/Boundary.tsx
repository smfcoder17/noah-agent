// Une panne dans un écran reste dans cet écran : le reste de l'application continue, et on peut réessayer sans recharger.
// Sauf un morceau de l'interface devenu introuvable (le serveur a été mis à jour) : la page se recharge seule, et « Réessayer » aussi.
import { Component, type ReactNode } from "react";
import { t } from "@/i18n";
import { estMorceauIntrouvable, recharger } from "@/lib/rechargement";
import { Button } from "./ui";

export class Boundary extends Component<{ children: ReactNode; label: string }, { failed: boolean; morceau: boolean }> {
  state = { failed: false, morceau: false };

  static getDerivedStateFromError(error: unknown) {
    return { failed: true, morceau: estMorceauIntrouvable(error) };
  }

  componentDidCatch(error: unknown) {
    console.error(`[${this.props.label}]`, error);
    if (estMorceauIntrouvable(error)) recharger();
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
        <p>{t("{label} n'a pas pu s'afficher. Le reste de Noah continue de marcher.", { label: this.props.label })}</p>
        <Button variant="outline" size="sm" onClick={() => (this.state.morceau ? recharger({ forcer: true }) : this.setState({ failed: false }))}>{t("Réessayer")}</Button>
      </div>
    );
  }
}
