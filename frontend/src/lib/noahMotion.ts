// Le mouvement du visage de Noah : une simulation pure, sans DOM, testable sous Node (tests/visage/moteur_test.mjs).
// Trois couches, comme chez Disney Research : un fond perpétuel (respiration, clignement, regard), des gestes déclenchés (saut,
// hochement…), des décalages continus (pointeur, micro, voix). Le visage réagit en 0,1 s, le corps en 0,35 s.
// Le temps avance par pas fixes et chaque ressort se résout exactement : même graine, même trajectoire, quelle que soit la cadence.

export type NoahShape = "gomme" | "bulle" | "cube" | "goutte" | "pastille";
/** `working` : outil en cours. `waiting` : attend un accord ou un choix. `pleased` et `upset` : la fin d'un travail, réussi ou non. */
export type NoahState = "idle" | "listening" | "thinking" | "speaking" | "working" | "waiting" | "pleased" | "upset";
export type NoahReaction =
  | "hop" | "joy" | "greet" | "surprise" | "attention" | "aha" | "nod" | "shake"
  | "lookLeft" | "lookRight" | "wiggle" | "sad" | "confused" | "sigh" | "puff";

export const NOAH_STEP = 1 / 120;
const H = NOAH_STEP;
const MAX_CATCHUP = 0.25; // au retour d'un onglet, on ne rattrape pas le temps perdu : le visage reprend là où il était
export const GROUND_Y = 57;
export const DEG_PER_UNIT = 6; // échelle du regard : une unité de la grille de 64 vaut 6 degrés
export const GAZE_X = 4.6;
export const GAZE_Y = 3.2;
const SQUASH_MAX = 0.3; // limite douce : la forme s'en approche sans jamais s'effondrer en crêpe. De la gomme, pas de la pâte
const limitSquash = (s: number) => SQUASH_MAX * Math.tanh(s / SQUASH_MAX);

/** La matière de chaque forme : bulle légère, gomme moyenne, cube raide, goutte dont la pointe traîne, pastille basse et large. */
export type Material = {
  omega: number; // pulsation propre du corps (raideur = ω², masse 1)
  zeta: number; // amortissement réduit
  give: number; // combien la forme accepte de se déformer
  taper: number; // l'écrasement élargit le bas et affine le haut
  gravity: number; // unités de grille par s²
  hop: number; // hauteur d'un saut normal
  bounce: number; // restitution à l'atterrissage
  tip: number; // poids de la pointe qui traîne
  flat: number; // le bas s'aplatit au sol : fort sur une forme ronde, faible sur une base déjà plate
};
export const MATERIALS: Record<NoahShape, Material> = {
  gomme: { omega: 17, zeta: 0.38, give: 1, taper: 0.95, gravity: 420, hop: 9, bounce: 0.3, tip: 0.15, flat: 0.25 },
  bulle: { omega: 12.5, zeta: 0.33, give: 1.15, taper: 0.8, gravity: 250, hop: 10.5, bounce: 0.42, tip: 0.1, flat: 0.9 },
  cube: { omega: 14.5, zeta: 0.6, give: 0.62, taper: 1.3, gravity: 560, hop: 7, bounce: 0.18, tip: 0, flat: 0.1 },
  goutte: { omega: 14, zeta: 0.36, give: 1.05, taper: 0.8, gravity: 380, hop: 9, bounce: 0.28, tip: 1, flat: 0.55 },
  pastille: { omega: 15, zeta: 0.42, give: 0.85, taper: 0.9, gravity: 480, hop: 6, bounce: 0.22, tip: 0, flat: 0.25 },
};

// ─── Silhouettes ───────────────────────────────────────────────────────────────────────────────────────────────────────

// `face` : décalage vertical des yeux et de la bouche, pour les garder sur la partie pleine des formes basses ou pointues.
const PATHS: Record<NoahShape, { path: string; top: number; arms: boolean; shine: [number, number]; ground: number; face: number }> = {
  gomme: { path: "M13 55C7.2 55 6 48.5 7.6 39.5C10 21 18.5 10 32 10S54 21 56.4 39.5C58 48.5 56.8 55 51 55Z", top: 10, arms: true, shine: [24, 18.5], ground: 20, face: 0 },
  bulle: { path: "M32 10C44.7 10 55 20.3 55 33S44.7 56 32 56S9 45.7 9 33S19.3 10 32 10Z", top: 10, arms: false, shine: [23, 19], ground: 18, face: 0 },
  cube: { path: "M23 11H41C50 11 54 15 54 24V42C54 51 50 55 41 55H23C14 55 10 51 10 42V24C10 15 14 11 23 11Z", top: 11, arms: false, shine: [22, 19], ground: 18, face: 0 },
  goutte: { path: "M32 11C34.5 21 55 27.5 55 41C55 50.5 45 56 32 56C19 56 9 50.5 9 41C9 27.5 29.5 21 32 11Z", top: 11, arms: false, shine: [20, 31], ground: 18, face: 5 },
  pastille: { path: "M22 19H42C51 19 58 26 58 37.5C58 49 51 56 42 56H22C13 56 6 49 6 37.5C6 26 13 19 22 19Z", top: 19, arms: false, shine: [21, 25], ground: 22, face: 4 },
};

export type BodyGeometry = {
  shape: NoahShape;
  path: string;
  top: number;
  base: number;
  height: number;
  arms: boolean;
  shine: [number, number];
  ground: number;
  face: number;
  /** Segments cubiques à la suite : x0 y0 puis, par segment, c1x c1y c2x c2y x y. */
  pts: Float64Array;
  hs: Float64Array; // hauteur relative de chaque point, 0 à la base, 1 au sommet
  area: number;
};

function parse(path: string): number[] {
  const tokens = path.match(/[MCSHVZ]|-?\d*\.?\d+/g) ?? [];
  const out: number[] = [];
  let i = 0;
  let cmd = "";
  let x = 0;
  let y = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const num = () => Number(tokens[i++]);
  const line = (nx: number, ny: number) => {
    out.push(x + (nx - x) / 3, y + (ny - y) / 3, x + ((nx - x) * 2) / 3, y + ((ny - y) * 2) / 3, nx, ny);
    cx = nx;
    cy = ny;
    x = nx;
    y = ny;
  };
  while (i < tokens.length) {
    if (/[A-Z]/.test(tokens[i])) cmd = tokens[i++];
    if (cmd === "M") {
      x = sx = num();
      y = sy = num();
      cx = x;
      cy = y;
      out.push(x, y);
    } else if (cmd === "H") line(num(), y);
    else if (cmd === "V") line(x, num());
    else if (cmd === "C" || cmd === "S") {
      const c1x = cmd === "C" ? num() : 2 * x - cx;
      const c1y = cmd === "C" ? num() : 2 * y - cy;
      const c2x = num();
      const c2y = num();
      const nx = num();
      const ny = num();
      out.push(c1x, c1y, c2x, c2y, nx, ny);
      cx = c2x;
      cy = c2y;
      x = nx;
      y = ny;
    } else if (cmd === "Z") {
      if (Math.abs(x - sx) > 1e-6 || Math.abs(y - sy) > 1e-6) line(sx, sy);
    }
  }
  return out;
}

/** Coupe en deux les longs segments : plus de points de contrôle, donc une déformation plus souple. */
function subdivide(p: number[], limit: number): number[] {
  const out = [p[0], p[1]];
  for (let i = 2; i < p.length; i += 6) {
    const [x0, y0] = [out[out.length - 2], out[out.length - 1]];
    const [x1, y1, x2, y2, x3, y3] = p.slice(i, i + 6);
    if (Math.hypot(x3 - x0, y3 - y0) < limit) {
      out.push(x1, y1, x2, y2, x3, y3);
      continue;
    }
    const m = (a: number, b: number) => (a + b) / 2;
    const [ax, ay, bx, by, cx, cy] = [m(x0, x1), m(y0, y1), m(x1, x2), m(y1, y2), m(x2, x3), m(y2, y3)];
    const [dx, dy, ex, ey] = [m(ax, bx), m(ay, by), m(bx, cx), m(by, cy)];
    const [fx, fy] = [m(dx, ex), m(dy, ey)];
    out.push(ax, ay, dx, dy, fx, fy, ex, ey, cx, cy, x3, y3);
  }
  return out;
}

