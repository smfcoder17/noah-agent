// Porte de l'offre « Ranger au coffre » (0.4.0, X17) : seul le test « ce message avait-il une clé ? » reste dans le premier écran ;
// les cartes, la liste des services et le formulaire du coffre se chargent à la demande (budget B2), dans OffreCleCartes.tsx.
import { lazy, Suspense } from "react";
import { aUneCleMasquee } from "@/lib/nettoyage";

const Cartes = lazy(() => import("./OffreCleCartes"));

/** Sous un message qui contenait une clé : « Ranger au coffre ». Rien si le message n'en contenait pas. */
export function OffreCle({ text }: { text: string }) {
  if (!aUneCleMasquee(text)) return null;
  return <Suspense fallback={null}><Cartes text={text} /></Suspense>;
}
