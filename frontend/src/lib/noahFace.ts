// Fait vivre les visages à l'écran : une seule boucle d'animation pour tous les visages visibles, plus rien quand l'onglet est
// caché ou qu'aucun visage n'est à l'écran, et aucun mouvement en mode réduit ou en pause. Écrit directement les attributs SVG :
// React ne repeint rien à chaque image.
import { GROUND_Y, NoahSim, Warp, hashSeed, restPose, type NoahReaction, type NoahShape, type NoahState, type Pose } from "./noahMotion";

export type LevelRef = { current: number };
export type FaceOptions = { shape: NoahShape; detail: string; seed: string; state: NoahState; still: boolean };

const PAUSE_KEY = "noah-visage-immobile";
const LOOK_MIN_SIZE = 56; // en dessous, un visage ne suit pas le pointeur : une liste entière qui regarde la souris distrait
const CALM_MAX_SIZE = 48;
const FADE = 0.18;
const MIN_FRAME = 1000 / 60 - 2; // jamais plus de 60 images/s, même sur un écran à 120 Hz : un avatar n'y gagne rien, la batterie si
const CALM_FRAME = 33; // un visage qui ne fait que respirer n'est recalculé que 30 fois par seconde…
const CALM_FRAME_SMALL = 66; // …et 15 fois en petite taille
const LIST_FRAME = 33; // en liste, un petit visage qui bouge reste à 30 images/s : le clignement reste lisible, le budget aussi
const STILL_PX = 0.3; // un mouvement plus petit que ça à l'écran attend le calcul suivant : au repos, presque rien à repeindre
const BUSY_PX = 0.6; // au-delà, il bouge vraiment : pleine cadence
const MAX_HOLD = 0.4;
const SLEEP_MIN = 6; // à attendre plus longtemps que ça, on dort sur une minuterie plutôt que de réveiller le navigateur à chaque image

function storedPause() {
  try {
    return localStorage.getItem(PAUSE_KEY) === "1";
  } catch {
    return false;
  }
}

const reduceQuery = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
let paused = storedPause();

/** Compteurs lus par la page de démonstration. Ne coûtent rien tant que `on` est faux. */
export const noahStats = { on: false, frames: 0, engineMs: 0, stepMs: 0, writes: 0, rafCalls: 0, maxEngineMs: 0 };

const faces = new Set<NoahFace>();
const active = new Set<NoahFace>();
let raf = 0;
let timer = 0;
let last = 0;
let pointerX = 0;
let pointerY = 0;
let pointerNew = false;
let pointerRead = 0;
let listening = false;

function motionOff() {
  return paused || !!reduceQuery?.matches;
}

function wake() {
  if (raf || timer || typeof requestAnimationFrame !== "function") return;
  if (typeof document !== "undefined" && document.hidden) return;
  const fading = [...active].some((f) => f.fading());
  if (!active.size || (motionOff() && !fading)) return;
  raf = requestAnimationFrame(frame);
  last = 0;
}

/** Quelque chose vient d'arriver à un visage : pas question d'attendre la fin de la minuterie. */
function poke() {
  if (timer) {
    clearTimeout(timer);
    timer = 0;
  }
  wake();
}

const onGrid = (now: number, period: number) => (Math.floor(now / period) + 1) * period;

function sleepUntil(at: number, now: number) {
  const wait = at - now;
  if (wait < SLEEP_MIN) {
    raf = requestAnimationFrame(frame);
    return;
  }
  // On se réveille un peu avant, et c'est encore requestAnimationFrame qui cale le dessin sur l'écran.
  timer = window.setTimeout(() => {
    timer = 0;
    if (typeof document !== "undefined" && document.hidden) return;
    raf = requestAnimationFrame(frame);
  }, wait - 4);
}