/** Aire exacte d'un contour fermé de cubiques : somme sur chaque segment (théorème de Green). */
function areaOf(xs: Float64Array | number[], ys: Float64Array | number[], n: number): number {
  let a = 0;
  for (let i = 0; i + 3 < n; i += 3) {
    const x0 = xs[i], y0 = ys[i], x1 = xs[i + 1], y1 = ys[i + 1], x2 = xs[i + 2], y2 = ys[i + 2], x3 = xs[i + 3], y3 = ys[i + 3];
    a += (3 * ((y3 - y0) * (x1 + x2) - (x3 - x0) * (y1 + y2) + y1 * (x0 - x2) - x1 * (y0 - y2) + y3 * (x2 + x0 / 3) - x3 * (y2 + y0 / 3))) / 20;
  }
  return a;
}

const GEOMETRY = new Map<NoahShape, BodyGeometry>();
export function bodyOf(shape: NoahShape): BodyGeometry {
  let g = GEOMETRY.get(shape);
  if (g) return g;
  const def = PATHS[shape];
  const raw = subdivide(parse(def.path), 18);
  const n = raw.length / 2;
  const pts = Float64Array.from(raw);
  const xs: number[] = [];
  const ys: number[] = [];
  let base = 0;
  for (let i = 0; i < n; i++) {
    xs.push(pts[i * 2]);
    ys.push(pts[i * 2 + 1]);
    base = Math.max(base, pts[i * 2 + 1]);
  }
  const height = base - def.top;
  const hs = Float64Array.from(ys, (y) => (base - y) / height);
  g = { shape, path: def.path, top: def.top, base, height, arms: def.arms, shine: def.shine, ground: def.ground, face: def.face, pts, hs, area: areaOf(xs, ys, n) };
  GEOMETRY.set(shape, g);
  return g;
}

// ─── Ressort exact ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Masse 1, raideur ω², amortissement 2ζω. Le pas est résolu par la solution exacte : stable pour tout pas, sans dérive. */
export class Spring {
  x: number;
  v = 0;
  t: number;
  private a = 0;
  private b = 0;
  private c = 0;
  private d = 0;
  constructor(omega: number, zeta: number, x0 = 0, step = H) {
    this.x = x0;
    this.t = x0;
    this.tune(omega, zeta, step);
  }
  tune(omega: number, zetaIn: number, step = H) {
    const zeta = Math.min(zetaIn, 0.999);
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const s = Math.exp(-zeta * omega * step);
    const co = Math.cos(wd * step);
    const si = Math.sin(wd * step);
    const r = (zeta * omega) / wd;
    this.a = s * (co + r * si);
    this.b = (s * si) / wd;
    this.c = (-s * omega * omega * si) / wd;
    this.d = s * (co - r * si);
  }
  step() {
    const e = this.x - this.t;
    const v = this.v;
    this.x = this.t + this.a * e + this.b * v;
    this.v = this.c * e + this.d * v;
  }
}

// ─── Hasard reproductible ──────────────────────────────────────────────────────────────────────────────────────────────

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (u: number) => {
  const k = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return k * k * (3 - 2 * k);
};
const minJerk = (u: number) => {
  const k = u <= 0 ? 0 : u >= 1 ? 1 : u;
  return k * k * k * (k * (k * 6 - 15) + 10);
};
const window01 = (a: number, up: number, dur: number, down: number) => smooth(a / up) * (1 - smooth((a - (dur - down)) / down));

// ─── Pose : ce que le dessin lit à chaque image ────────────────────────────────────────────────────────────────────────

export type Pose = {
  squash: number; lean: number; bend: number; tipY: number; alt: number; belly: number;
  turn: number; pitch: number; tilt: number;
  gazeX: number; gazeY: number;
  lid: number; lidRaw: number; crescent: number; wide: number; slant: number;
  open: number; round: number; mouthWide: number; smile: number; mouthX: number;
  brow: number; browTilt: number; cheek: number;
  antennaX: number; antennaY: number; glassX: number; glassY: number;
  armLX: number; armLY: number; armRX: number; armRY: number; armLift: number;
  shadowW: number; shadowO: number;
};

export function restPose(): Pose {
  return {
    squash: 0, lean: 0, bend: 0, tipY: 0, alt: 0, belly: 0, turn: 0, pitch: 0, tilt: 0, gazeX: 0, gazeY: 0,
    lid: 1, lidRaw: 1, crescent: 0, wide: 1, slant: 0, open: 0, round: 0, mouthWide: 1, smile: 1, mouthX: 0, brow: 0, browTilt: 0, cheek: 0,
    antennaX: 0, antennaY: 0, glassX: 0, glassY: 0, armLX: 0, armLY: 0, armRX: 0, armRY: 0, armLift: 0, shadowW: 1, shadowO: 1,
  };
}

// Cibles d'un état. Les cinq premières sont du corps (fondu 0,35 s), les autres du visage (fondu 0,1 s).
const S = 0, LEAN = 1, TILT = 2, PITCH = 3, TURN = 4, LID = 5, WIDE = 6, SMILE = 7, CRES = 8, BROW = 9, CHEEK = 10;
const NP = 11;
const FACE_FROM = 5;
const BODY_FADE = 0.35;
const FACE_FADE = 0.1;

const IDLE = [0, 0, 0, 0, 0, 0.97, 1, 1, 0, 0, 0];
const LISTEN = [-0.05, 0.022, 5, 0.2, 0, 1.06, 1.08, 0.62, 0, 0.6, 0];
const SPEAK = [-0.02, 0, 0, 0, 0, 0.98, 1.02, 0.85, 0, 0.2, 0];
const WORK = [0.03, 0, 0, 0.2, 0, 0.8, 0.96, 0.3, 0, 0.4, 0]; // penché sur sa tâche, paupières basses
const WAIT = [-0.05, 0.015, 6, -0.12, 0, 1.1, 1.1, 0.75, 0, 0.95, 0]; // redressé, la tête penchée, il te regarde
const PLEASED = [-0.02, 0, 0, 0, 0, 1, 1, 1.45, 0.85, 0.35, 1];
const UPSET = [0.09, 0, 0, 0.32, 0, 0.92, 1.03, -1.5, 0, -0.85, 0];
// La réflexion dépend du temps : regard levé et sourcil, puis balancement, puis changement de posture, puis signe d'effort.
const THINK: number[][] = [
  [0.005, 0, 3, -0.25, 0, 0.9, 1, 0.45, 0, 0.65, 0],
  [0.015, 0.015, 4.5, -0.2, 0, 0.84, 0.98, 0.15, 0, 0.6, 0],
  [0.04, -0.03, -4, 0.05, 0, 0.74, 0.97, 0.05, 0, 0.3, 0],
  [0.07, 0.01, 2, 0.14, 0, 0.64, 0.94, 0, 0, -0.1, 0],
];

type Gesture = { kind: NoahReaction; t0: number; v: number; dir: number; stage: number; hops: number; next: number };

export type TraceEntry = { t: number; dx: number; dy: number; deg: number; dur: number };

export class NoahSim {
  readonly shape: NoahShape;
  readonly material: Material;
  readonly geo: BodyGeometry;
  readonly pose: Pose = restPose();
  /** Sans couche de fond ni regard autonome : pour observer la réponse d'un seul ressort. */
  quiet: boolean;
  /** Petite taille : moins de dérive et de regards, pas de tic. */
  calm = false;
  t = 0;
  state: NoahState = "idle";
  mic = 0;
  voice = 0;
  private voiceT = -9;
  private rand: () => number;
  private acc = 0;

