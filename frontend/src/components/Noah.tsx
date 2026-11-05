// Noah : le visage de chaque agent, une petite créature en gomme. Couleur, forme et détail au choix de son propriétaire.
// Un seul composant SVG dessine toutes les formes ; rien ne vient de l'extérieur (pas d'image, pas de HTML injecté).
import { type Ref, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef } from "react";
import { NoahFace } from "@/lib/noahFace";
import { type NoahReaction, type NoahState, bodyOf } from "@/lib/noahMotion";
import { cn } from "@/lib/utils";

export const NOAH_COLORS = [
  { hex: "#ff7a59", name: "Corail" },
  { hex: "#f5b82e", name: "Soleil" },
  { hex: "#2fbf8f", name: "Menthe" },
  { hex: "#4a9df8", name: "Ciel" },
  { hex: "#8b6cf0", name: "Raisin" },
  { hex: "#f06292", name: "Bonbon" },
  { hex: "#64748b", name: "Ardoise" },
];

/** Les noms sont ceux que le serveur accepte (server/noah/main.py, AgentLook) et que lit l'app Android. « » : l'origine. */
export const NOAH_SHAPES = [
  { id: "gomme", name: "Gomme" },
  { id: "bulle", name: "Bulle" },
  { id: "cube", name: "Cube" },
  { id: "goutte", name: "Goutte" },
  { id: "pastille", name: "Pastille" },
] as const;
export const NOAH_DETAILS = [
  { id: "", name: "Aucun" },
  { id: "lunettes", name: "Lunettes" },
  { id: "antenne", name: "Antenne" },
  { id: "sourcils", name: "Sourcils" },
  { id: "joues", name: "Joues rosées" },
] as const;
export type NoahShape = (typeof NOAH_SHAPES)[number]["id"];
export type NoahDetail = (typeof NOAH_DETAILS)[number]["id"];

export type { NoahReaction, NoahState };

/** Ce qui décrit un visage : tout ce que le serveur renvoie d'un agent. */
export type Look = { color?: string; shape?: string; detail?: string };

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Couleur d'un agent : la sienne, sinon une couleur stable tirée de son identifiant. */
export function agentColor(agent: { id: string; color?: string }) {
  if (agent.color && HEX.test(agent.color)) return agent.color;
  let h = 0;
  for (const ch of agent.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return NOAH_COLORS[h % NOAH_COLORS.length].hex;
}

function shade(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount));
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return `rgb(${r} ${g} ${b})`;
}

const INK = "#2b1611";

export type NoahHandle = { react: (kind: NoahReaction) => void };
type Level = { current: number };

/**
 * Le visage. `state` dit ce que fait l'agent ; `handle.current.react("joy")` déclenche une réaction ; `micLevel` et `voiceLevel`
 * (0 à 1, lus à chaque image) font réagir le corps au micro et la bouche à la voix. `still` : image fixe, sans boucle.
 */
