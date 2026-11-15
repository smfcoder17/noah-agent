// Les choix de visage d'un agent, les mêmes dans la fenêtre de création et dans le panneau Apparence : toutes les formes, tous les détails.
import { cn } from "@/lib/utils";
import { NOAH_DETAILS, NOAH_SHAPES, Noah } from "./Noah";
import { t } from "@/i18n";

/** Une valeur vide, c'est le visage d'origine : la gomme. */
export const shapeId = (shape?: string) => shape || "gomme";

export function ShapeChoices({ color, value, onPick }: { color: string; value: string; onPick: (shape: string) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{t("Forme du visage")}</legend>
      <div className="grid grid-cols-5 gap-1.5">
        {NOAH_SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={shapeId(value) === s.id}
            onClick={() => onPick(s.id)}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-transparent bg-surface px-1 py-1.5 text-[11px] hover:border-border",
              shapeId(value) === s.id && "ring-2 ring-accent",
            )}
          >
            <Noah color={color} shape={s.id} detail="" still className="size-9" />
            {s.name}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function DetailChoices({ value, onPick }: { value: string; onPick: (detail: string) => void }) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-muted-foreground">{t("Détail distinctif")}</legend>
      <div className="flex flex-wrap gap-1.5">
        {NOAH_DETAILS.map((d) => (
          <button
            key={d.id || "aucun"}
            type="button"
            aria-pressed={value === d.id}
            onClick={() => onPick(d.id)}
            className={cn(
              "cursor-pointer rounded-full border border-transparent bg-surface px-3 py-1 text-xs hover:border-border",
              value === d.id && "ring-2 ring-accent font-medium",
            )}
          >
            {d.name}
          </button>
        ))}
      </div>
    </fieldset>
  );
}
