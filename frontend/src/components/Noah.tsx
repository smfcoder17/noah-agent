// Noah : la forme de base de chaque agent, une petite créature en gomme. Couleur au choix de l'utilisateur.
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

/** Couleur d'un agent : la sienne, sinon une couleur stable tirée de son identifiant. */
export function agentColor(agent: { id: string; color?: string }) {
  if (agent.color) return agent.color;
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

export function Noah({ color = NOAH_COLORS[0].hex, className, title }: { color?: string; className?: string; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg viewBox="0 0 64 64" className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <defs>
        <radialGradient id={`b${id}`} cx="38%" cy="28%" r="80%">
          <stop offset="0" stopColor={shade(color, 0.45)} />
          <stop offset="0.45" stopColor={color} />
          <stop offset="1" stopColor={shade(color, -0.28)} />
        </radialGradient>
        <radialGradient id={`a${id}`} cx="35%" cy="30%" r="75%">
          <stop offset="0" stopColor={shade(color, 0.35)} />
          <stop offset="1" stopColor={shade(color, -0.18)} />
        </radialGradient>
      </defs>
      <ellipse cx="32" cy="57" rx="20" ry="2.6" fill="#000" opacity=".12" />
      <circle cx="8.6" cy="41.5" r="6.4" fill={`url(#a${id})`} />
      <circle cx="56" cy="35.5" r="6" fill={`url(#a${id})`} />
      <path d="M13 55C7.2 55 6 48.5 7.6 39.5C10 21 18.5 10 32 10S54 21 56.4 39.5C58 48.5 56.8 55 51 55Z" fill={`url(#b${id})`} />
      <ellipse cx="24" cy="18.5" rx="7" ry="3.6" transform="rotate(-24 24 18.5)" fill="#fff" opacity=".28" />
      <ellipse cx="24.6" cy="32" rx="3.9" ry="5.1" fill="#2b1611" />
      <ellipse cx="39.4" cy="32" rx="3.9" ry="5.1" fill="#2b1611" />
      <circle cx="26" cy="29.8" r="1.35" fill="#fff" />
      <circle cx="40.8" cy="29.8" r="1.35" fill="#fff" />
      <path d="M28.2 40q3.8 4.2 7.6 0q-3.8 1.5-7.6 0Z" fill="#6b1d1d" stroke="#6b1d1d" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}

/** Noah dans sa tuile arrondie (avatar de la liste, de l'en-tête, des détails). */
export function NoahTile({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn("grid shrink-0 place-items-center overflow-hidden rounded-[30%] ring-1 ring-black/5", className)}
      style={{ background: `linear-gradient(160deg, #fff, color-mix(in srgb, ${color} 16%, #fff))` }}
    >
      <Noah color={color} className="size-[82%] translate-y-[4%]" />
    </span>
  );
}
