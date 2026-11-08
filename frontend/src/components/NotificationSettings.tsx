// Réglages > Notifications : ce que ce compte reçoit, sur tous ses appareils. L'interrupteur de cet appareil reste au-dessus.
import { Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { get, send } from "@/lib/api";
import { PushToggle } from "./PushToggle";
import { ErrorText } from "./ui";

type Kind = "fin" | "accord" | "routines" | "appels" | "plafond";
type CallChoice = "demande" | "important" | "jamais";
type Preferences = { rappels: CallChoice; types: Record<Kind, boolean> };

const CHOICES: { id: CallChoice; label: string; detail: string }[] = [
  { id: "demande", label: "Seulement si je le demande", detail: "Ex. « appelle-moi à la fin »." },
  { id: "important", label: "Quand c'est important", detail: "Aussi pour une nouvelle urgente." },
  { id: "jamais", label: "Jamais", detail: "Le compte rendu part en notification." },
];

const KINDS: { id: Kind; label: string; detail: string }[] = [
  { id: "fin", label: "Fin de tâche", detail: "Un long travail finit ou échoue." },
  { id: "accord", label: "Accord demandé", detail: "L'agent attend ton accord." },
  { id: "routines", label: "Routines et veilles", detail: "Un résultat, ou un agent qui t'écrit." },
  { id: "appels", label: "Appels", detail: "Ton téléphone sonne." },
  { id: "plafond", label: "Plafond de dépense", detail: "Un agent approche de son plafond." },
];

export function NotificationSettings() {
  const [prefs, setPrefs] = useState<Preferences | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    get<Preferences>("/api/me/notifications").then(setPrefs).catch((e) => setError((e as Error).message));
  }, []);

  const save = async (change: Partial<Preferences>) => {
    setError("");
    if (prefs) setPrefs({ ...prefs, ...change, types: { ...prefs.types, ...change.types } });
    try {
      setPrefs(await send<Preferences>("/api/me/notifications", change, "PUT"));
    } catch (e) {
      setError((e as Error).message);
      get<Preferences>("/api/me/notifications").then(setPrefs).catch(() => {});
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-2xl border border-border p-4 empty:hidden"><PushToggle /></div>
      {!prefs ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Lecture de tes réglages…</p>
      ) : (
        <>
          <fieldset className="flex flex-col gap-2 rounded-2xl border border-border p-4" disabled={!prefs.types.appels}>
            <legend className="px-1 text-sm font-semibold">L'agent peut m'appeler pour rendre compte</legend>
            {CHOICES.map((c) => (
              <label key={c.id} className="flex items-start gap-3 text-sm">
                <input className="mt-1" type="radio" name="rappels" checked={prefs.rappels === c.id} onChange={() => save({ rappels: c.id })} />
                <span>
                  <span className="block font-medium">{c.label}</span>
                  <span className="block text-xs text-muted-foreground">{c.detail}</span>
                </span>
              </label>
            ))}
            {!prefs.types.appels && <p className="text-xs text-muted-foreground">Appels coupés plus bas.</p>}
          </fieldset>
          <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
            <p className="text-sm font-semibold">Ce que je reçois, sur tous mes appareils</p>
            {KINDS.map((k) => (
              <label key={k.id} className="flex items-start gap-3 text-sm">
                <input
                  className="mt-1"
                  type="checkbox"
                  checked={prefs.types[k.id]}
                  onChange={(e) => save({ types: { [k.id]: e.target.checked } as Record<Kind, boolean> })}
                />
                <span>
                  <span className="block font-medium">{k.label}</span>
                  <span className="block text-xs text-muted-foreground">{k.detail}</span>
                </span>
              </label>
            ))}
            <p className="flex items-start gap-3 text-sm">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent" />
              <span>
                <span className="block font-medium">Alertes de sécurité : toujours actives</span>
                <span className="block text-xs text-muted-foreground">Nouvel appareil, codes faux.</span>
              </span>
            </p>
          </div>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
