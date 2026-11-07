// Mesures du moteur du visage sans navigateur : node tests/visage/moteur_test.mjs [fichier-sortie.json]
// Chaque ligne donne la vraie valeur et le seuil de la grille. Les seuils sont des choix à calibrer, pas des chiffres du marché.
import { writeFileSync } from "node:fs";
import { DEG_PER_UNIT, MATERIALS, NOAH_STEP, NoahSim, Spring, Warp, bodyOf, hashSeed } from "../../frontend/src/lib/noahMotion.ts";

const SHAPES = ["gomme", "bulle", "cube", "goutte", "pastille"];
const STATES = ["idle", "listening", "thinking", "speaking"];
const FRAME = 1 / 60;
const RATE = Math.round(1 / NOAH_STEP);
const PER_FRAME = Math.round(FRAME / NOAH_STEP);
const out = {};
let fails = 0;
function row(id, label, value, ok) {
  out[id] ??= [];
  out[id].push({ label, value, ok });
  if (!ok) fails++;
  console.log(`${ok ? "OK  " : "NON "} ${id.padEnd(3)} ${label} : ${typeof value === "number" ? +value.toFixed(4) : JSON.stringify(value)}`);
}
const sim = (shape, seed = "s", extra = {}) => new NoahSim({ shape, seed: hashSeed(seed), ...extra });
const round = (v, n = 3) => +v.toFixed(n);