function frame(now: number) {
  raf = 0;
  if (noahStats.on) noahStats.rafCalls++;
  const off = motionOff();
  const dt = last ? (now - last) / 1000 : 1 / 60;
  last = now;
  const t0 = noahStats.on ? performance.now() : 0;
  if (off) {
    let more = false;
    for (const f of active) if (f.stepFade(dt)) more = true;
    if (more) {
      raf = requestAnimationFrame(frame);
    }
    return;
  }
  // Lecture du pointeur avant toute écriture : pas de mise en page forcée au milieu des écritures.
  const readPointer = pointerNew && now - pointerRead > 66;
  if (readPointer) {
    pointerNew = false;
    pointerRead = now;
    for (const f of active) f.readPointer(pointerX, pointerY);
  }
  // Chaque visage a son rythme : celui qui bouge est calculé à chaque image, celui qui respire attend son tour.
  const crowded = active.size > 8;
  let soonest = Infinity;
  for (const f of active) {
    if (now >= f.nextAt - 1.5) f.frame(now, crowded);
    if (f.nextAt < soonest) soonest = f.nextAt;
  }
  if (noahStats.on) {
    const ms = performance.now() - t0;
    noahStats.frames++;
    noahStats.engineMs += ms;
    if (ms > noahStats.maxEngineMs) noahStats.maxEngineMs = ms;
  }
  if (active.size) sleepUntil(soonest, now);
}

let observer: IntersectionObserver | null = null;
function seen(entries: IntersectionObserverEntry[]) {
  for (const e of entries) {
    const f = faceOf.get(e.target);
    if (!f) continue;
    f.size = e.boundingClientRect.width;
    f.visible = e.isIntersecting && e.boundingClientRect.width > 0;
    if (f.visible) {
      active.add(f);
      f.onVisible();
    } else active.delete(f);
  }
  wake();
}

const faceOf = new WeakMap<Element, NoahFace>();

function startListening() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (raf) cancelAnimationFrame(raf);
      if (timer) clearTimeout(timer);
      raf = 0;
      timer = 0;
    } else wake();
  });
  addEventListener(
    "pointermove",
    (e) => {
      pointerX = e.clientX;
      pointerY = e.clientY;
      pointerNew = true;
    },
    { passive: true },
  );
  reduceQuery?.addEventListener("change", applyMotionSetting);
}

function applyMotionSetting() {
  for (const f of faces) f.applyMotion();
  wake();
}

/** Le réglage de l'utilisateur : figer tous les visages (WCAG 2.2.2). Retenu sur cet appareil. */
export function setNoahPaused(value: boolean) {
  paused = value;
  try {
    if (value) localStorage.setItem(PAUSE_KEY, "1");
    else localStorage.removeItem(PAUSE_KEY);
  } catch {
    // stockage indisponible : le réglage vaut pour cette page
  }
  applyMotionSetting();
}
export const noahPaused = () => paused;
/** Les visages en vie, pour les mesures de la page de démonstration. */
export const noahFaces = () => [...faces];
export const noahActive = () => [...active];

const r2 = (v: number) => Math.round(v * 100) / 100;
const K = 0.5523;

type Slot = { el: Element; name: string; last: string };

export class NoahFace {
  readonly sim: NoahSim;
  size = 96;
  visible = false;
  /** Quand ce visage doit être recalculé, en temps de requestAnimationFrame. */
  nextAt = 0;
  private lastNow = 0;
  private warp: Warp;
  private root: SVGSVGElement;
  private detail: string;
  private still: boolean;
  private slots = new Map<string, Slot>();
  private mic: LevelRef | null = null;
  private voice: LevelRef | null = null;
  private fade = -1;
  private fadeTo: NoahState = "idle";
  private faceGroup: Element | null;

  constructor(svg: SVGSVGElement, o: FaceOptions) {
    this.root = svg;
    this.detail = o.detail;
    this.still = o.still;
    this.warp = new Warp(o.shape);
    this.sim = new NoahSim({ shape: o.shape, seed: hashSeed(o.seed), state: o.state });
    this.faceGroup = svg.querySelector('[data-n="face"]');
    this.size = svg.getBoundingClientRect().width || 96;
    this.sim.calm = this.size > 0 && this.size <= CALM_MAX_SIZE;
    if (this.frozen()) this.sim.settle(o.state);
    this.draw();
    faces.add(this);
    faceOf.set(svg, this);
    startListening();
    if (!still(o) && typeof IntersectionObserver === "function") {
      observer ??= new IntersectionObserver(seen, { rootMargin: "64px" });
      observer.observe(svg);
    }
  }

