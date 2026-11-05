// Noah : le visage de chaque agent, une petite créature en gomme. Couleur, forme et détail au choix de son propriétaire.
// Un seul composant SVG dessine toutes les formes ; rien ne vient de l'extérieur (pas d'image, pas de HTML injecté).
import { useId } from "react";
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

/** État du visage. Prévu pour une animation à venir : aujourd'hui il ne fait que s'inscrire dans `data-state`. */
export type NoahState = "idle" | "listening" | "thinking" | "speaking";

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

// Chaque silhouette sur une grille de 64. Les yeux et la bouche restent à la même place : seule la forme change.
// `top` : haut du corps (où se pose l'antenne). `arms` : petites boules sur les côtés.
const BODIES: Record<NoahShape, { path: string; top: number; arms: boolean; shine: [number, number]; ground: [number, number] }> = {
  gomme: {
    path: "M13 55C7.2 55 6 48.5 7.6 39.5C10 21 18.5 10 32 10S54 21 56.4 39.5C58 48.5 56.8 55 51 55Z",
    top: 10,
    arms: true,
    shine: [24, 18.5],
    ground: [32, 20],
  },
  bulle: { path: "M32 10A23 23 0 0 1 32 56A23 23 0 0 1 32 10Z", top: 10, arms: false, shine: [23, 19], ground: [32, 18] },
  cube: {
    path: "M23 11H41C50 11 54 15 54 24V42C54 51 50 55 41 55H23C14 55 10 51 10 42V24C10 15 14 11 23 11Z",
    top: 11,
    arms: false,
    shine: [22, 19],
    ground: [32, 18],
  },
  goutte: {
    path: "M32 11C34.5 21 55 27.5 55 41C55 50.5 45 56 32 56C19 56 9 50.5 9 41C9 27.5 29.5 21 32 11Z",
    top: 11,
    arms: false,
    shine: [20, 31],
    ground: [32, 18],
  },
  pastille: {
    path: "M22 19H42C51 19 58 26 58 37.5C58 49 51 56 42 56H22C13 56 6 49 6 37.5C6 26 13 19 22 19Z",
    top: 19,
    arms: false,
    shine: [21, 25],
    ground: [32, 22],
  },
};

const INK = "#2b1611";

export function Noah({
  color = NOAH_COLORS[0].hex,
  shape,
  detail,
  state = "idle",
  className,
  title,
}: {
  color?: string;
  shape?: string;
  detail?: string;
  state?: NoahState;
  className?: string;
  title?: string;
}) {
  const id = useId().replace(/:/g, "");
  const safe = HEX.test(color) ? color : NOAH_COLORS[0].hex;
  // Une valeur inconnue (agent plus récent que cette page) retombe sur le visage d'origine.
  const form = (NOAH_SHAPES.some((s) => s.id === shape) ? shape : "gomme") as NoahShape;
  const extra = NOAH_DETAILS.some((d) => d.id === detail) ? (detail as NoahDetail) : "";
  const body = BODIES[form];
  return (
    <svg viewBox="0 0 64 64" className={className} data-state={state} data-shape={form} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
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
      <ellipse cx="32" cy="57" rx={body.ground[1]} ry="2.6" fill="#000" opacity=".12" />
      {extra === "antenne" && (
        <g>
          <path d={`M32 ${body.top + 1.5}V${body.top - 3.4}`} stroke={shade(safe, -0.35)} strokeWidth="1.8" strokeLinecap="round" fill="none" />
          <circle cx="32" cy={body.top - 5.6} r="2.7" fill={`url(#a${id})`} stroke={shade(safe, -0.35)} strokeWidth=".8" />
        </g>
      )}
      {body.arms && (
        <>
          <circle cx="8.6" cy="41.5" r="6.4" fill={`url(#a${id})`} />
          <circle cx="56" cy="35.5" r="6" fill={`url(#a${id})`} />
        </>
      )}
      <path d={body.path} fill={`url(#b${id})`} />
      <ellipse cx={body.shine[0]} cy={body.shine[1]} rx="7" ry="3.6" transform={`rotate(-24 ${body.shine[0]} ${body.shine[1]})`} fill="#fff" opacity=".28" />
      {extra === "joues" && (
        <>
          <ellipse cx="17.5" cy="40.5" rx="3.6" ry="2.3" fill="#ff5d7a" opacity=".5" />
          <ellipse cx="46.5" cy="40.5" rx="3.6" ry="2.3" fill="#ff5d7a" opacity=".5" />
        </>
      )}
      <ellipse cx="24.6" cy="32" rx="3.9" ry="5.1" fill={INK} />
      <ellipse cx="39.4" cy="32" rx="3.9" ry="5.1" fill={INK} />
      <circle cx="26" cy="29.8" r="1.35" fill="#fff" />
      <circle cx="40.8" cy="29.8" r="1.35" fill="#fff" />
      <path d="M28.2 40q3.8 4.2 7.6 0q-3.8 1.5-7.6 0Z" fill="#6b1d1d" stroke="#6b1d1d" strokeWidth="1.4" strokeLinejoin="round" />
      {extra === "lunettes" && (
        <g fill="#fff" fillOpacity=".22" stroke={INK} strokeWidth="1.7" strokeLinecap="round">
          <circle cx="24.6" cy="31.2" r="6.6" />
          <circle cx="39.4" cy="31.2" r="6.6" />
          <path d="M31.2 31.2H32.8" fill="none" />
        </g>
      )}
      {extra === "sourcils" && (
        <g stroke={INK} strokeWidth="2.2" strokeLinecap="round" fill="none">
          <path d="M21.8 25L28.2 22.6" />
          <path d="M35.8 22.6L42.2 25" />
        </g>
      )}
    </svg>
  );
}

/** Noah dans sa tuile arrondie (avatar de la liste, de l'en-tête, des détails). */
export function NoahTile({ color, shape, detail, state, className }: { color: string; shape?: string; detail?: string; state?: NoahState; className?: string }) {
  const safe = HEX.test(color) ? color : NOAH_COLORS[0].hex;
  return (
    <span
      className={cn("grid shrink-0 place-items-center overflow-hidden rounded-[30%] ring-1 ring-black/5", className)}
      style={{ background: `linear-gradient(160deg, #fff, color-mix(in srgb, ${safe} 16%, #fff))` }}
    >
      <Noah color={safe} shape={shape} detail={detail} state={state} className="size-[82%] translate-y-[4%]" />
    </span>
  );
}

/** Le visage complet d'un agent tel que le serveur le décrit. */
export function AgentFace({ agent, state, className }: { agent: { id: string } & Look; state?: NoahState; className?: string }) {
  return <NoahTile color={agentColor(agent)} shape={agent.shape} detail={agent.detail} state={state} className={className} />;
}