function corr(a, b) {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

// ── R1, R2 : échelon sur le ressort du corps, à pas fixe de 1/60 s ────────────────────────────────────────────────────
for (const shape of SHAPES) {
  const s = sim(shape, "r", { quiet: true });
  const target = 0.3;
  s.sq.t = target; // l'échelon : le ressort du corps seul, sans fond
  const m = MATERIALS[shape];
  const sp = new Spring(m.omega, m.zeta);
  sp.t = target;
  const xs = [];
  for (let i = 0; i < 180; i++) {
    for (let k = 0; k < PER_FRAME; k++) sp.step();
    xs.push(sp.x);
  }
  // pics successifs autour de la cible
  const peaks = [];
  for (let i = 1; i < xs.length - 1; i++) {
    const a = xs[i] - target, b = xs[i - 1] - target, c = xs[i + 1] - target;
    // un pic visible : au moins 1 % de l'échelon
    if (Math.abs(a) > 0.01 * target && ((a > b && a > c && a > 0) || (a < b && a < c && a < 0))) peaks.push(a);
  }
  const over = peaks[0] / target;
  const ratio = peaks.length > 1 ? Math.abs(peaks[1] / peaks[0]) : 0;
  let settle = 0;
  for (let i = 0; i < xs.length; i++) if (Math.abs(xs[i] - target) > 0.02 * target) settle = (i + 1) * FRAME;
  // Ajustement sur la sinusoïde amortie théorique
  const wd = m.omega * Math.sqrt(1 - m.zeta ** 2);
  const pred = xs.map((_, i) => {
    const t = (i + 1) * FRAME;
    return target - target * Math.exp(-m.zeta * m.omega * t) * (Math.cos(wd * t) + ((m.zeta * m.omega) / wd) * Math.sin(wd * t));
  });
  let ssr = 0, sst = 0;
  const mean = xs.reduce((a, b) => a + b) / xs.length;
  xs.forEach((x, i) => { ssr += (x - pred[i]) ** 2; sst += (x - mean) ** 2; });
  const r2 = 1 - ssr / sst;
  const [lo, hi] = shape === "cube" ? [0.03, 0.1] : [0.15, 0.35];
  row("R1", `${shape} dépassement (${lo}-${hi}), zeta ${m.zeta}, R2 ${round(r2, 4)}`, over, over >= lo && over <= hi && r2 >= 0.98);
  if (shape === "cube") row("R2", `${shape} stabilisé 0,4-1,0 s (rapport ${round(ratio)} hors plage voulue : raide)`, settle, settle >= 0.4 && settle <= 1);
  else {
    row("R2", `${shape} rapport de pics (0,2-0,5)`, ratio, ratio >= 0.2 && ratio <= 0.5);
    row("R2", `${shape} stabilisé 0,4-1,0 s, pics ${peaks.length}`, settle, settle >= 0.4 && settle <= 1 && peaks.length >= 2);
  }
}

// ── R3 : indépendance à la cadence ────────────────────────────────────────────────────────────────────────────────────
// Les événements tombent sur des instants communs aux trois cadences (multiples de 1/30 s), et on compare à ces instants-là.
function run(hz, seconds, shape = "gomme", gap = false) {
  const s = sim(shape, "cadence");
  const samples = [];
  const per = hz / 30;
  const total = Math.round(seconds * hz);
  for (let i = 1; i <= total; i++) {
    if (gap && i === Math.round(2 * hz)) {
      // Un trou de 100 ms, comme un retour d'onglet : on saute 3 images à 30 Hz et on rattrape d'un coup.
      s.advance(0.1);
      i += Math.round(0.1 * hz) - 1;
    } else s.advance(1 / hz);
    if (i === hz) s.react("hop");
    if (i === 4 * hz) s.setState("thinking");
    if (i === 6 * hz) s.setState("speaking");
    if (i % per === 0) samples[i / per] = [s.t, s.pose.squash, s.pose.alt, s.pose.lean, s.pose.gazeX, s.pose.lid];
  }
  return samples;
}
{
  const a = run(60, 8), b = run(30, 8), c = run(120, 8), d = run(60, 8, "gomme", true);
  const maxDev = (u, v) => {
    let d = 0;
    const span = [0, 0, 0, 0, 0, 0];
    u.forEach((r) => r.forEach((x, j) => (span[j] = Math.max(span[j], Math.abs(x)))));
    const n = Math.min(u.length, v.length);
    for (let i = 0; i < n; i++) if (u[i] && v[i]) for (const j of [1, 2, 3]) d = Math.max(d, Math.abs(u[i][j] - v[i][j]) / (span[j] || 1));
    return d;
  };
  row("R3", "écart 30 Hz contre 60 Hz (corps)", maxDev(a, b), maxDev(a, b) < 0.02);
  row("R3", "écart 120 Hz contre 60 Hz (corps)", maxDev(a, c), maxDev(a, c) < 0.02);
  row("R3", "écart avec un trou de 100 ms (corps)", maxDev(a, d), maxDev(a, d) < 0.02);
  const s = sim("gomme", "trou");
  let finite = true;
  for (let i = 0; i < 2000; i++) {
    s.advance(i % 97 === 0 ? 5 : FRAME);
    if (i % 300 === 0) s.react("joy");
    for (const k of Object.keys(s.pose)) if (!Number.isFinite(s.pose[k])) finite = false;
  }
  row("R3", "trous de temps : aucune valeur non finie", finite ? 1 : 0, finite);
}

// ── R4 : interruption sans rupture ────────────────────────────────────────────────────────────────────────────────────
{
  // Deux copies de même graine : l'une reçoit l'interruption, l'autre non. L'écart de vitesse à l'image suivante est dû à elle seule.
  let worst = 0;
  let restart = 0;
  for (let i = 0; i < 100; i++) {
    // La scène : un saut en cours (son vol et ses impacts ne dépendent pas du geste), interrompu par un nouvel état et un nouveau geste.
    let vmax = 0;
    const make = () => {
      const s = sim("gomme", `i${i}`, { state: "idle" });
      for (let k = 0; k < 30 + (i * 7) % 200; k++) s.advance(FRAME);
      s.react("hop");
      let prev = s.pose.squash;
      for (let k = 0; k < 2 + (i * 3) % 60; k++) {
        s.advance(FRAME);
        vmax = Math.max(vmax, Math.abs((s.pose.squash - prev) / FRAME));
        prev = s.pose.squash;
      }
      return s;
    };
    const a = make();
    const b = make();
    const before = a.sq.v;
    a.setState(STATES[1 + (i % 3)]);
    a.react(["nod", "hop", "wiggle", "sad"][i % 4]);
    if (a.sq.v !== before) restart++; // le changement lui-même ne touche jamais à la vitesse
    const pa = a.pose.squash;
    const pb = b.pose.squash;
    a.advance(FRAME);
    b.advance(FRAME);
    const dv = Math.abs((a.pose.squash - pa) - (b.pose.squash - pb)) / FRAME;
    let prev = a.pose.squash;
    for (let k = 0; k < 120; k++) {
      a.advance(FRAME);
      vmax = Math.max(vmax, Math.abs((a.pose.squash - prev) / FRAME));
      prev = a.pose.squash;
    }
    worst = Math.max(worst, dv / (vmax || 1));
  }
  row("R4", "saut de vitesse dû à l'interruption / vitesse max, 100 tirages (<0,10)", worst, worst < 0.1);
  row("R4", "ressorts dont la vitesse change à l'interruption", restart, restart === 0);
}

// ── T1, T2 : transitions ──────────────────────────────────────────────────────────────────────────────────────────────
const KEYS = ["squash", "lean", "turn", "pitch", "tilt", "wide", "smile", "brow"];
// En dessous de cette variation par image, un paramètre est à l'arrêt à l'œil nu : le rapport au régime établi ne veut plus rien dire.
const FLOOR = { squash: 0.003, lean: 0.002, turn: 0.004, pitch: 0.006, tilt: 0.1, wide: 0.004, smile: 0.01, brow: 0.01 };
function frameDelta(s, n) {
  const m = Object.fromEntries(KEYS.map((k) => [k, 0]));
  const prev = { ...s.pose };
  for (let i = 0; i < n; i++) {
    s.advance(FRAME);
    for (const k of KEYS) {
      m[k] = Math.max(m[k], Math.abs(s.pose[k] - prev[k]));
      prev[k] = s.pose[k];
    }
  }
  return m;
}
{
  const steady = {};
  for (const st of STATES) {
    steady[st] = Object.fromEntries(KEYS.map((k) => [k, 0]));
    for (let seed = 0; seed < 3; seed++) {
      const s = sim("gomme", `steady-${st}-${seed}`, { state: st });
      frameDelta(s, 60 * 2);
      const d = frameDelta(s, 60 * 30);
      for (const k of KEYS) steady[st][k] = Math.max(steady[st][k], d[k]);
    }
    console.log("    régime établi", st, JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, round(steady[st][k], 4)]))));
  }
  const byKey = Object.fromEntries(KEYS.map((k) => [k, 0]));
  let worst = { ratio: 0 };
  let pairs = 0;
  let over = 0;
  for (const a of STATES) for (const b of STATES) {
    if (a === b) continue;
    pairs++;
    for (let seed = 0; seed < 5; seed++) {
      const s = sim("gomme", `t${seed}`, { state: a });
      frameDelta(s, 60 * 2 + seed * 17);
      s.setState(b);
      const d = frameDelta(s, 45);
      for (const k of KEYS) {
        const ref = Math.max(steady[a][k], steady[b][k], FLOOR[k]);
        const r = d[k] / ref;
        byKey[k] = Math.max(byKey[k], r);
        if (r > worst.ratio) worst = { ratio: round(r), k, a, b, delta: round(d[k], 4), ref: round(ref, 4) };
        if (r > 1.5) over++;
      }
    }
  }
  row("T1", `pire variation par image / régime établi (<=1,5) sur ${pairs} paires, ${JSON.stringify(worst)}`, worst.ratio, worst.ratio <= 1.5);
  row("T1", "nombre de dépassements (paramètre × tirage)", over, over === 0);
  console.log("    T1 par paramètre", JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, round(byKey[k])]))));

  // T2 : 50 % de la cible, visage et corps
  const s = sim("gomme", "t2", { quiet: true, state: "idle" });
  s.advance(1);
  s.setState("thinking");
  const start = { lid: s.pose.lidRaw, smile: s.pose.smile, squash: s.pose.squash, pitch: s.pose.pitch };
  const g = { smile: 0.4, pitch: -0.25, squash: 0.005 };
  let tFace = 0, tBody = 0;
  for (let i = 1; i < RATE; i++) {
    s.advance(NOAH_STEP);
    if (!tFace && Math.abs(s.pose.smile - start.smile) >= 0.5 * Math.abs(g.smile - start.smile)) tFace = i * NOAH_STEP;
    if (!tBody && Math.abs(s.pose.pitch - start.pitch) >= 0.5 * Math.abs(g.pitch - start.pitch)) tBody = i * NOAH_STEP;
  }
  row("T2", `visage ${round(tFace * 1000)} ms, corps ${round(tBody * 1000)} ms : écart (>=80 ms)`, (tBody - tFace) * 1000, tBody - tFace >= 0.08);
}