  dispose() {
    faces.delete(this);
    active.delete(this);
    observer?.unobserve(this.root);
  }

  private frozen() {
    return this.still || motionOff();
  }

  fading() {
    return this.fade >= 0;
  }

  setLevels(mic: LevelRef | null | undefined, voice: LevelRef | null | undefined) {
    this.mic = mic ?? null;
    this.voice = voice ?? null;
    if (!this.mic) this.sim.mic = 0; // micro coupé : le corps ne reste pas figé sur le dernier niveau lu
  }

  setState(state: NoahState) {
    if (this.frozen()) {
      if (this.sim.state === state && this.fade < 0) return;
      if (this.still) {
        this.sim.settle(state);
        this.draw();
        return;
      }
      // Mouvement réduit : l'expression change par un fondu, sans déplacer ni déformer le corps.
      this.fadeTo = state;
      if (this.fade < 0) this.fade = 0;
      active.add(this);
      wake();
      return;
    }
    this.sim.setState(state);
    this.nextAt = 0;
    poke();
  }

  react(kind: NoahReaction) {
    if (this.frozen()) return;
    this.sim.react(kind);
    this.nextAt = 0;
    poke();
  }

  applyMotion() {
    if (this.frozen()) {
      this.fade = -1;
      this.sim.settle(this.sim.state);
      this.faceGroup?.removeAttribute("opacity");
      this.draw();
    }
  }

  onVisible() {
    this.sim.calm = this.size > 0 && this.size <= CALM_MAX_SIZE;
    this.nextAt = 0;
  }

  readPointer(px: number, py: number) {
    if (this.size < LOOK_MIN_SIZE) return;
    const r = this.root.getBoundingClientRect();
    const dx = px - (r.left + r.width / 2);
    const dy = py - (r.top + r.height / 2);
    // Le regard se porte vers le pointeur, de plus en plus franchement avec la distance.
    const reach = Math.max(r.width, 120);
    this.sim.look(dx / (reach * 1.6), dy / (reach * 1.6));
  }

  stepFade(dt: number) {
    if (this.fade < 0) return false;
    const before = this.fade;
    this.fade += dt;
    const half = FADE / 2;
    if (before < half && this.fade >= half) {
      this.sim.settle(this.fadeTo);
      this.draw();
    }
    const o = this.fade < half ? 1 - (this.fade / half) * 0.75 : 0.25 + ((this.fade - half) / half) * 0.75;
    if (this.fade >= FADE) {
      this.fade = -1;
      this.faceGroup?.removeAttribute("opacity");
      if (!this.visible) active.delete(this);
      return false;
    }
    this.faceGroup?.setAttribute("opacity", String(r2(o)));
    return true;
  }

  frame(now: number, crowded: boolean) {
    if (this.still) {
      this.nextAt = Infinity;
      return;
    }
    const dt = this.lastNow ? (now - this.lastNow) / 1000 : 1 / 60;
    this.lastNow = now;
    if (this.mic) this.sim.mic = this.mic.current;
    if (this.voice) this.sim.setVoice(this.voice.current);
    const t0 = noahStats.on ? performance.now() : 0;
    this.sim.advance(dt);
    if (noahStats.on) noahStats.stepMs += performance.now() - t0;
    this.hold += dt;
    const px = this.moved() * (this.size / 64);
    const small = this.size <= CALM_MAX_SIZE;
    // Une grille commune : les visages d'une liste changent dans la même image, le navigateur ne repeint qu'une fois.
    if (this.sim.lively() || px > BUSY_PX) this.nextAt = small && crowded ? onGrid(now, LIST_FRAME) : now + MIN_FRAME;
    else this.nextAt = onGrid(now, small ? CALM_FRAME_SMALL : CALM_FRAME);
    if (this.hold < MAX_HOLD && px < STILL_PX) return;
    this.hold = 0;
    this.draw();
  }