  // Ressorts
  readonly sq: Spring;
  readonly leanS: Spring;
  private leanTip: Spring;
  private tipV: Spring;
  private turn = new Spring(11, 0.5);
  private pitch = new Spring(13, 0.42);
  private tilt = new Spring(10, 0.48);
  private lid = new Spring(42, 0.75, 0.97);
  private wide = new Spring(30, 0.6, 1);
  private smile = new Spring(24, 0.62, 1);
  private cres = new Spring(26, 0.7);
  private brow = new Spring(30, 0.55);
  private slant = new Spring(20, 0.7);
  private cheek = new Spring(9, 0.8);
  private open = new Spring(40, 0.72);
  private round = new Spring(30, 0.8);
  private mw = new Spring(28, 0.75, 1);
  private mx = new Spring(16, 0.7);
  private armLift = new Spring(13, 0.4);
  // Accessoires en retard sur le corps : chaque suiveur court après un point d'attache
  private antX = new Spring(15, 0.3);
  private antY = new Spring(15, 0.3);
  private glassX = new Spring(19, 0.38);
  private glassY = new Spring(19, 0.38);
  private armLX = new Spring(14, 0.34);
  private armLY = new Spring(14, 0.34);
  private armRX = new Spring(16, 0.32);
  private armRY = new Spring(16, 0.32);

  // État et fondus
  private goal = new Float64Array(NP);
  private mix = new Float64Array(NP);
  private from = new Float64Array(NP);
  private tState = 0;
  private dirL = 1;
  private dirT = 1;

  // Décalages du geste en cours, remis à zéro à chaque pas
  private oS = 0; private oLean = 0; private oTilt = 0; private oTurn = 0; private oPitch = 0;
  private oLid = 0; private oWide = 0; private oSmile = 0; private oCres = 0; private oBrow = 0; private oBrowTilt = 0;
  private oSlant = 0; private oCheek = 0; private oOpen = 0; private oRound = 0; private oMw = 0; private oMx = 0; private oArm = 0;

  // Fond
  private breathPhase = 0;
  private breathPeriod = 4;
  private driftGoal = 0;
  private drift = 0;
  private driftTiltGoal = 0;
  private driftTilt = 0;
  private nextDrift = 2;
  private blinkT = -9;
  private nextBlink = 1;
  private doubleBlink = false;
  private nextTic = 14;
  private nextMicro = 2;
  private nextNudge = 0;
  private scanX = -2;
  private ticKinds: NoahReaction[];

  // Regard
  private gx = 0;
  private gy = 0;
  private sFromX = 0;
  private sFromY = 0;
  private sToX = 0;
  private sToY = 0;
  private sT0 = -9;
  private sDur = 0;
  private sEnd = -9;
  private nextSaccade = 0.8;
  private holdUntil = -9;
  private headAt = -9;
  private headX = 0;
  private headY = 0;
  private headTX = 0;
  private headTY = 0;
  private pointerX = 0;
  private pointerY = 0;
  private pointerT = -9;
  private pointerAt = -9;

  // Voix
  private micEnv = 0;
  private voiced = 0;
  private silent = 0;
  private nodDone = true;
  private nextIdleNod = 6;
  private openT = 0;
  private roundT = 0.2;
  private mwT = 1;
  private sylEnd = 0;
  private sylClose = 0;
  private sylLeft = 0;
  private lastVoice = 0;
  private inhaleUntil = 0;

  // Saut
  private jump = 0; // 0 au sol, 1 préparation, 2 en vol, 3 contact
  private jumpT = 0;
  private anticDur = 0.14;
  private anticAmt = 0.3;
  private hopH = 0;
  private v0 = 0;
  private altV = 0;
  private alt = 0;
  private impact = 0;
  private contactDur = 0.07;

  // Gestes
  private g: Gesture | null = null;
  private lastVariant = new Map<NoahReaction, number>();
  /** Journaux pour les tests. Vides tant qu'on ne les demande pas. */
  trace: { saccades: TraceEntry[]; gestures: { kind: NoahReaction; v: number }[] } | null = null;

  constructor(opts: { shape: NoahShape; seed: number; quiet?: boolean; state?: NoahState; trace?: boolean }) {
    this.shape = opts.shape;
    this.material = MATERIALS[opts.shape];
    this.geo = bodyOf(opts.shape);
    this.quiet = !!opts.quiet;
    this.rand = mulberry(opts.seed);
    if (opts.trace) this.trace = { saccades: [], gestures: [] };
    const m = this.material;
    this.sq = new Spring(m.omega, m.zeta);
    this.leanS = new Spring(m.omega * 0.8, Math.min(0.6, m.zeta + 0.08));
    this.leanTip = new Spring(m.omega * 0.55, m.zeta);
    this.tipV = new Spring(m.omega * 0.8, m.zeta);
    // Le tic de l'agent vient de son identifiant : c'est sa manière d'être.
    const tics: NoahReaction[] = ["wiggle", "sigh", "puff", "confused"];
    const a = Math.floor(this.rand() * tics.length);
    this.ticKinds = [tics[a], tics[(a + 1 + Math.floor(this.rand() * 3)) % tics.length]];
    this.breathPhase = this.rand() * Math.PI * 2;
    this.breathPeriod = 3 + this.rand() * 2;
    this.nextBlink = 0.4 + this.rand() * 3;
    this.nextSaccade = 0.3 + this.rand() * 1.5;
    this.nextDrift = this.rand() * 3;
    this.nextTic = 10 + this.rand() * 14;
    this.dirL = this.rand() < 0.5 ? -1 : 1;
    this.dirT = this.rand() < 0.5 ? -1 : 1;
    const st = opts.state ?? "idle";
    this.state = st;
    this.computeGoal();
    this.mix.set(this.goal);
    this.from.set(this.goal);
    this.tState = -1;
    this.computePose();
  }

  /** Change d'état. Rien ne repart de zéro : les ressorts gardent leur vitesse, le fondu part de la cible du moment. */
  setState(next: NoahState) {
    if (next === this.state) return;
    const age = this.t - this.tState;
    const prev = this.state;
    this.from.set(this.mix);
    this.tState = this.t;
    this.state = next;
    // La tête reste penchée du même côté d'un état à l'autre : elle ne balaie pas l'écran à chaque changement.
    const side = this.mix[TILT] > 1 ? 1 : this.mix[TILT] < -1 ? -1 : this.rand() < 0.5 ? -1 : 1;
    if (next === "thinking") {
      this.dirT = side;
      this.nextSaccade = this.t + 0.12;
    } else if (next === "listening") {
      this.dirL = side;
      this.nextSaccade = this.t + 0.05;
      this.nodDone = true;
      this.nextIdleNod = this.t + 5 + this.rand() * 4;
    } else if (next === "waiting") {
      this.dirL = side;
      this.nextSaccade = this.t + 0.05;
      this.nextNudge = this.t + 3.5;
      this.react("attention");
    } else if (next === "pleased") {
      this.nextSaccade = this.t + 0.05;
      this.react("hop");
    } else if (next === "upset") {
      this.nextSaccade = this.t + 0.1;
      this.sq.v += 0.9; // il s'affaisse d'un coup, sans geste : la phrase d'erreur dit le reste
    } else if (next === "speaking") {
      this.inhaleUntil = this.t + 0.17;
      this.sylEnd = this.inhaleUntil;
      this.sylLeft = 0;
      this.nextSaccade = this.t + 0.3;
      if (prev === "thinking" && age > 0.8) this.react("aha");
    } else this.nextSaccade = this.t + 0.2;
    if (prev === "speaking") {
      this.openT = 0;
      this.sq.v += 0.35; // petit tassement quand la phrase se termine
    }
  }

  /** Déclenche une réaction. Une réaction en cours se fond dans la suivante : les ressorts gardent leur élan. */
  react(kind: NoahReaction) {
    const n = VARIANTS[kind] ?? 4;
    let v = Math.floor(this.rand() * n);
    if (v === this.lastVariant.get(kind)) v = (v + 1) % n;
    this.lastVariant.set(kind, v);
    this.g = { kind, t0: this.t, v, dir: this.rand() < 0.5 ? -1 : 1, stage: 0, hops: 0, next: 0 };
    this.trace?.gestures.push({ kind, v });
  }