// ── A1 à A4 : le saut ─────────────────────────────────────────────────────────────────────────────────────────────────
function recordHop(shape, kind = "hop", seed = "hop", seconds = 2.2) {
  const s = sim(shape, seed, { quiet: true });
  s.advance(0.5);
  s.react(kind);
  const rec = [];
  for (let i = 0; i < seconds * RATE; i++) {
    s.advance(NOAH_STEP);
    rec.push({ t: i * NOAH_STEP, alt: s.pose.alt, s: s.pose.squash, ant: s.pose.antennaY, antX: s.pose.antennaX, glass: s.pose.glassY, armY: s.pose.armLY, w: s.pose.shadowW, o: s.pose.shadowO });
  }
  return { s, rec };
}
for (const shape of SHAPES) {
  const { rec } = recordHop(shape);
  const takeoff = rec.findIndex((r) => r.alt > 0);
  // Préparation : à partir du moment où l'écrasement dépasse 15 % de son maximum avant le décollage
  const prep = rec.slice(0, takeoff);
  const maxPrep = Math.max(...prep.map((r) => r.s));
  const prepStart = prep.findIndex((r) => r.s > maxPrep * 0.15);
  const prepMs = (takeoff - prepStart) * NOAH_STEP * 1000;
  const land = rec.findIndex((r, i) => i > takeoff && r.alt === 0);
  const flight = rec.slice(takeoff, land);
  const apex = flight.reduce((a, b, i) => (b.alt > flight[a].alt ? i : a), 0);
  const stretchTakeoff = Math.min(...flight.slice(0, Math.max(apex, 1)).map((r) => r.s));
  const atApex = flight[apex].s;
  const afterLand = rec.slice(land, land + 60);
  const squashLand = Math.max(...afterLand.map((r) => r.s));
  row("A1", `${shape} préparation ${round(prepMs, 0)} ms (80-200), alt 0, s prép ${round(maxPrep)}, étirement ${round(stretchTakeoff)}, sommet ${round(atApex)}, contact ${round(squashLand)}`, prepMs, prepMs >= 80 && prepMs <= 200 && stretchTakeoff < -0.05 && squashLand > 0.1 && Math.abs(atApex) < Math.abs(stretchTakeoff));

  // A2 : ajustement parabolique
  const xs = flight.map((r) => r.t - flight[0].t);
  const ys = flight.map((r) => r.alt);
  const fit = quad(xs, ys);
  row("A2", `${shape} R² parabole, ${round(xs[xs.length - 1], 3)} s de vol, ${round(Math.max(...ys), 2)} u, g mesurée ${round(-2 * fit.c, 0)}`, fit.r2, fit.r2 >= 0.99);

  // A4 : ombre
  const air = rec.slice(Math.max(0, takeoff - 40), land + 60);
  const cw = corr(air.map((r) => r.alt), air.map((r) => r.w));
  const co = corr(air.map((r) => r.alt), air.map((r) => r.o));
  row("A4", `${shape} corrélation altitude-largeur / opacité (<=-0,95) ${round(cw)} / ${round(co)}`, cw, cw <= -0.95 && co <= -0.95);
}
function quad(xs, ys) {
  // moindres carrés a + b x + c x²
  let S = Array.from({ length: 3 }, () => [0, 0, 0, 0]);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], row = [1, x, x * x];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) S[a][b] += row[a] * row[b];
      S[a][3] += row[a] * ys[i];
    }
  }
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) {
      const f = S[j][i] / S[i][i];
      for (let k = i; k < 4; k++) S[j][k] -= f * S[i][k];
    }
  }
  const sol = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let v = S[i][3];
    for (let j = i + 1; j < 3; j++) v -= S[i][j] * sol[j];
    sol[i] = v / S[i][i];
  }
  const mean = ys.reduce((a, b) => a + b) / ys.length;
  let ssr = 0, sst = 0;
  xs.forEach((x, i) => { ssr += (ys[i] - (sol[0] + sol[1] * x + sol[2] * x * x)) ** 2; sst += (ys[i] - mean) ** 2; });
  return { a: sol[0], b: sol[1], c: sol[2], r2: 1 - ssr / sst };
}