  /** De combien de pixels de la grille ce qui se voit a bougé depuis le dernier dessin. */
  private moved() {
    const p = this.sim.pose;
    const a = this.drawn;
    const H = this.sim.geo.height;
    const d = (x: number, y: number, k: number) => Math.abs(x - y) * k;
    return Math.max(
      d(p.squash, a.squash, H), d(p.lean, a.lean, H), d(p.bend, a.bend, H), d(p.alt, a.alt, 1), d(p.turn, a.turn, 4), d(p.pitch, a.pitch, 3), d(p.tilt, a.tilt, 0.4),
      d(p.gazeX, a.gazeX, 1), d(p.gazeY, a.gazeY, 1), d(p.lid, a.lid, 5), d(p.crescent, a.crescent, 5), d(p.wide, a.wide, 5), d(p.open, a.open, 8), d(p.round, a.round, 3),
      d(p.smile, a.smile, 3), d(p.brow, a.brow, 2), d(p.antennaX, a.antennaX, 1), d(p.antennaY, a.antennaY, 1), d(p.glassX, a.glassX, 0.5), d(p.glassY, a.glassY, 0.5),
      d(p.armLX, a.armLX, 1), d(p.armLY, a.armLY, 1), d(p.armRX, a.armRX, 1), d(p.armRY, a.armRY, 1), d(p.armLift, a.armLift, 1),
    );
  }

  private hold = 0;
  private drawn: Pose = restPose();

  /** Écrit un attribut seulement s'il change : au repos, aucune repeinture. */
  private set(key: string, name: string, value: string, sel?: string) {
    let s = this.slots.get(key);
    if (!s) {
      const el = this.root.querySelector(`[data-n="${sel ?? key}"]`);
      if (!el) return;
      s = { el, name, last: "" };
      this.slots.set(key, s);
    }
    if (s.last === value) return;
    s.last = value;
    s.el.setAttribute(name, value);
    if (noahStats.on) noahStats.writes++;
  }

  private eye(key: string, rx0: number, p: Pose) {
    const w = this.warp;
    const side = rx0 < 32 ? -1 : 1;
    const fy = this.sim.geo.face;
    const cos = Math.cos((p.tilt * Math.PI) / 180);
    const sin = Math.sin((p.tilt * Math.PI) / 180);
    // Centre : suit le corps, la tête (rotation de la fausse 3D) et le regard, et ne quitte jamais le visage.
    const bx = w.px(rx0, 32 + fy) - 32;
    const by = w.py(32 + fy) - 36;
    const cx = 32 + bx * cos - by * sin + p.turn * 4.2 + p.gazeX;
    const cy = 36 + bx * sin + by * cos + p.pitch * 3 + p.gazeY;
    // Les yeux se déforment moins que le corps : c'est ce qui les garde lisibles.
    const near = 1 - side * p.turn * 0.12;
    const rx = 3.55 * Math.sqrt(w.sx * w.kx) * p.wide * near;
    const ry = 4.75 * Math.sqrt(w.sy) * p.wide;
    const top = ry * Math.min(p.lid, 1.2);
    // La paupière du bas remonte seulement à la fin du clignement : l'œil fermé est un trait courbe, pas une demi-lune.
    const bottom = ry * (1 - 1.5 * p.crescent) * (0.12 + 0.88 * Math.min(1, p.lid / 0.55));
    const ktop = K + 0.3 * Math.max(0, 1 - p.lid);
    // Paupière inclinée : le coin extérieur tombe (tristesse).
    const a = 0.32 * p.slant * (side < 0 ? 1 : -1);
    const tL = top * (1 - a);
    const tR = top * (1 + a);
    // Point local (a, b) tourné avec la tête
    const X = (a: number, b: number) => r2(cx + a * cos - b * sin);
    const Y = (a: number, b: number) => r2(cy + a * sin + b * cos);
    const P = (a: number, b: number) => `${X(a, b)} ${Y(a, b)}`;
    const d =
      `M${P(-rx, 0)}C${P(-rx, -K * tL)} ${P(-ktop * rx, -tL)} ${P(0, -top)}` +
      `C${P(ktop * rx, -tR)} ${P(rx, -K * tR)} ${P(rx, 0)}` +
      `C${P(rx, K * bottom)} ${P(K * rx, bottom)} ${P(0, bottom)}` +
      `C${P(-K * rx, bottom)} ${P(-rx, K * bottom)} ${P(-rx, 0)}Z`;
    this.set(key, "d", d);
    // Reflet : il reste en haut à droite de l'œil et disparaît quand l'œil se ferme.
    const visible = p.lid > 0.28 && p.crescent < 0.6;
    const hx = cx + (1.4 + p.gazeX * 0.1) * p.wide;
    const hy = cy - 2.2 * p.wide * Math.min(1, p.lid) * Math.sqrt(w.sy) + p.gazeY * 0.1;
    const hkey = key === "eyeL" ? "hiL" : "hiR";
    this.set(`${hkey}x`, "cx", String(r2(hx)), hkey);
    this.set(`${hkey}y`, "cy", String(r2(hy)), hkey);
    this.set(`${hkey}r`, "r", visible ? String(r2(1.35 * p.wide * Math.min(1, p.lid * 1.1))) : "0", hkey);
  }