  /** Direction du pointeur vue du visage, de -1 à 1. */
  look(x: number, y: number) {
    this.pointerX = clamp(x, -1, 1);
    this.pointerY = clamp(y, -1, 1);
    this.pointerT = this.t;
  }

  setVoice(level: number) {
    this.voice = level;
    this.voiceT = this.t;
  }

  /** Vrai quand ce visage doit être redessiné à pleine cadence ; sinon il respire, et quelques images par seconde lui suffisent. */
  lively() {
    const t = this.t;
    return this.jump !== 0 || this.g !== null || this.state === "speaking" || this.micEnv > 0.02 || t - this.blinkT < 0.25 || t < this.sEnd || t - this.tState < 0.5;
  }

  /** Au travail ou en attente : ses petits mouvements doivent se voir, même en petite taille. Jamais plus d'un visage à la fois dans le chat. */
  busy() {
    return this.state === "working" || this.state === "waiting";
  }

  /** Avance la simulation du temps écoulé, par pas fixes. */
  advance(dt: number) {
    this.acc += Math.min(Math.max(dt, 0), MAX_CATCHUP);
    while (this.acc >= H - 1e-9) {
      this.tick();
      this.acc -= H;
    }
    this.computePose();
  }

  /** Pose de repos de l'état, sans aucun mouvement : mode mouvement réduit et pause. Seule l'expression change, jamais le corps. */
  settle(state: NoahState) {
    this.state = state;
    this.tState = this.t - 100;
    this.g = null;
    this.alt = 0;
    this.altV = 0;
    this.jump = 0;
    this.blinkT = -9;
    this.computeGoal();
    for (let i = 0; i < FACE_FROM; i++) this.goal[i] = 0;
    this.mix.set(this.goal);
    this.from.set(this.goal);
    const m = this.mix;
    this.drift = this.driftGoal = this.driftTilt = this.driftTiltGoal = 0;
    this.headTX = this.headTY = 0;
    const all: [Spring, number][] = [
      [this.sq, m[S]], [this.leanS, m[LEAN]], [this.leanTip, m[LEAN]], [this.tipV, 0], [this.turn, m[TURN]], [this.pitch, m[PITCH]], [this.tilt, m[TILT]],
      [this.lid, m[LID]], [this.wide, m[WIDE]], [this.smile, m[SMILE]], [this.cres, m[CRES]], [this.brow, m[BROW]], [this.slant, 0], [this.cheek, m[CHEEK]],
      [this.open, state === "speaking" ? 0.28 : 0], [this.round, 0.1], [this.mw, 1], [this.mx, state === "thinking" ? this.dirT : 0], [this.armLift, 0],
    ];
    for (const [sp, x] of all) {
      sp.x = x;
      sp.t = x;
      sp.v = 0;
    }
    if (state === "upset") this.slant.x = this.slant.t = 1;
    this.gx = state === "thinking" ? this.dirT * 2 : 0;
    this.gy = state === "thinking" ? -2.2 : state === "working" ? 1.6 : state === "upset" ? 2.2 : 0;
    this.sToX = this.gx;
    this.sToY = this.gy;
    this.sDur = 0;
    this.sEnd = this.t - 1;
    this.syncFollowers();
    this.computePose();
  }

  private tick() {
    this.t += H;
    const t = this.t;
    this.oS = this.oLean = this.oTilt = this.oTurn = this.oPitch = this.oLid = this.oWide = this.oSmile = this.oCres = 0;
    this.oBrow = this.oBrowTilt = this.oSlant = this.oCheek = this.oOpen = this.oRound = this.oMw = this.oMx = this.oArm = 0;

    this.computeGoal();
    const age = t - this.tState;
    const fb = smooth(age / BODY_FADE);
    const ff = smooth(age / FACE_FADE);
    for (let i = 0; i < NP; i++) this.mix[i] = this.from[i] + (this.goal[i] - this.from[i]) * (i < FACE_FROM ? fb : ff);

    let breath = 0;
    if (!this.quiet) {
      breath = this.background();
      this.runVoices();
      this.runChore(age);
    }
    this.runGesture();
    const airS = this.runJump();
    this.runGaze();

    const m = this.mix;
    this.sq.t = m[S] + breath + this.oS + airS;
    this.leanS.t = m[LEAN] + this.drift + this.oLean;
    this.leanTip.t = this.leanS.x;
    // La pointe traîne : elle se tasse quand le corps monte, s'étire vers le haut quand il retombe.
    this.tipV.t = clamp(-this.altV * 0.0014, -0.14, 0.14);
    this.turn.t = m[TURN] + this.headTX + this.oTurn;
    this.pitch.t = m[PITCH] + this.headTY + this.oPitch;
    this.tilt.t = m[TILT] + this.driftTilt + this.oTilt;
    if (this.state === "thinking" && age > 1) {
      // balancement lent de la réflexion
      this.tilt.t += 2.4 * Math.sin((age - 1) * 0.95) * smooth((age - 1) / 0.8);
      this.leanS.t += 0.012 * Math.sin((age - 1) * 0.7) * smooth((age - 1) / 0.8);
    }
    // La paupière accompagne le regard vertical : on lève les yeux, elle se lève aussi.
    this.lid.t = clamp(m[LID] + this.oLid - this.gy * 0.05, 0, 1.22);
    this.wide.t = m[WIDE] + this.oWide;
    this.smile.t = m[SMILE] + this.oSmile;
    this.cres.t = clamp(m[CRES] + this.oCres, 0, 1);
    this.brow.t = m[BROW] + this.oBrow;
    this.slant.t = this.oSlant + (this.state === "upset" ? 1 : 0);
    this.cheek.t = clamp(m[CHEEK] + this.oCheek, 0, 1);
    this.open.t = clamp(this.openT + this.oOpen, 0, 1);
    this.round.t = clamp(this.roundT + this.oRound, 0, 1);
    this.mw.t = this.mwT + this.oMw;
    this.mx.t = (this.state === "thinking" ? this.dirT * smooth((age - 1) / 0.6) : 0) + this.oMx;
    this.armLift.t = this.oArm;

    this.sq.step();
    this.leanS.step();
    this.leanTip.step();
    this.tipV.step();
    this.turn.step();
    this.pitch.step();
    this.tilt.step();
    this.lid.step();
    this.wide.step();
    this.smile.step();
    this.cres.step();
    this.brow.step();
    this.slant.step();
    this.cheek.step();
    this.open.step();
    this.round.step();
    this.mw.step();
    this.mx.step();
    this.armLift.step();
    this.stepFollowers();
  }

  /** Où serait un point du corps à la hauteur relative h : le suiveur court après ce point. */
  private anchorX(h: number) {
    return (this.leanS.x + (this.leanTip.x - this.leanS.x) * h) * this.geo.height * h;
  }
  private anchorY(h: number) {
    const S0 = limitSquash(this.sq.x * this.material.give);
    return h * this.geo.height * (1 - Math.exp(-S0)) - this.alt;
  }

  private stepFollowers() {
    const hint = this.micEnv * Math.sin(this.t * 2 * Math.PI * 9) * 0.5 * (this.state === "listening" ? 1 : 0);
    this.antX.t = this.anchorX(1) + hint;
    this.antY.t = this.anchorY(1);
    this.glassX.t = this.anchorX(0.5);
    this.glassY.t = this.anchorY(0.5);
    const armX = this.anchorX(0.3);
    const armY = this.anchorY(0.3);
    this.armLX.t = armX;
    this.armLY.t = armY;
    this.armRX.t = armX;
    this.armRY.t = armY;
    this.antX.step();
    this.antY.step();
    this.glassX.step();
    this.glassY.step();
    this.armLX.step();
    this.armLY.step();
    this.armRX.step();
    this.armRY.step();
  }