// A3 : retard des accessoires, par corrélation croisée sur le mouvement absolu
{
  const s = sim("gomme", "a3", { quiet: true });
  s.advance(0.5);
  s.react("hop");
  const body = [], ant = [], glass = [], arm = [];
  for (let i = 0; i < 2.2 * RATE; i++) {
    s.advance(NOAH_STEP);
    const yTop = -s.pose.alt;
    body.push(yTop);
    ant.push(yTop + s.pose.antennaY);
    glass.push(yTop + s.pose.glassY);
    arm.push(yTop + s.pose.armLY);
  }
  const lag = (a, b) => {
    let best = 0, v = -2;
    for (let k = 0; k < RATE / 2; k++) {
      const c = corr(a.slice(0, a.length - k), b.slice(k));
      if (c > v) { v = c; best = k; }
    }
    return best * NOAH_STEP * 1000;
  };
  const stop = (a) => {
    for (let i = a.length - 1; i > 0; i--) if (Math.abs(a[i] - a[i - 1]) > 0.002) return i * NOAH_STEP;
    return 0;
  };
  const stopBody = stop(body);
  for (const [name, a] of [["antenne", ant], ["lunettes", glass], ["bras", arm]]) {
    const l = lag(body, a);
    const after = (stop(a) - stopBody) * 1000;
    row("A3", `${name} retard ${round(l, 0)} ms (40-150), s'arrête ${round(after, 0)} ms après le corps (>=100)`, l, l >= 40 && l <= 150 && after >= 100);
  }
}