  /** Dessine la pose courante. */
  draw() {
    const p = this.sim.pose;
    const w = this.warp;
    const geo = this.sim.geo;
    Object.assign(this.drawn, p);
    w.update(p);
    const q = this.size <= CALM_MAX_SIZE ? 10 : 100;
    this.set("body", "d", w.path(q));
    this.set("lift", "transform", p.alt ? `translate(0 ${r2(-p.alt)})` : "");
    this.set("shadowW", "rx", String(r2(geo.ground * p.shadowW)), "shadow");
    this.set("shadowO", "opacity", String(r2(0.12 * p.shadowO)), "shadow");
    this.set("shadowY", "cy", String(GROUND_Y), "shadow");

    this.eye("eyeL", 24.6, p);
    this.eye("eyeR", 39.4, p);

    const cos = Math.cos((p.tilt * Math.PI) / 180);
    const sin = Math.sin((p.tilt * Math.PI) / 180);
    const rotX = (x: number, y: number) => 32 + x * cos - y * sin;
    const rotY = (x: number, y: number) => 36 + x * sin + y * cos;
    const fy = geo.face;

    // Bouche
    {
      const bx = w.px(32, 40 + fy) - 32;
      const by = w.py(40 + fy) - 36;
      const mx = rotX(bx, by) + p.turn * 3.6 + p.mouthX;
      const my = rotY(bx, by) + p.pitch * 3.4;
      const hw = 3.8 * Math.sqrt(w.sx * w.kx) * (p.mouthWide + 0.35 * p.open - 0.48 * p.round);
      const corner = (1 - p.smile) * 0.8;
      const low = (1.2 + 3 * p.smile + p.open * 13) * (2 / 3);
      const up = (0.6 + 0.9 * p.smile - p.open * 4.5) * (2 / 3);
      const hx = hw * 2 * (0.3335 - 0.21 * p.round);
      const X = (a: number, b: number) => r2(mx + a * cos - b * sin);
      const Y = (a: number, b: number) => r2(my + a * sin + b * cos);
      const P = (a: number, b: number) => `${X(a, b)} ${Y(a, b)}`;
      const c = corner;
      this.set(
        "mouth",
        "d",
        `M${P(-hw, c)}C${P(-hw + hx, c + low)} ${P(hw - hx, c + low)} ${P(hw, c)}C${P(hw - hx, c + up)} ${P(-hw + hx, c + up)} ${P(-hw, c)}Z`,
      );
    }

    // Reflet : glisse à l'opposé quand la tête tourne.
    {
      const [sx0, sy0] = geo.shine;
      const x = w.px(sx0, sy0) - p.turn * 3 - p.gazeX * 0.1;
      const y = w.py(sy0) - p.pitch * 1.2;
      this.set(
        "shine",
        "transform",
        `translate(${r2(x)} ${r2(y)}) rotate(${r2(-24 + p.lean * 40)}) scale(${r2(Math.sqrt(w.sx * w.kx))} ${r2(Math.sqrt(w.sy))})`,
      );
    }

    if (geo.arms) {
      const lx = w.px(8.6, 41.5) + p.armLX;
      const ly = w.py(41.5) + p.armLY - p.armLift;
      const rx = w.px(56, 35.5) + p.armRX;
      const ry = w.py(35.5) + p.armRY - p.armLift * 0.8;
      this.set("armLx", "cx", String(r2(lx)), "armL");
      this.set("armLy", "cy", String(r2(ly)), "armL");
      this.set("armRx", "cx", String(r2(rx)), "armR");
      this.set("armRy", "cy", String(r2(ry)), "armR");
    }

    const d = this.detail;
    if (d === "antenne") {
      const bx = w.px(32, geo.top + 1.5);
      const by = w.py(geo.top + 1.5);
      // Une tige souple ne s'allonge pas : le retard la plie et ne la tire qu'à peine.
      const dx = p.antennaX;
      const dy = -7.1 + p.antennaY;
      const len = Math.hypot(dx, dy) || 1;
      const reach = 7.1 * (1 + 0.14 * Math.tanh((len - 7.1) / 4));
      const tx = bx + (dx / len) * reach;
      const ty = by + (dy / len) * reach;
      // Son milieu reste sur l'axe du corps, le bout est en retard.
      const qx = bx + (tx - bx) * 0.15;
      const qy = by + (ty - by) * 0.62;
      this.set("antS", "d", `M${r2(bx)} ${r2(by)}Q${r2(qx)} ${r2(qy)} ${r2(tx)} ${r2(ty)}`);
      this.set("antBx", "cx", String(r2(tx)), "antB");
      this.set("antBy", "cy", String(r2(ty)), "antB");
    } else if (d === "lunettes") {
      const bx = w.px(32, 31.2 + fy) - 32;
      const by = w.py(31.2 + fy) - 36;
      const x = rotX(bx, by) + p.turn * 4.2 + p.glassX * 0.5 + p.gazeX * 0.1;
      const y = rotY(bx, by) + p.pitch * 3 + p.glassY * 0.5;
      this.set(
        "glasses",
        "transform",
        `translate(${r2(x)} ${r2(y)}) rotate(${r2(p.tilt + p.glassX * 1.5)}) scale(${r2(Math.sqrt(w.sx * w.kx) * (1 - Math.abs(p.turn) * 0.05))} ${r2(Math.sqrt(w.sy))}) translate(-32 -31.2)`,
      );
    } else if (d === "sourcils") {
      for (const [key, rx0, ry0, sign] of [
        ["browL", 25, 23.8, -1],
        ["browR", 39, 23.8, 1],
      ] as const) {
        const bx = w.px(rx0, ry0 + fy) - 32;
        const by = w.py(ry0 + fy) - 36;
        const x = rotX(bx, by) + p.turn * 4.2 + p.gazeX * 0.35;
        const y = rotY(bx, by) + p.pitch * 3 + p.gazeY * 0.3 - p.brow * 1.5 - (p.browTilt * sign > 0 ? 1.6 * Math.abs(p.browTilt) : 0);
        // Un sourcil qui descend s'incline vers le nez.
        const tilted = p.tilt + sign * Math.min(0, p.brow) * 9;
        this.set(key, "transform", `translate(${r2(x)} ${r2(y)}) rotate(${r2(tilted)}) translate(${-rx0} ${-ry0})`);
      }
    } else if (d === "joues") {
      for (const [key, rx0] of [
        ["cheekL", 17.5],
        ["cheekR", 46.5],
      ] as const) {
        const bx = w.px(rx0, 40.5 + fy) - 32;
        const by = w.py(40.5 + fy) - 36;
        this.set(`${key}x`, "cx", String(r2(rotX(bx, by) + p.turn * 3)), key);
        this.set(`${key}y`, "cy", String(r2(rotY(bx, by) + p.pitch * 2.6)), key);
        this.set(`${key}o`, "opacity", String(r2(0.5 + 0.35 * p.cheek)), key);
      }
    }
  }
}

function still(o: FaceOptions) {
  return o.still;
}