  private syncFollowers() {
    const pairs: [Spring, number][] = [
      [this.antX, this.anchorX(1)], [this.antY, this.anchorY(1)], [this.glassX, this.anchorX(0.5)], [this.glassY, this.anchorY(0.5)],
      [this.armLX, this.anchorX(0.3)], [this.armLY, this.anchorY(0.3)], [this.armRX, this.anchorX(0.3)], [this.armRY, this.anchorY(0.3)],
    ];
    for (const [sp, x] of pairs) {
      sp.x = x;
      sp.t = x;
      sp.v = 0;
    }
  }

  private computeGoal() {
    const g = this.goal;
    const age = this.t - this.tState;
    if (this.state === "thinking") {
      const u1 = smooth((age - 1) / 0.6);
      const u2 = smooth((age - 5) / 1.2);
      const u3 = smooth((age - 15) / 1.5);
      for (let i = 0; i < NP; i++) {
        let v = THINK[0][i] + (THINK[1][i] - THINK[0][i]) * u1;
        v += (THINK[2][i] - v) * u2;
        v += (THINK[3][i] - v) * u3;
        g[i] = v;
      }
      g[TILT] *= this.dirT;
      g[LEAN] *= this.dirT;
      return;
    }
    const st = this.state;
    const row = st === "listening" ? LISTEN : st === "speaking" ? SPEAK : st === "working" ? WORK : st === "waiting" ? WAIT : st === "pleased" ? PLEASED : st === "upset" ? UPSET : IDLE;
    for (let i = 0; i < NP; i++) g[i] = row[i];
    if (st === "listening" || st === "waiting") {
      g[TILT] *= this.dirL;
      g[LEAN] *= this.dirL;
    }
    if (this.state === "speaking" && this.t < this.inhaleUntil) g[S] = -0.06; // inspiration avant le premier son
  }

  // ── Couche de fond : respiration irrégulière, dérive de poids, clignements, tic de l'agent ─────────────────────────────
  private background(): number {
    const t = this.t;
    const rate = this.state === "listening" ? 0.9 : this.state === "thinking" ? 0.8 : 1;
    this.breathPhase += ((2 * Math.PI) / this.breathPeriod) * H * rate;
    if (this.breathPhase > 2 * Math.PI) {
      this.breathPhase -= 2 * Math.PI;
      this.breathPeriod = 3 + this.rand() * 2;
    }
    // inspiration plus courte que l'expiration
    const breath = 0.021 * Math.sin(this.breathPhase + 0.35 * Math.sin(this.breathPhase));

    if (t >= this.nextDrift) {
      this.nextDrift = t + 2.6 + this.rand() * 4.5;
      const amt = this.calm ? 0.02 : 0.05;
      this.driftGoal = (this.rand() * 2 - 1) * amt;
      this.driftTiltGoal = (this.rand() * 2 - 1) * (this.calm ? 2 : 4);
    }
    const k = H / 0.75; // le poids se déplace doucement
    this.drift += (this.driftGoal - this.drift) * k;
    this.driftTilt += (this.driftTiltGoal - this.driftTilt) * k;

    if (t >= this.nextBlink) {
      this.blinkT = t;
      if (this.doubleBlink) {
        this.doubleBlink = false;
        this.nextBlink = t + 0.9 + this.exp(4);
      } else if (this.rand() < 0.12) {
        this.doubleBlink = true;
        this.nextBlink = t + 0.28 + this.rand() * 0.1;
      } else this.nextBlink = t + 0.9 + this.exp(4) * (this.state === "thinking" ? 1.25 : 1);
    }

    // Micro-expressions : un sourcil, une lèvre, un regard qui s'ouvre. Courtes et petites, c'est ce qui évite le visage de cire.
    if (t >= this.nextMicro) {
      this.nextMicro = t + 2.2 + this.exp(2.6);
      const r = this.rand();
      if (r < 0.4) this.brow.v += (this.rand() < 0.75 ? 1 : -1) * (7 + this.rand() * 3);
      else if (r < 0.75) this.smile.v += (this.rand() < 0.6 ? 1 : -1) * (5 + this.rand() * 3);
      else this.wide.v += 2.4 + this.rand() * 0.9;
    }

    if (!this.calm && this.state === "idle" && t >= this.nextTic && !this.g) {
      this.nextTic = t + 12 + this.rand() * 16;
      this.react(this.ticKinds[this.rand() < 0.7 ? 0 : 1]);
    }
    return breath;
  }

  private exp(mean: number) {
    return -Math.log(1 - this.rand() * 0.98) * mean;
  }

  // ── Pendant une tâche : au travail, des séries de petits coups réguliers ; en attente, il se balance et te fait signe ──────
  private runChore(age: number) {
    if (this.state === "working") {
      const burst = window01(age % 2.6, 0.12, 1.75, 0.22); // une série, puis un temps pour relire
      const tap = Math.abs(Math.sin(age * 8.5)) * burst;
      this.oS += 0.032 * tap;
      this.oPitch += 0.2 * tap;
      this.oArm += 3.4 * tap;
      this.oLean += 0.012 * Math.sin(age * 1.3);
    } else if (this.state === "waiting") {
      const sway = Math.sin(age * 1.5);
      this.oTilt += 2.6 * sway;
      this.oBrow += 0.25 * Math.max(0, sway);
      if (this.t >= this.nextNudge && !this.g) {
        this.nextNudge = this.t + 4.5 + this.rand() * 2.5;
        this.react("attention");
      }
    }
  }

  private blinkAmount() {
    const a = this.t - this.blinkT;
    if (a < 0 || a > 0.25) return 0;
    if (a < 0.07) {
      const u = a / 0.07;
      return u * u;
    }
    if (a < 0.09) return 1;
    return 1 - smooth((a - 0.09) / 0.16);
  }

  // ── Écoute et parole ───────────────────────────────────────────────────────────────────────────────────────────────
  private runVoices() {
    const t = this.t;
    const k = this.mic > this.micEnv ? H / 0.015 : H / 0.08;
    this.micEnv += (this.mic - this.micEnv) * Math.min(k, 1);

    if (this.state === "listening") {
      this.oS -= 0.075 * this.micEnv;
      this.oWide += 0.03 * this.micEnv;
      // Accusé d'écoute : un petit hochement quand l'orateur fait une pause.
      // Lu sur le niveau brut : l'enveloppe du corps retombe trop lentement pour dater une pause.
      if (this.mic > 0.1) {
        this.voiced += H;
        this.silent = 0;
        if (this.voiced > 0.25) this.nodDone = false;
      } else if (this.mic < 0.06) {
        this.silent += H;
        if (this.silent > 0.2 && !this.nodDone) {
          this.nodDone = true;
          this.voiced = 0;
          this.react("nod");
        }
      }
      if (this.mic === 0 && this.micEnv < 0.01 && t >= this.nextIdleNod) {
        this.nextIdleNod = t + 5 + this.rand() * 5;
        if (!this.g) this.react("nod");
      }
    }

    if (this.state !== "speaking") {
      this.openT = 0;
      this.roundT = 0.1;
      this.mwT = 1;
      return;
    }
    if (t < this.inhaleUntil) {
      this.openT = 0.1;
      return;
    }
    if (t - this.voiceT < 0.25) {
      // La vraie voix pilote la bouche : si le volume retombe à zéro, la bouche se ferme.
      const v = this.voice < 0.02 ? 0 : Math.pow(this.voice, 0.65) * 1.1;
      this.openT = clamp(v, 0, 1);
      this.roundT = 0.2 + 0.25 * Math.sin(t * 5.3) * Math.sin(t * 2.1);
      if (this.voice - this.lastVoice > 0.18 && !this.g) {
        this.pitch.v += 0.9;
        this.sq.v -= 0.25;
      }
      this.lastVoice += (this.voice - this.lastVoice) * Math.min(H / 0.12, 1);
      return;
    }
    // Sans mesure de volume : un rythme de syllabes par phrases, avec pauses et accents.
    if (t >= this.sylEnd) {
      if (this.sylLeft <= 0) {
        // nouvelle phrase après une pause
        this.sylLeft = 3 + Math.floor(this.rand() * 9);
        this.openT = 0.02;
        const pause = 0.14 + this.rand() * 0.5;
        this.sylEnd = t + pause;
        this.sylClose = t + pause;
        this.sq.v += 0.2;
        // Entre deux phrases, le corps change d'appui : c'est ce qui remplace le geste sur les formes sans bras.
        this.leanS.v += (this.rand() - 0.5) * 0.5;
        this.tilt.v += (this.rand() - 0.5) * 30;
        return;
      }
      const dur = 0.11 + this.rand() * 0.13;
      const strong = this.rand() < 0.22;
      this.sylEnd = t + dur;
      this.sylClose = t + dur * 0.62;
      this.sylLeft--;
      this.openT = (strong ? 0.75 : 0.32) + this.rand() * 0.28;
      this.roundT = this.rand() < 0.3 ? 0.65 + this.rand() * 0.35 : this.rand() * 0.3;
      this.mwT = 0.92 + this.rand() * 0.28 - this.roundT * 0.1;
      // Chaque syllabe donne un petit coup au corps et à la tête, l'accent en donne un grand.
      this.sq.v -= 0.08 + this.rand() * 0.1;
      this.pitch.v += 0.25 + this.rand() * 0.35;
      if (strong) {
        // L'accent de la phrase : la tête plonge, le corps rebondit et bascule un peu.
        this.pitch.v += 1.6 + this.rand() * 1;
        this.sq.v -= 0.5 + this.rand() * 0.45;
        this.leanS.v += (this.rand() - 0.5) * 0.55;
        this.tilt.v += (this.rand() - 0.5) * 34;
        this.brow.v += 3;
        if (this.geo.arms) this.armLift.v += 9;
      }
    } else if (t >= this.sylClose) {
      this.openT = 0.05;
    }
  }