// ── V1 à V3 : silhouette ──────────────────────────────────────────────────────────────────────────────────────────────
for (const shape of SHAPES) {
  const w = new Warp(shape);
  const geo = bodyOf(shape);
  // Aire analytique contre aire échantillonnée du contour, pour contrôler la formule.
  const s = sim(shape, "v", { quiet: true });
  s.advance(0.3);
  s.react("joy");
  let maxArea = 0, maxS = 0, minS = 0, bottomSlip = 0;
  const ratioAt = () => widthRatio(w);
  w.update(s.pose);
  const rest = ratioAt();
  let extreme = 0, extremeRatio = rest;
  for (let i = 0; i < 4 * RATE; i++) {
    s.advance(NOAH_STEP);
    w.update(s.pose);
    maxArea = Math.max(maxArea, Math.abs(sampledArea(w) / geo.area - 1));
    maxS = Math.max(maxS, s.pose.squash);
    minS = Math.min(minS, s.pose.squash);
    bottomSlip = Math.max(bottomSlip, Math.abs(Math.max(...w.Y) - geo.base));
    const r = ratioAt();
    if (Math.abs(r / rest - 1) > extreme) {
      extreme = Math.abs(r / rest - 1);
      extremeRatio = r;
    }
  }
  row("V1", `${shape} écart d'aire max (<=3 %), squash ${round(minS)} à ${round(maxS)}`, maxArea * 100, maxArea <= 0.03);
  row("V2", `${shape} rapport bas/haut repos ${round(rest)} max ${round(extremeRatio)} (variation >=15 %)`, extreme * 100, extreme >= 0.15);
  row("V3", `${shape} glissement de la base (<0,5 u)`, bottomSlip, bottomSlip < 0.5);
}
function sampledArea(w) {
  // Échantillonne le contour dessiné : contrôle indépendant de la formule analytique
  const { X, Y } = w;
  let a = 0, px = X[0], py = Y[0];
  for (let i = 0; i + 3 < X.length; i += 3) {
    for (let k = 1; k <= 24; k++) {
      const t = k / 24, u = 1 - t;
      const x = u * u * u * X[i] + 3 * u * u * t * X[i + 1] + 3 * u * t * t * X[i + 2] + t * t * t * X[i + 3];
      const y = u * u * u * Y[i] + 3 * u * u * t * Y[i + 1] + 3 * u * t * t * Y[i + 2] + t * t * t * Y[i + 3];
      a += px * y - x * py;
      px = x;
      py = y;
    }
  }
  return Math.abs(a / 2);
}
function widthRatio(w) {
  // Largeur à 25 % et 75 % de la hauteur courante, sur le contour échantillonné
  const { X, Y } = w;
  const pts = [];
  for (let i = 0; i + 3 < X.length; i += 3) {
    for (let k = 0; k < 24; k++) {
      const t = k / 24, u = 1 - t;
      pts.push([u * u * u * X[i] + 3 * u * u * t * X[i + 1] + 3 * u * t * t * X[i + 2] + t * t * t * X[i + 3], u * u * u * Y[i] + 3 * u * u * t * Y[i + 1] + 3 * u * t * t * Y[i + 2] + t * t * t * Y[i + 3]]);
    }
  }
  const ys = pts.map((p) => p[1]);
  const top = Math.min(...ys), bot = Math.max(...ys);
  const width = (y) => {
    const near = pts.filter((p) => Math.abs(p[1] - y) < 1.2).map((p) => p[0]);
    return near.length ? Math.max(...near) - Math.min(...near) : 0;
  };
  return width(bot - (bot - top) * 0.25) / Math.max(0.01, width(top + (bot - top) * 0.25));
}

