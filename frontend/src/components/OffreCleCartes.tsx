// Une clé d'API collée dans une discussion est masquée (server/noah/nettoyage.py, lib/nettoyage.ts) ; ce qui reste est l'offre de la ranger au coffre
// (0.4.0, X17). Le bouton ouvre l'ajout au coffre avec la valeur, si elle vient d'être tapée dans cette fenêtre : elle ne part que vers la route du coffre.
// Un ancien message, relu après un rechargement, n'a plus la valeur à l'écran : le formulaire s'ouvre vide, la personne la colle elle-même.
import { KeyRound } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { aUneCleMasquee, cleRetenue, etiquettesMasquees } from "@/lib/nettoyage";
import { t } from "@/i18n";
import { Button } from "./ui";

const VaultAddDialog = lazy(() => import("./Vault").then((m) => ({ default: m.VaultAddDialog })));

// i18n-ignore : des noms de services, l'adresse de base de leur API et, si ce n'est pas Authorization: Bearer, l'en-tête qui porte la clé : pareils dans toutes les langues
const SERVICES: [RegExp, string, string, string][] = [
  [/^sk-ant-/, "Anthropic", "https://api.anthropic.com", "x-api-key"], [/^sk-or-/, "OpenRouter", "https://openrouter.ai", ""], [/^sk-/, "OpenAI", "https://api.openai.com", ""], // i18n-ignore
  [/^(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)/, "GitHub", "https://api.github.com", ""], [/^xox/, "Slack", "https://slack.com", ""], [/^AIza/, "Google", "https://generativelanguage.googleapis.com", "x-goog-api-key"], // i18n-ignore
  [/^AKIA/, "AWS", "", ""], [/^(sk_|rk_)/, "Stripe", "https://api.stripe.com", ""], [/^gsk_/, "Groq", "https://api.groq.com", ""], // i18n-ignore
  [/^xai-/, "xAI", "https://api.x.ai", ""], [/^hf_/, "Hugging Face", "https://huggingface.co", ""], [/^r8_/, "Replicate", "https://api.replicate.com", ""], // i18n-ignore
  [/^pplx-/, "Perplexity", "https://api.perplexity.ai", ""], [/^nvapi-/, "NVIDIA", "https://integrate.api.nvidia.com", ""], [/^tvly-/, "Tavily", "https://api.tavily.com", ""], [/^fc-/, "Firecrawl", "https://api.firecrawl.dev", ""], // i18n-ignore
];

/** Le service d'une clé, d'après sa valeur ou, faute de valeur, son préfixe lisible (« sk- » ne dit pas OpenAI ou Anthropic : le premier). */
const serviceDe = (etiquette: string, valeur: string) => SERVICES.find(([re]) => re.test(valeur || etiquette));

/** Sous un message qui contenait une clé : « Ranger au coffre », une carte par clé masquée. Rien si le message n'en contenait pas. */
export default function OffreCleCartes({ text }: { text: string }) {
  const [ouvert, setOuvert] = useState<number | null>(null);
  const [rangees, setRangees] = useState<number[]>([]);
  if (!aUneCleMasquee(text)) return null;
  const etiquettes = etiquettesMasquees(text);
  return (
    <div data-offre-cle className="mt-1.5 flex flex-col gap-1.5 text-[13px] text-muted-foreground">
      {etiquettes.map((etiquette, i) => {
        const valeur = cleRetenue(etiquette);
        const service = serviceDe(etiquette, valeur);
        const nom = service ? t("Clé {nom}", { nom: service[1] }) : t("Clé d'API");
        return (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <KeyRound className="size-3.5 shrink-0" aria-hidden />
            <span>{etiquettes.length > 1 ? t("Une clé est masquée ({n}) : l'agent ne la voit pas.", { n: i + 1 }) : t("Une clé est masquée : l'agent ne la voit pas.")}</span>
            {rangees.includes(i) ? <span className="font-medium text-ok">{t("Rangée au coffre.")}</span>
              : <Button type="button" size="sm" variant="outline" className="cible-tactile" onClick={() => setOuvert(i)}>{t("Ranger au coffre")}</Button>}
            {ouvert === i && (
              <Suspense fallback={null}>
                <VaultAddDialog
                  initial={{ nom, origine: service?.[2] ?? "", entete: service?.[3] ?? "", cle: valeur }}
                  description={valeur ? t("La clé est dans le champ « Clé d'API ». Chiffrée sur ton serveur, tes agents la font utiliser par Noah sans jamais la lire.") : t("Colle ta clé dans le champ « Clé d'API » : elle n'est plus dans ce message. Chiffrée sur ton serveur, tes agents la font utiliser par Noah sans jamais la lire.")}
                  onClose={() => setOuvert(null)}
                  onSaved={() => setRangees((r) => [...r, i])}
                />
              </Suspense>
            )}
          </div>
        );
      })}
    </div>
  );
}