  // ── Regard : saccades courtes, durée selon l'amplitude (Eyes Alive), yeux d'abord, tête ensuite ──────────────────────────
  private saccade(x: number, y: number) {
    if (this.t - this.sEnd < 0.1 && this.sDur > 0) return false; // intervalle minimal entre deux saccades
    const tx = clamp(x, -GAZE_X, GAZE_X);
    const ty = clamp(y, -GAZE_Y, GAZE_Y);
    const dist = Math.hypot(tx - this.gx, ty - this.gy);
    if (dist < 0.05) return false;
    const deg = dist * DEG_PER_UNIT;
    const dur = (2.35 * deg + 25) / 1000;
    this.sFromX = this.gx;
    this.sFromY = this.gy;
    this.sToX = tx;
    this.sToY = ty;
    this.sT0 = this.t;
    this.sDur = dur;
    this.sEnd = this.t + dur;
    this.headAt = this.t + 0.065; // la tête part après les yeux
    this.headX = (tx / GAZE_X) * (this.calm ? 0.22 : 0.55);
    this.headY = (ty / GAZE_Y) * (this.calm ? 0.12 : 0.32);
    if (deg > 16 && this.rand() < 0.35 && this.t - this.blinkT > 0.5) this.blinkT = this.t;
    this.trace?.saccades.push({ t: this.t, dx: tx - this.gx, dy: ty - this.gy, deg, dur });
    return true;
  }

  private runGaze() {
    const t = this.t;
    if (t < this.sEnd) {
      const u = minJerk((t - this.sT0) / this.sDur);
      this.gx = this.sFromX + (this.sToX - this.sFromX) * u;
      this.gy = this.sFromY + (this.sToY - this.sFromY) * u;
    } else if (this.sDur > 0) {
      this.gx = this.sToX;
      this.gy = this.sToY;
    }
    if (t >= this.headAt && this.headAt > 0) {
      this.headTX = this.headX;
      this.headTY = this.headY;
      this.headAt = -9;
    }
    if (this.quiet || t < this.holdUntil) return;

    // Le pointeur passe devant tout : réaction humaine, entre 100 et 170 ms.
    if (t - this.pointerT < 2.4) {
      const tx = this.pointerX * GAZE_X;
      const ty = this.pointerY * GAZE_Y;
      if (Math.hypot(tx - this.sToX, ty - this.sToY) > 0.45) {
        if (this.pointerAt < 0) this.pointerAt = t + 0.1 + this.rand() * 0.07;
        else if (t >= this.pointerAt) {
          this.pointerAt = -9;
          this.saccade(tx, ty);
        }
      }
      this.nextSaccade = t + 0.6 + this.rand();
      return;
    }
    if (t < this.nextSaccade) return;
    const r = this.rand();
    let x = 0;
    let y = 0;
    let wait = 1;
    const away = this.calm ? 0.5 : 1;
    switch (this.state) {
      case "idle":
        // Surtout vers l'utilisateur, avec de petits écarts et parfois un vrai coup d'œil à côté.
        if (r < 0.5) {
          x = (this.rand() - 0.5) * 1.2;
          y = (this.rand() - 0.5) * 0.8;
        } else if (r < 0.84) {
          x = (this.rand() - 0.5) * 3.2 * away;
          y = (this.rand() - 0.5) * 1.8 * away;
        } else {
          x = (this.rand() < 0.5 ? -1 : 1) * (2.6 + this.rand() * 1.6) * away;
          y = (this.rand() - 0.6) * 2.2 * away;
        }
        wait = 0.7 + this.exp(1.3);
        break;
      case "listening":
        x = (this.rand() - 0.5) * 0.9;
        y = (this.rand() - 0.5) * 0.5;
        wait = 1.1 + this.exp(1.4);
        break;
      case "thinking": {
        // Regard en l'air, d'un côté puis de l'autre ; bas et balayage quand la tâche s'allonge.
        const age = t - this.tState;
        if (age < 5) {
          x = this.dirT * (1.2 + this.rand() * 2.2) * (this.rand() < 0.75 ? 1 : -0.6);
          y = -1.6 - this.rand() * 1.5;
        } else {
          x = (this.rand() - 0.5) * 6;
          y = 1 + this.rand() * 1.3;
        }
        wait = 0.7 + this.exp(0.7);
        break;
      }
      case "speaking":
        // Contact environ un tiers du temps, sinon le regard part puis revient.
        if (r < 0.34) {
          x = (this.rand() - 0.5) * 0.7;
          y = (this.rand() - 0.5) * 0.5;
        } else {
          x = (this.rand() - 0.5) * 4;
          y = (this.rand() - 0.65) * 2;
        }
        wait = 0.8 + this.exp(0.9);
        break;
      case "working":
        // Il lit ce qu'il fait : le regard, baissé, avance par petits sauts de gauche à droite, puis revient.
        this.scanX = this.scanX > 2 ? -2.6 : this.scanX + 0.9 + this.rand() * 0.7;
        x = this.scanX;
        y = 1.3 + this.rand() * 0.7;
        wait = 0.22 + this.rand() * 0.3;
        break;
      case "waiting":
      case "pleased":
        // Vers toi, et il y reste.
        x = (this.rand() - 0.5) * 0.5;
        y = (this.rand() - 0.5) * 0.4 - 0.2;
        wait = 1.4 + this.exp(1.2);
        break;
      case "upset":
        x = (this.rand() - 0.5) * 1.2;
        y = 1.8 + this.rand() * 0.6;
        wait = 1.6 + this.exp(1);
        break;
    }
    this.nextSaccade = t + wait;
    this.saccade(x, y);
  }

  // ── Saut : une vraie balistique sous gravité, avec préparation, contact et rebond amorti ─────────────────────────────────
  private startHop(height: number, antic: number, amt: number) {
    if (this.jump !== 0) return false;
    this.jump = 1;
    this.jumpT = this.t;
    this.anticDur = antic;
    this.anticAmt = amt;
    this.hopH = height;
    return true;
  }