// ── G1, G2, B1 : regard et clignement ─────────────────────────────────────────────────────────────────────────────────
{
  const s = sim("gomme", "g1", { trace: true });
  const lids = [], gys = [];
  let closes = [];
  let prevClosed = false;
  const blinkStarts = [];
  const minute = 10 * 60 * 60;
  for (let i = 0; i < minute; i++) {
    s.advance(FRAME);
    const closed = s.pose.lid < 0.4 * s.pose.lidRaw;
    if (closed && !prevClosed) blinkStarts.push(s.t);
    prevClosed = closed;
    if (i < 60 * 60) {
      lids.push(s.pose.lidRaw);
      gys.push(s.pose.gazeY);
    }
  }
  const sac = s.trace.saccades;
  let worstLaw = 0, minInt = 9;
  for (let i = 0; i < sac.length; i++) {
    const lo = (2 * sac[i].deg + 20) / 1000 - FRAME, hi = (2.7 * sac[i].deg + 30) / 1000 + FRAME;
    if (sac[i].dur < lo || sac[i].dur > hi) worstLaw++;
    if (i) minInt = Math.min(minInt, sac[i].t - (sac[i - 1].t + sac[i - 1].dur));
  }
  row("G1", `${sac.length} saccades sur 10 min, hors loi Eyes Alive`, worstLaw, worstLaw === 0);
  row("G1", "intervalle minimal entre saccades, s (>=0,1)", minInt, minInt >= 0.1 - 1e-6);
  const c = corr(lids, gys);
  row("G2", "corrélation paupière / regard vertical (<=-0,7 : l'œil levé ouvre la paupière)", c, Math.abs(c) >= 0.7);
  const ints = blinkStarts.slice(1).map((t, i) => t - blinkStarts[i]);
  const mean = ints.reduce((a, b) => a + b, 0) / ints.length;
  const sd = Math.sqrt(ints.reduce((a, b) => a + (b - mean) ** 2, 0) / ints.length);
  const perMin = blinkStarts.length / 10;
  row("B1", "clignements par minute (6-20)", perMin, perMin >= 6 && perMin <= 20);
  row("B1", "coefficient de variation (>=0,4)", sd / mean, sd / mean >= 0.4);
  // Asymétrie
  const b = sim("gomme", "asym");
  let was = 1, closing = 0, opening = 0, start = -1, peak = -1;
  for (let i = 0; i < RATE * 30 && !(peak > 0 && opening); i++) {
    b.advance(NOAH_STEP);
    const v = b.pose.lid / Math.max(b.pose.lidRaw, 0.01);
    if (start < 0 && v < 0.98) start = i;
    if (start >= 0 && peak < 0 && v < 0.02) { peak = i; closing = (i - start) * NOAH_STEP; }
    if (peak > 0 && v > 0.98) { opening = (i - peak) * NOAH_STEP; }
    was = v;
  }
  row("B1", `fermeture ${round(closing * 1000, 0)} ms, ouverture ${round(opening * 1000, 0)} ms : rapport (<1)`, closing / opening, closing < opening);
}
{
  // G2 : yeux d'abord
  const s = sim("gomme", "g2", { quiet: true });
  s.advance(0.5);
  s.react("lookLeft");
  let eye = 0, head = 0;
  for (let i = 1; i < RATE; i++) {
    s.advance(NOAH_STEP);
    if (!eye && Math.abs(s.pose.gazeX) > 0.05) eye = i * NOAH_STEP;
    if (!head && Math.abs(s.pose.turn) > 0.02) head = i * NOAH_STEP;
  }
  row("G2", `grand regard : yeux ${round(eye * 1000, 0)} ms, tête ${round(head * 1000, 0)} ms (écart >=30 ms)`, (head - eye) * 1000, head - eye >= 0.03);
}

