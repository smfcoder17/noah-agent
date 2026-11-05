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
  { id: "demande", label: "Seulement si je le demande", detail: "L'agent appelle si tu lui as dit « appelle-moi à la fin » pour cette tâche." },
  { id: "important", label: "Quand c'est important", detail: "Il peut aussi t'appeler de lui-même pour une nouvelle urgente." },
  { id: "jamais", label: "Jamais", detail: "Ton serveur refuse l'appel : le compte rendu reste écrit et part en notification." },
];

const KINDS: { id: Kind; label: string; detail: string }[] = [
  { id: "fin", label: "Fin de tâche", detail: "Un travail de plus de 30 secondes finit ou échoue, et tu n'es pas sur la conversation." },
  { id: "accord", label: "Accord demandé", detail: "L'agent attend ton accord, ou une étape que toi seul peux faire." },
  { id: "routines", label: "Routines et veilles", detail: "Une routine a un résultat, une veille a trouvé quelque chose." },
  { id: "appels", label: "Appels", detail: "Ton téléphone sonne quand un agent t'appelle. Coupé, aucun agent ne peut te faire sonner." },
  { id: "plafond", label: "Plafond de dépense", detail: "Un agent approche de son plafond, ou l'a atteint." },
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
            {!prefs.types.appels && <p className="text-xs text-muted-foreground">Les appels sont coupés plus bas : aucun agent ne te fait sonner.</p>}
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
                <span className="block text-xs text-muted-foreground">Un nouvel appareil sur ton compte, des codes faux. Elles ne se coupent pas.</span>
              </span>
            </p>
          </div>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