  private runJump(): number {
    const m = this.material;
    if (this.jump === 0) return 0;
    const t = this.t;
    if (this.jump === 1) {
      this.oLid -= 0.1;
      this.oPitch += 0.12;
      if (t - this.jumpT >= this.anticDur) {
        this.v0 = Math.sqrt(2 * m.gravity * this.hopH);
        this.altV = this.v0;
        this.alt = 0;
        // L'élan étire le corps au départ ; le ressort le ramène rond vers le sommet.
        this.sq.v -= (0.28 * m.omega) / 0.58;
        this.jump = 2;
        return 0;
      }
      return this.anticAmt * smooth((t - this.jumpT) / 0.05);
    }
    if (this.jump === 2) {
      this.altV -= m.gravity * H;
      this.alt += this.altV * H;
      this.oWide += 0.05;
      this.oPitch += clamp(-this.altV * 0.003, -0.35, 0.35);
      if (this.alt <= 0) {
        this.alt = 0;
        this.impact = -this.altV;
        this.altV = 0;
        this.jump = 3;
        this.jumpT = t;
        // L'impact pousse le ressort : plus on tombe vite, plus on s'écrase.
        const ref = Math.sqrt(2 * m.gravity * m.hop);
        this.sq.v += ((this.impact / ref) * 0.3 * m.omega) / 0.58;
        this.pitch.v += (this.impact / ref) * 2.2;
        this.contactDur = Math.min(0.09, (0.5 * Math.PI) / m.omega);
        return 0;
      }
      // Rond au sommet, il s'étire en retombant.
      if (this.altV > 0) return 0;
      const u = clamp(-this.altV / this.v0, 0, 1);
      return -0.16 * u * u;
    }
    // Contact : le corps s'écrase au sol avant de rebondir.
    this.oLid -= 0.22;
    if (t - this.jumpT >= this.contactDur) {
      const again = this.impact * m.bounce;
      if (again > 16) {
        this.altV = again;
        this.jump = 2;
      } else {
        this.jump = 0;
        this.altV = 0;
      }
    }
    return 0;
  }

  // ── Gestes déclenchés ──────────────────────────────────────────────────────────────────────────────────────────────
  private runGesture() {
    const g = this.g;
    if (!g) return;
    const a = this.t - g.t0;
    const m = this.material;
    const end = () => {
      this.g = null;
    };
    switch (g.kind) {
      case "hop": {
        if (g.stage === 0 && this.startHop(m.hop * [0.8, 1, 1.2, 0.9, 1.1][g.v], [0.15, 0.19, 0.17, 0.2, 0.14][g.v], [0.17, 0.21, 0.24, 0.19, 0.15][g.v])) g.stage = 1;
        if (g.stage === 1 && this.jump === 0 && a > 0.2) end();
        break;
      }
      case "joy": {
        const hops = 2 + (g.v % 2);
        this.oCres += window01(a, 0.08, 99, 0.2) * 0.95;
        this.oSmile += 0.5;
        this.oCheek += 1;
        this.oArm += 5 * Math.abs(Math.sin(a * 7));
        if (this.jump === 0 && g.hops < hops && a >= g.next) {
          const scale = [1, 0.75, 1.1][g.hops] * [1, 1.1, 0.85, 0.95][g.v];
          if (this.startHop(m.hop * scale, g.hops === 0 ? 0.13 : 0.09, g.hops === 0 ? 0.2 : 0.14)) g.hops++;
        }
        if (this.jump === 0 && g.hops >= hops) {
          if (!g.stage) {
            g.stage = 1;
            g.next = a;
          } else if (a - g.next > 0.35) end();
        } else if (this.jump === 3) g.next = a + 0.03;
        break;
      }
      case "greet": {
        this.oSmile += 0.4 * window01(a, 0.1, 1.2, 0.3);
        this.oLean += 0.045 * Math.sin(a * [11, 9, 12, 10][g.v]) * (1 - smooth(a / 1.2));
        if (g.stage === 0 && this.startHop(m.hop * [0.55, 0.7, 0.45, 0.6][g.v], 0.12, 0.15)) g.stage = 1;
        if (a > 1.2) end();
        break;
      }
      case "surprise": {
        const big = [1, 0.8, 1.15, 0.9][g.v];
        if (a < 0.07) this.oS += 0.13 * big;
        else {
          const e = 1 - smooth((a - 0.5) / 0.5);
          this.oS -= 0.25 * big * e;
          this.oWide += 0.28 * big * e;
          this.oLid += 0.14 * e;
          this.oOpen += 0.42 * big * e;
          this.oRound += 0.7 * e;
          this.oSmile -= 0.9 * e;
          this.oBrow += 1.2 * e;
        }
        if (g.stage === 0 && a >= 0.07) {
          g.stage = 1;
          this.sq.v -= 3 * big;
          this.alt = 0;
          if (this.jump === 0) {
            this.v0 = Math.sqrt(2 * m.gravity * m.hop * 0.3);
            this.altV = this.v0;
            this.jump = 2;
          }
        }
        if (a > 1) end();
        break;
      }
      case "attention": {
        const e = window01(a, 0.15, 1.5, 0.4);
        this.oS -= 0.09 * e;
        this.oWide += 0.12 * e;
        this.oBrow += 0.8 * e;
        this.oLid += 0.08 * e;
        this.holdUntil = this.t + 0.1;
        if (g.stage === 0) {
          g.stage = 1;
          this.saccade(0, 0);
          this.startHop(m.hop * 0.3, 0.09, 0.18);
        }
        if (a > 1.5) end();
        break;
      }
      case "aha": {
        const e = window01(a, 0.11, 0.46, 0.22);
        this.oWide += 0.18 * e;
        this.oLid += 0.1 * e;
        this.oBrow += 0.5 * e;
        this.oS -= 0.05 * e;
        if (g.stage === 0) {
          g.stage = 1;
          this.sq.v -= 0.7;
        }
        if (a > 0.46) end();
        break;
      }
      case "nod": {
        const n = [1, 2, 1, 2, 3][g.v];
        const T = [0.38, 0.32, 0.46, 0.3, 0.27][g.v];
        const A = [0.75, 0.48, 0.95, 0.55, 0.42][g.v];
        const dur = n * T;
        const pulse = a < dur ? Math.sin((Math.PI * (a % T)) / T) : 0;
        this.oPitch += A * pulse;
        this.oS += 0.03 * pulse;
        this.oLid -= 0.08 * pulse;
        if (a > dur) end();
        break;
      }
      case "shake": {
        const T = [0.4, 0.34, 0.46, 0.38][g.v];
        const dur = T * [2, 2.5, 1.5, 2][g.v];
        this.oTurn += 0.62 * Math.sin((2 * Math.PI * a) / T) * (1 - smooth(a / dur));
        this.oSmile -= 0.5;
        if (a > dur) end();
        break;
      }
      case "lookLeft":
      case "lookRight": {
        const dir = g.kind === "lookLeft" ? -1 : 1;
        const hold = [1.0, 1.3, 0.8, 1.15][g.v];
        const e = window01(a - 0.05, 0.12, hold, 0.22);
        this.oTurn += dir * 0.5 * e;
        this.oLean += dir * 0.032 * e;
        this.oTilt += dir * 3 * e;
        this.holdUntil = this.t + 0.2;
        if (g.stage === 0) {
          g.stage = 1;
          this.blinkT = this.t; // l'anticipation du regard : un clignement
        }
        if (g.stage === 1 && a >= 0.05 && this.saccade(dir * [3.2, 3.6, 2.8, 3.4][g.v], [-0.5, 0.3, 0, -0.9][g.v])) g.stage = 2;
        if (g.stage === 2 && a >= hold && this.saccade(0, 0)) g.stage = 3;
        if (g.stage === 3 && a >= hold + 0.3) end();
        break;
      }
      case "wiggle": {
        const T = [0.3, 0.36, 0.26, 0.33][g.v];
        const dur = [0.9, 1.1, 0.75, 1][g.v];
        const k = Math.sin((2 * Math.PI * a) / T) * (1 - smooth(a / dur));
        this.oLean += 0.065 * k;
        this.oTilt -= 6 * k;
        this.oS += 0.03 * Math.abs(k);
        if (a > dur) end();
        break;
      }
      case "sad": {
        const dur = [2.2, 2.8, 2, 2.5][g.v];
        const e = window01(a, 0.35, dur, 0.9);
        this.oS += 0.11 * e;
        this.oLid -= 0.02 * e;
        this.oWide += 0.05 * e;
        this.oSlant += 1 * e;
        this.oSmile -= 2.5 * e;
        this.oBrow -= 0.9 * e;
        this.oPitch += 0.4 * e;
        this.holdUntil = this.t + 0.2;
        if (g.stage === 0) {
          g.stage = 1;
          this.saccade([0.6, -0.9, 0.2, -0.3][g.v], 2.5);
        }
        if (g.stage === 1 && a > dur - 0.7 && this.saccade(0, 0)) g.stage = 2;
        if (a > dur) end();
        break;
      }
      case "confused": {
        const dur = [1.6, 1.9, 1.4, 1.7][g.v];
        const e = window01(a, 0.16, dur, 0.4);
        this.oTilt += g.dir * 10 * e;
        this.oLean += g.dir * 0.03 * e + 0.018 * Math.sin(a * 6.5) * e;
        this.oBrowTilt += g.dir * e;
        this.oSmile -= 0.9 * e;
        this.oMx += g.dir * 1.6 * e;
        if (a > dur) end();
        break;
      }
      case "sigh": {
        const dur = [1.4, 1.7, 1.25, 1.5][g.v];
        const inhale = window01(a, 0.32, 0.5, 0.18);
        const exhale = window01(a - 0.45, 0.2, dur - 0.45, 0.45);
        this.oS -= 0.035 * inhale;
        this.oS += 0.055 * exhale;
        this.oLid -= 0.18 * exhale;
        this.oOpen += 0.1 * exhale;
        this.oRound += 0.5 * exhale;
        if (a > dur) end();
        break;
      }
      case "puff": {
        const dur = [0.8, 1, 0.7, 0.9][g.v];
        const e = window01(a, 0.14, dur, 0.18);
        this.oS += 0.045 * e;
        this.oCheek += 0.7 * e;
        this.oMw -= 0.45 * e;
        this.oSmile -= 0.5 * e;
        if (a > dur) end();
        break;
      }
    }
  }