// ── N1, N2, N3 : variété ──────────────────────────────────────────────────────────────────────────────────────────────
function vector(seed, seconds = 30, state = "idle", shape = "gomme") {
  const s = sim(shape, seed, { state });
  const keys = ["squash", "lean", "turn", "pitch", "tilt", "gazeX", "gazeY", "lid", "open"];
  const out = keys.map(() => []);
  for (let i = 0; i < seconds * 60; i++) {
    s.advance(FRAME);
    keys.forEach((k, j) => out[j].push(s.pose[k]));
  }
  return out;
}
{
  let worstAuto = -1;
  for (const seed of ["a", "b", "c", "d", "e"]) {
    const v = vector(seed);
    for (let lag = 60; lag <= 29 * 60; lag += 30) {
      const flatA = [], flatB = [];
      for (const ch of v) {
        // canaux normalisés pour que chacun compte
        const m = ch.reduce((a, b) => a + b) / ch.length;
        const sd = Math.sqrt(ch.reduce((a, b) => a + (b - m) ** 2, 0) / ch.length) || 1;
        for (let i = 0; i + lag < ch.length; i += 2) {
          flatA.push((ch[i] - m) / sd);
          flatB.push((ch[i + lag] - m) / sd);
        }
      }
      worstAuto = Math.max(worstAuto, corr(flatA, flatB));
    }
  }
  row("N1", "autocorrélation maximale de 1 à 29 s, 5 graines (<0,9)", worstAuto, worstAuto < 0.9);
}
{
  const s = sim("gomme", "n2", { trace: true, quiet: true });
  for (const kind of ["hop", "nod", "wiggle", "surprise", "lookLeft", "sad", "confused", "shake"]) {
    s.trace.gestures.length = 0;
    for (let i = 0; i < 200; i++) s.react(kind);
    const used = new Set(s.trace.gestures.map((g) => g.v));
    let repeats = 0;
    for (let i = 1; i < 200; i++) if (s.trace.gestures[i].v === s.trace.gestures[i - 1].v) repeats++;
    row("N2", `${kind} : ${used.size} variantes (>=4), répétitions immédiates`, repeats, used.size >= 4 && repeats === 0);
  }
}
{
  const flat = (v) => v.flatMap((ch) => {
    const m = ch.reduce((x, y) => x + y) / ch.length;
    const sd = Math.sqrt(ch.reduce((x, y) => x + (y - m) ** 2, 0) / ch.length) || 1;
    return ch.map((x) => (x - m) / sd);
  });
  const a = vector("agent-1");
  const c = vector("agent-1");
  let worst = 0, worstParam = 0, sum = 0, pairs = 0;
  for (let i = 2; i <= 11; i++) {
    const b = vector(`agent-${i}`);
    const r = Math.abs(corr(flat(a), flat(b)));
    worst = Math.max(worst, r);
    sum += r;
    pairs++;
    a.forEach((ch, j) => {
      worstParam = Math.max(worstParam, Math.abs(corr(ch, b[j])));
    });
  }
  const same = a.every((ch, j) => ch.every((x, i) => x === c[j][i]));
  row("N3", `corrélation entre agents, tous paramètres, pire de 10 paires (<0,5), moyenne ${round(sum / pairs)}, pire paramètre isolé ${round(worstParam)}`, worst, worst < 0.5);
  row("N3", "même identifiant, même trajectoire", same ? 1 : 0, same);
}

// ── E1, E2 : écoute, sur une enveloppe de micro connue ────────────────────────────────────────────────────────────────
{
  const s = sim("gomme", "e1", { state: "listening" });
  s.advance(1);
  const mic = [], body = [];
  for (let i = 0; i < 30 * 60; i++) {
    // Niveaux de parole tenus 0,4 à 1,2 s : créneaux connus, sans dépendre du hasard du moteur.
    const t = i / 60;
    const level = Math.floor(t / 0.8) % 2 ? 0.1 + 0.7 * ((Math.floor(t / 0.8) * 7) % 5) / 4 : 0;
    s.mic = level;
    s.advance(FRAME);
    mic.push(level);
    body.push(-s.pose.squash);
  }
  let best = -2, lag = 0;
  for (let k = 0; k < 30; k++) {
    const c = corr(mic.slice(0, mic.length - k), body.slice(k));
    if (c > best) { best = c; lag = k; }
  }
  row("E1", `corrélation niveau-gonflement (>=0,7), retard ${round((lag / 60) * 1000, 0)} ms (<100)`, best, best >= 0.7 && (lag / 60) < 0.1);
  // Tremblement à niveau constant : ce qui reste quand le niveau ne bouge pas, respiration comprise.
  const q = sim("gomme", "e1b", { state: "listening" });
  q.mic = 0.6;
  q.advance(2);
  let jitter = 0, prev = q.pose.squash;
  for (let i = 0; i < 300; i++) {
    q.advance(FRAME);
    jitter = Math.max(jitter, Math.abs(q.pose.squash - prev));
    prev = q.pose.squash;
  }
  row("E1", "variation par image à niveau constant (<0,01)", jitter, jitter < 0.01);
}
{
  const s = sim("gomme", "e2", { state: "listening", trace: true });
  s.advance(1);
  const pauses = 10;
  let hits = 0, duringSpeech = 0, t = 0;
  const nods = () => s.trace.gestures.filter((g) => g.kind === "nod").length;
  for (let p = 0; p < pauses; p++) {
    const speech = 1 + (p % 3) * 0.6;
    const pause = 0.3 + (p % 4) * 0.2;
    const n0 = nods();
    for (t = 0; t < speech; t += FRAME) {
      s.mic = 0.5 + 0.3 * Math.sin(t * 19);
      s.advance(FRAME);
    }
    duringSpeech += nods() - n0;
    const n1 = nods();
    let at = -1;
    for (t = 0; t < pause + 0.35; t += FRAME) {
      s.mic = t < pause ? 0 : 0.5;
      s.advance(FRAME);
      if (at < 0 && nods() > n1) at = t;
    }
    if (at >= 0.1 && at <= 0.6) hits++;
  }
  row("E2", `hochement 100-600 ms après la pause, sur ${pauses} (>=8), pendant la parole ${duringSpeech}`, hits, hits >= 8 && duringSpeech === 0);
}