export function Noah({
  color = NOAH_COLORS[0].hex,
  shape,
  detail,
  state = "idle",
  seed,
  still = false,
  micLevel,
  voiceLevel,
  handle,
  className,
  title,
}: {
  color?: string;
  shape?: string;
  detail?: string;
  state?: NoahState;
  seed?: string;
  still?: boolean;
  micLevel?: Level;
  voiceLevel?: Level;
  handle?: Ref<NoahHandle>;
  className?: string;
  title?: string;
}) {
  const id = useId().replace(/:/g, "");
  const svg = useRef<SVGSVGElement>(null);
  const face = useRef<NoahFace>(null);
  const safe = HEX.test(color) ? color : NOAH_COLORS[0].hex;
  // Une valeur inconnue (agent plus récent que cette page) retombe sur le visage d'origine.
  const form = (NOAH_SHAPES.some((s) => s.id === shape) ? shape : "gomme") as NoahShape;
  const extra = NOAH_DETAILS.some((d) => d.id === detail) ? (detail as NoahDetail) : "";
  const body = bodyOf(form);
  const stateNow = useRef(state);
  stateNow.current = state;
  const seedText = seed ?? id;

  // Le dessin vient du moteur dès le premier rendu, avant que le navigateur peigne : pas de saut à l'apparition.
  useLayoutEffect(() => {
    if (!svg.current) return;
    const f = new NoahFace(svg.current, { shape: form, detail: extra, seed: seedText, state: stateNow.current, still });
    face.current = f;
    return () => {
      f.dispose();
      face.current = null;
    };
  }, [form, extra, seedText, still]);
  useEffect(() => {
    face.current?.setState(state);
  }, [state]);
  useEffect(() => {
    face.current?.setLevels(micLevel, voiceLevel);
  }, [micLevel, voiceLevel, form, extra, seedText, still]);
  useImperativeHandle(handle, () => ({ react: (kind) => face.current?.react(kind) }), []);

  const fill = `url(#b${id})`;
  const soft = `url(#a${id})`;
  return (
    <svg ref={svg} viewBox="0 0 64 64" className={cn("overflow-visible", className)} data-state={state} data-shape={form} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <defs>
        <radialGradient id={`b${id}`} cx="38%" cy="28%" r="80%">
          <stop offset="0" stopColor={shade(safe, 0.45)} />
          <stop offset="0.45" stopColor={safe} />
          <stop offset="1" stopColor={shade(safe, -0.28)} />
        </radialGradient>
        <radialGradient id={`a${id}`} cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor={shade(safe, 0.35)} />
          <stop offset="1" stopColor={shade(safe, -0.18)} />
        </radialGradient>
      </defs>
      <ellipse data-n="shadow" cx="32" cy="57" rx={body.ground} ry="2.6" fill="#000" opacity=".12" />
      <g data-n="lift">
        {extra === "antenne" && (
          <g>
            <path data-n="antS" stroke={shade(safe, -0.35)} strokeWidth="1.8" strokeLinecap="round" fill="none" />
            <circle data-n="antB" r="2.7" fill={soft} stroke={shade(safe, -0.35)} strokeWidth=".8" />
          </g>
        )}
        {body.arms && (
          <>
            <circle data-n="armL" r="6.4" fill={soft} />
            <circle data-n="armR" r="6" fill={soft} />
          </>
        )}
        <path data-n="body" d={body.path} fill={fill} />
        <ellipse data-n="shine" rx="7" ry="3.6" fill="#fff" opacity=".28" />
        {extra === "joues" && (
          <>
            <ellipse data-n="cheekL" rx="3.6" ry="2.3" fill="#ff5d7a" opacity=".5" />
            <ellipse data-n="cheekR" rx="3.6" ry="2.3" fill="#ff5d7a" opacity=".5" />
          </>
        )}
        <g data-n="face">
          <path data-n="eyeL" fill={INK} stroke={INK} strokeWidth=".7" strokeLinejoin="round" />
          <path data-n="eyeR" fill={INK} stroke={INK} strokeWidth=".7" strokeLinejoin="round" />
          <circle data-n="hiL" fill="#fff" />
          <circle data-n="hiR" fill="#fff" />
          <path data-n="mouth" fill="#6b1d1d" stroke="#6b1d1d" strokeWidth="1.4" strokeLinejoin="round" />
          {extra === "lunettes" && (
            <g data-n="glasses" fill="#fff" fillOpacity=".22" stroke={INK} strokeWidth="1.7" strokeLinecap="round">
              <circle cx="24.6" cy="31.2" r="6.6" />
              <circle cx="39.4" cy="31.2" r="6.6" />
              <path d="M31.2 31.2H32.8" fill="none" />
            </g>
          )}
          {extra === "sourcils" && (
            <g stroke={INK} strokeWidth="2.2" strokeLinecap="round" fill="none">
              <path data-n="browL" d="M21.8 25L28.2 22.6" />
              <path data-n="browR" d="M35.8 22.6L42.2 25" />
            </g>
          )}
        </g>
      </g>
    </svg>
  );
}

type TileProps = {
  color: string;
  shape?: string;
  detail?: string;
  state?: NoahState;
  seed?: string;
  still?: boolean;
  micLevel?: Level;
  voiceLevel?: Level;
  handle?: Ref<NoahHandle>;
  className?: string;
};

/** Noah dans sa tuile arrondie (avatar de la liste, de l'en-tête, des détails). Il peut sauter au-dessus de la tuile : rien ne le coupe. */
export function NoahTile({ color, className, ...face }: TileProps) {
  const safe = HEX.test(color) ? color : NOAH_COLORS[0].hex;
  return (
    <span
      className={cn("grid shrink-0 place-items-center rounded-[30%] ring-1 ring-black/5", className)}
      style={{ background: `linear-gradient(160deg, #fff, color-mix(in srgb, ${safe} 16%, #fff))` }}
    >
      <Noah color={safe} {...face} className="size-[82%] translate-y-[4%]" />
    </span>
  );
}

/** Le visage complet d'un agent tel que le serveur le décrit. */
export function AgentFace({ agent, ...rest }: { agent: { id: string } & Look } & Omit<TileProps, "color" | "shape" | "detail" | "seed">) {
  return <NoahTile color={agentColor(agent)} shape={agent.shape} detail={agent.detail} seed={agent.id} {...rest} />;
}