  private computePose() {
    const p = this.pose;
    const blink = this.quiet ? 0 : this.blinkAmount();
    const give = this.material.give;
    p.squash = this.sq.x;
    p.lean = this.leanS.x;
    p.bend = this.leanTip.x - this.leanS.x;
    p.tipY = this.tipV.x;
    p.alt = this.alt;
    p.belly = this.turn.x * 0.8;
    p.turn = this.turn.x;
    p.pitch = this.pitch.x;
    p.tilt = this.tilt.x;
    p.gazeX = this.gx;
    p.gazeY = this.gy;
    p.lidRaw = Math.max(0, this.lid.x);
    p.lid = Math.max(0, this.lid.x) * (1 - blink);
    p.crescent = this.cres.x;
    p.wide = this.wide.x;
    p.open = Math.max(0, this.open.x);
    p.round = clamp(this.round.x, 0, 1);
    p.mouthWide = this.mw.x;
    p.smile = this.smile.x;
    p.mouthX = this.mx.x;
    p.brow = this.brow.x;
    p.slant = this.slant.x;
    p.browTilt = this.oBrowTilt;
    p.cheek = clamp(this.cheek.x, 0, 1);
    // Retard des accessoires sur leur point d'attache
    p.antennaX = this.antX.x - this.anchorX(1);
    p.antennaY = this.antY.x - this.anchorY(1);
    p.glassX = this.glassX.x - this.anchorX(0.5);
    p.glassY = this.glassY.x - this.anchorY(0.5);
    p.armLX = this.armLX.x - this.anchorX(0.3);
    p.armLY = this.armLY.x - this.anchorY(0.3);
    p.armRX = this.armRX.x - this.anchorX(0.3);
    p.armRY = this.armRY.x - this.anchorY(0.3);
    p.armLift = this.armLift.x;
    // L'ombre reste au sol : elle se réduit et pâlit avec l'altitude, et s'élargit à peine quand le corps s'écrase au sol.
    const contact = this.alt === 0 ? Math.max(0, this.sq.x) * give * 0.12 : 0;
    p.shadowW = 1 - this.alt * 0.036 + contact;
    p.shadowO = 1 - this.alt * 0.05;
  }
}

const VARIANTS: Partial<Record<NoahReaction, number>> = { hop: 5, nod: 5 };

// ─── Déformation de la silhouette ──────────────────────────────────────────────────────────────────────────────────────

/** Déforme les points de contrôle et garde l'aire exacte, base posée au sol. Le même calcul place les yeux, la bouche, les accessoires. */
export class Warp {
  geo: BodyGeometry;
  material: Material;
  sy = 1;
  sx = 1;
  kx = 1;
  private taper = 0;
  private flat = 0;
  private lean = 0;
  private bend = 0;
  private belly = 0;
  private tipX = 0;
  private tipY = 0;
  readonly X: Float64Array;
  readonly Y: Float64Array;
  private W: Float64Array;
  private D: Float64Array;
  private n: number;

  constructor(shape: NoahShape) {
    this.geo = bodyOf(shape);
    this.material = MATERIALS[shape];
    this.n = this.geo.pts.length / 2;
    this.X = new Float64Array(this.n);
    this.Y = new Float64Array(this.n);
    this.W = new Float64Array(this.n);
    this.D = new Float64Array(this.n);
  }

  update(p: Pose) {
    const g = this.geo;
    const m = this.material;
    const S0 = limitSquash(p.squash * m.give);
    this.sy = Math.exp(-S0);
    this.sx = 1 / this.sy;
    this.taper = clamp(S0 * m.taper, -0.28, 0.28);
    this.flat = clamp(S0 * 1.5 * m.flat, 0, 0.9);
    this.lean = p.lean * g.height;
    this.bend = p.bend * g.height;
    this.belly = p.belly;
    this.tipX = p.bend * g.height * m.tip * 1.4;
    this.tipY = p.tipY * g.height * m.tip;
    const base = g.base;
    const pts = g.pts;
    const hs = g.hs;
    const { W, Y, X, D, n } = this;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2];
      const y = pts[i * 2 + 1];
      const h = hs[i];
      let yy = base - (base - y) * this.sy;
      if (this.flat > 0 && h < 1) {
        const k = 1 - h;
        yy += this.flat * (base - yy) * k * k * k * k;
      }
      if (this.tipY !== 0) yy -= this.tipY * h * h * h;
      W[i] = (x - 32) * this.sx * (1 + this.taper * (1 - 2 * h));
      D[i] = this.lean * h + this.bend * h * h + this.belly * Math.sin(Math.PI * clamp(h, 0, 1)) + this.tipX * h * h * h;
      Y[i] = yy;
    }
    // L'aire est linéaire en x : on en déduit la largeur exacte qui rend celle du repos, décalages compris.
    const a = areaOf(W, Y, n);
    this.kx = a !== 0 ? (g.area - areaOf(D, Y, n)) / a : 1;
    for (let i = 0; i < n; i++) X[i] = 32 + W[i] * this.kx + D[i];
  }

  /** Aire du contour tel que dessiné. */
  area() {
    return areaOf(this.X, this.Y, this.n);
  }

  px(x: number, y: number) {
    const h = (this.geo.base - y) / this.geo.height;
    const f = this.sx * this.kx * (1 + this.taper * (1 - 2 * h));
    return 32 + (x - 32) * f + this.lean * h + this.bend * h * h + this.belly * Math.sin(Math.PI * clamp(h, 0, 1)) + this.tipX * h * h * h;
  }

  py(y: number) {
    const base = this.geo.base;
    const h = (base - y) / this.geo.height;
    return base - (base - y) * this.sy - this.tipY * h * h * h;
  }

  /** Contour SVG. `q` : précision (10 ou 100 par unité). */
  path(q: number) {
    const { X, Y, n } = this;
    const f = (v: number) => Math.round(v * q) / q;
    let d = `M${f(X[0])} ${f(Y[0])}C`;
    for (let i = 1; i < n; i++) d += `${f(X[i])} ${f(Y[i])} `;
    return `${d}Z`;
  }
}