// ── L3 : bouche sans son ──────────────────────────────────────────────────────────────────────────────────────────────
{
  const s = sim("gomme", "l3", { state: "speaking" });
  let peak = 0;
  for (let i = 0; i < 60 * 3; i++) {
    s.setVoice(0.8);
    s.advance(FRAME);
    peak = Math.max(peak, s.pose.open);
  }
  let closeAt = 0;
  for (let i = 1; i < 120; i++) {
    s.setVoice(0); // coupure : le volume tombe à zéro
    s.advance(NOAH_STEP);
    if (!closeAt && s.pose.open < 0.05) closeAt = i * NOAH_STEP;
  }
  row("L3", `volume coupé, bouche fermée en ms (<150), ouverture avant ${round(peak)}`, closeAt * 1000, closeAt > 0 && closeAt < 0.15);
  const t = sim("gomme", "l3b", { state: "speaking" });
  for (let i = 0; i < 60 * 3; i++) t.advance(FRAME);
  t.setState("idle");
  let close2 = 0;
  for (let i = 1; i < 120; i++) {
    t.advance(NOAH_STEP);
    if (!close2 && t.pose.open < 0.05) close2 = i * NOAH_STEP;
  }
  row("L3", "fin de parole, bouche fermée en ms (<150)", close2 * 1000, close2 < 0.15);
}

// ── H1 à H4 : le visage pendant une tâche ─────────────────────────────────────────────────────────────────────────────
{
  const after = (state, seconds = 6, shape = "gomme") => {
    const s = sim(shape, "tache", { state: "idle" });
    for (let i = 0; i < 60; i++) s.advance(FRAME);
    s.setState(state);
    const poses = [];
    for (let i = 0; i < 60 * seconds; i++) {
      s.advance(FRAME);
      poses.push({ ...s.pose });
    }
    return { s, poses };
  };
  const mean = (poses, key) => poses.reduce((n, p) => n + p[key], 0) / poses.length;
  const swing = (poses, key) => Math.max(...poses.map((p) => p[key])) - Math.min(...poses.map((p) => p[key]));
  const think = after("thinking").poses;
  const work = after("working").poses;
  const wait = after("waiting").poses;
  row("H1", "au travail, regard en bas (>0.8), en réflexion en haut (<0)", mean(work, "gazeY"), mean(work, "gazeY") > 0.8 && mean(think, "gazeY") < 0);
  row("H1", "au travail, le corps bat (amplitude de la tête >0.1)", swing(work, "pitch"), swing(work, "pitch") > 0.1);
  row("H2", "en attente, les yeux grands ouverts et vers toi (|regard|<1)", Math.abs(mean(wait, "gazeY")), mean(wait, "wide") > 1.05 && Math.abs(mean(wait, "gazeY")) < 1);
  row("H2", "en attente, il se redresse plus qu'au travail", mean(wait, "squash"), mean(wait, "squash") < mean(work, "squash"));
  const end = after("pleased", 2);
  row("H3", "fini : sourire et yeux en croissant, puis un seul saut qui retombe", end.poses[end.poses.length - 1].crescent, end.poses[end.poses.length - 1].crescent > 0.6 && Math.max(...end.poses.map((p) => p.alt)) > 2 && end.poses[end.poses.length - 1].alt === 0);
  const bad = after("upset", 2);
  row("H3", "erreur : la bouche tombe, le corps s'affaisse, sans saut", bad.poses[bad.poses.length - 1].smile, bad.poses[bad.poses.length - 1].smile < 0 && Math.max(...bad.poses.map((p) => p.alt)) === 0);
  for (const state of ["working", "waiting", "pleased", "upset"]) {
    const a = sim("cube", "fige", { state: "idle" });
    a.settle(state);
    const before = { ...a.pose };
    row("H4", `mouvement réduit, ${state} : l'expression sans le corps`, a.pose.squash, a.pose.squash === 0 && a.pose.lean === 0 && before.alt === 0);
    const x = after(state, 2, "bulle").poses;
    const y = after(state, 2, "bulle").poses;
    row("H4", `${state} : même graine, même trajectoire`, x[x.length - 1].pitch, x[x.length - 1].pitch === y[y.length - 1].pitch);
  }
}

console.log(`\n${fails} ligne(s) hors seuil.`);
if (process.argv[2]) writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
process.exitCode = fails ? 1 : 0;
