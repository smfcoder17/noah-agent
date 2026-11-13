import type { Preset } from "@/lib/presets";
import { cn } from "@/lib/utils";
import { NoahTile } from "./Noah";

/** Choix du modèle d'agent : « Partir de zéro » d'abord, puis une carte par modèle, assez grande pour un pouce. */
export function PresetPicker({ presets, value, onPick }: { presets: Preset[]; value: string; onPick: (preset: Preset | null) => void }) {
  const card = "flex min-h-14 cursor-pointer items-center gap-3 rounded-xl border p-3 text-left text-sm transition-colors hover:bg-muted";
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium">Partir d'un modèle</legend>
      <div className="grid max-h-72 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
        <button type="button" aria-pressed={!value} onClick={() => onPick(null)} className={cn(card, !value ? "border-foreground" : "border-border")}>
          <span className="grid size-10 shrink-0 place-items-center rounded-[30%] border border-dashed border-border text-lg" aria-hidden>+</span>
          <span className="flex flex-col">
            <b className="font-medium">Partir de zéro</b>
            <span className="text-xs text-muted-foreground">Tu écris toi-même son rôle.</span>
          </span>
        </button>
        {presets.map((p) => (
          <button key={p.id} type="button" aria-pressed={value === p.id} onClick={() => onPick(p)} className={cn(card, value === p.id ? "border-foreground" : "border-border")}>
            <NoahTile color={p.couleur} shape={p.shape} detail={p.detail} className="size-10" />
            <span className="flex flex-col">
              <b className="font-medium">{p.nom}</b>
              <span className="text-xs text-muted-foreground">{p.accroche}</span>
            </span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** Ce que le modèle pose en plus, sans rien activer : la personne décide. */
export function PresetNote({ preset }: { preset: Preset }) {
  const parts = [
    preset.routines.length ? `${preset.routines.length === 1 ? "une routine posée en pause" : `${preset.routines.length} routines posées en pause`} (un geste les active, dans Détails > Routines)` : "",
    preset.connexions.length ? `connexions utiles : ${preset.connexions.join(", ")}` : "",
  ].filter(Boolean);
  return (
    <p className="text-xs text-muted-foreground">
      Le rôle reste modifiable : ajoute ce que tu veux.{parts.length ? ` ${parts.join(" ; ")}.` : ""}
    </p>
  );
}
