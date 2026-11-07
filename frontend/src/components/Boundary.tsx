// Une panne dans un écran reste dans cet écran : le reste de l'application continue, et on peut réessayer sans recharger.
import { Component, type ReactNode } from "react";
import { Button } from "./ui";

export class Boundary extends Component<{ children: ReactNode; label: string }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(`[${this.props.label}]`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-sm">
        <p>{this.props.label} n'a pas pu s'afficher. Le reste de Noah continue de marcher.</p>
        <Button variant="outline" size="sm" onClick={() => this.setState({ failed: false })}>Réessayer</Button>
      </div>
    );
  }
}
