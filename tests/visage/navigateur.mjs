// Mesures et captures du visage dans un vrai Chrome. Vite doit tourner : cd frontend && npx vite --port 5199 --strictPort
// NOAH_PLAYWRIGHT=<chemin de playwright> node tests/visage/navigateur.mjs <dossier-de-sortie> [captures|mesures|tout]
// Sort des planches d'images successives (une par état et par forme), une vidéo courte et mesures.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.NOAH_PLAYWRIGHT);
const BASE = process.env.NOAH_BASE ?? "http://localhost:5199";
const OUT = process.argv[2];
const WHAT = process.argv[3] ?? "tout";
if (!OUT) throw new Error("dossier de sortie manquant");
mkdirSync(OUT, { recursive: true });

const SHAPES = ["gomme", "bulle", "cube", "goutte", "pastille"];
const DETAILS = { gomme: "", bulle: "antenne", cube: "lunettes", goutte: "sourcils", pastille: "joues" };
const COLORS = { gomme: "#ff7a59", bulle: "#4a9df8", cube: "#2fbf8f", goutte: "#8b6cf0", pastille: "#f5b82e" };
const page0 = (o) => `${BASE}/demo-visage.html?${new URLSearchParams(o)}`;
const results = {};

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });

async function open(params, ctxOptions = {}) {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 520 }, deviceScaleFactor: 1, ...ctxOptions });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(page0(params));
  await page.waitForFunction(() => window.noahDemo);
  return { ctx, page, errors };
}

/** Planche : 12 images ou plus, prises à intervalle fixe, dans une seule image. */
async function sheet(name, params, act, { frames = 16, every = 66, lead = 0, scale = 1 } = {}) {
  if (process.env.NOAH_ONLY && !new RegExp(process.env.NOAH_ONLY).test(name)) return;
  const { ctx, page, errors } = await open(params, { deviceScaleFactor: scale });
  const box = page.locator("[data-face-box]").first();
  const b = await box.boundingBox();
  // On capture aussi ce qui dépasse de la tuile vers le haut.
  const clip = { x: b.x - 26, y: b.y - 40, width: b.width + 52, height: b.height + 56 };
  if (lead) await page.waitForTimeout(lead);
  await act?.(page);
  const images = [];
  for (let i = 0; i < frames; i++) {
    const t0 = Date.now();
    images.push((await page.screenshot({ clip, type: "png" })).toString("base64"));
    const left = every - (Date.now() - t0);
    if (left > 0) await page.waitForTimeout(left);
  }
  await ctx.close();
  const shown = scale > 1 ? scale : 0.62;
  const cw = Math.round(clip.width * shown);
  const ch = Math.round(clip.height * shown);
  const page2 = await browser.newPage({ viewport: { width: cw * 8 + 40, height: Math.ceil(frames / 8) * (ch + 22) + 34 } });
  await page2.setContent(`<body style="margin:8px;background:#fff;font:12px sans-serif;color:#333"><div style="margin-bottom:6px;font-weight:600">${name}</div>
    <div style="display:grid;grid-template-columns:repeat(8,${cw}px);gap:0">
    ${images.map((d, i) => `<div style="position:relative;border:1px solid #eee"><img style="width:100%;display:block" src="data:image/png;base64,${d}"><span style="position:absolute;left:3px;top:2px;color:#888">${i}</span></div>`).join("")}
    </div></body>`);
  const path = join(OUT, `${name}.png`);
  await page2.waitForTimeout(100);
  await page2.screenshot({ path, fullPage: true });
  await page2.close();
  if (errors.length) console.log(name, "erreurs :", errors.slice(0, 3));
  return path;
}

async function captures() {
  const dir = join(OUT, "planches");
  mkdirSync(dir, { recursive: true });
  const size = "160";
  for (const shape of SHAPES) {
    const params = { face: shape, detail: DETAILS[shape], color: COLORS[shape], size, seed: `planche-${shape}`, state: "idle" };
    await sheet(`planches/${shape}-repos`, params, null, { frames: 16, every: 300, lead: 300 });
    await sheet(`planches/${shape}-ecoute`, { ...params, state: "listening" }, null, { frames: 12, every: 300, lead: 400 });
    await sheet(`planches/${shape}-reflexion`, { ...params, state: "thinking" }, null, { frames: 16, every: 400, lead: 200 });
    await sheet(`planches/${shape}-parole`, { ...params, state: "speaking" }, null, { frames: 16, every: 70, lead: 500 });
    await sheet(`planches/${shape}-saut`, params, (p) => p.evaluate(() => window.noahDemo.react("hop")), { frames: 24, every: 40, lead: 300 });
  }
  const g = { face: "gomme", detail: "antenne", color: COLORS.gomme, size, seed: "planche-geste" };
  for (const r of ["joy", "surprise", "lookLeft", "lookRight", "sad", "confused", "wiggle", "nod", "attention", "greet"]) {
    await sheet(`planches/geste-${r}`, g, (p) => p.evaluate((k) => window.noahDemo.react(k), r), { frames: 24, every: r === "sad" ? 130 : 60, lead: 300 });
  }
  for (const [shape, detail] of [["gomme", "lunettes"], ["bulle", "antenne"]]) {
    for (const px of [32, 48]) {
      const params = { face: shape, detail, color: COLORS[shape], size: String(px), seed: "petit" };
      await sheet(`planches/petit-${px}-${shape}-repos`, params, null, { frames: 12, every: 500, lead: 200, scale: 3 });
      await sheet(`planches/petit-${px}-${shape}-saut`, params, (p) => p.evaluate(() => window.noahDemo.react("hop")), { frames: 12, every: 60, lead: 200, scale: 3 });
    }
  }
  // Vue d'ensemble
  if (process.env.NOAH_ONLY) return;
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 1160 }, recordVideo: { dir: OUT, size: { width: 1100, height: 1160 } } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/demo-visage.html`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(OUT, "ensemble.png") });
  await page.getByRole("button", { name: "joy", exact: true }).click();
  await page.waitForTimeout(1800);
  await page.getByRole("button", { name: "surprise", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "hop", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "lookLeft", exact: true }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Réflexion", exact: true }).click();
  await page.waitForTimeout(2500);
  await page.getByRole("button", { name: "Parole", exact: true }).click();
  await page.waitForTimeout(2500);
  const video = page.video();
  await ctx.close();
  console.log("vidéo", await video.path());
}

/** Temps d'image sur la durée donnée, relevé dans la page. */
const frameTimes = (ms) =>
  new Promise((done) => {
    const d = [];
    let last = performance.now();
    const end = last + ms;
    const tick = (now) => {
      d.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(tick);
      else done(d);
    };
    requestAnimationFrame(tick);
  });
const pct = (a, p) => [...a].sort((x, y) => x - y)[Math.floor((a.length - 1) * p)];
const stat = (a) => ({ pires: [...a.keys()].sort((x, y) => a[y] - a[x]).slice(0, 3).map((i) => [i, +a[i].toFixed(0)]), n: a.length, moyenne: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2), p95: +pct(a, 0.95).toFixed(2), p99: +pct(a, 0.99).toFixed(2), max: +Math.max(...a).toFixed(2), perdues: +((a.filter((x) => x > 25).length / a.length) * 100).toFixed(2) });

async function taskRate(page, cdp, ms) {
  const read = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const a = await read();
  await page.waitForTimeout(ms);
  const b = await read();
  return +(((b.TaskDuration - a.TaskDuration) / (b.Timestamp - a.Timestamp)) * 100).toFixed(2);
}

async function performance1(count, size, rate, label, shape = "gomme") {
  const { ctx, page, errors } = await open({ face: shape, count: String(count), size: String(size), seed: "perf", detail: "antenne", state: "idle" }, count > 1 ? { viewport: { width: 1400, height: 1000 } } : {});
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const s = window.noahDemo.stats;
    s.on = true;
    Object.assign(s, { frames: 0, engineMs: 0, stepMs: 0, writes: 0, rafCalls: 0, maxEngineMs: 0 });
    window.__loaf = [];
    try {
      new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__loaf.push(e.duration))).observe({ type: "long-animation-frame", buffered: false });
    } catch {
      window.__loaf = null;
    }
  });
  const times = await page.evaluate(frameTimes, 10000);
  const cpu = await taskRate(page, cdp, 5000);
  const stats = await page.evaluate(() => ({ ...window.noahDemo.stats, loaf: window.__loaf }));
  await ctx.close();
  const r = {
    images: stat(times),
    cpu_pourcent: cpu,
    reveils_par_s: +(stats.frames / 15).toFixed(1),
    moteur_ms_par_reveil: +(stats.engineMs / Math.max(stats.frames, 1)).toFixed(3),
    moteur_ms_par_s: +(stats.engineMs / 15).toFixed(1),
    moteur_ms_max: +stats.maxEngineMs.toFixed(2),
    simulation_ms_par_s: +(stats.stepMs / 15).toFixed(1),
    ecritures_par_s: +(stats.writes / 15).toFixed(1),
    images_longues_50ms: stats.loaf ? stats.loaf.length : "non disponible",
    erreurs: errors.length,
  };
  results[label] = r;
  console.log(label, JSON.stringify(r));
}

async function emptyCpu(rate, label) {
  const ctx = await browser.newContext({ viewport: { width: 520, height: 520 } });
  const page = await ctx.newPage();
  await page.goto("about:blank");
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await page.waitForTimeout(500);
  results[label] = await taskRate(page, cdp, 5000);
  console.log(label, results[label]);
  await ctx.close();
}

async function mesures() {
  await emptyCpu(4, "page_vide_cpu_4x");
  await performance1(1, 96, 1, "1_visage_1x");
  await performance1(1, 96, 4, "1_visage_4x");
  await performance1(1, 96, 6, "1_visage_6x");
  await performance1(1, 240, 4, "1_visage_240px_4x");
  await performance1(30, 40, 1, "30_visages_40px_1x");
  await performance1(30, 40, 4, "30_visages_40px_4x");
  await performance1(30, 40, 6, "30_visages_40px_6x");
  await performance1(30, 96, 4, "30_visages_96px_4x");

  // Trajectoire image par image relevée dans le vrai DOM : base au sol et aire d'après le contour affiché.
  {
    const { ctx, page } = await open({ face: "gomme", size: "240", seed: "trace" });
    await page.waitForTimeout(400);
    const rec = await page.evaluate(
      () =>
        new Promise((done) => {
          const body = document.querySelector('[data-n="body"]');
          const lift = document.querySelector('[data-n="lift"]');
          const rows = [];
          const t0 = performance.now();
          window.noahDemo.react("hop");
          const tick = (now) => {
            const b = body.getBBox();
            const tr = lift.getAttribute("transform") || "";
            const m = tr.match(/translate\(0 (-?[\d.]+)\)/);
            rows.push({ t: +(now - t0).toFixed(1), x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2), alt: m ? -Number(m[1]) : 0, bas: +(b.y + b.height).toFixed(2) });
            if (now - t0 < 1500) requestAnimationFrame(tick);
            else done(rows);
          };
          requestAnimationFrame(tick);
        }),
    );
    writeFileSync(join(OUT, "trajectoire-saut-dom.json"), JSON.stringify(rec));
    results.saut_dom = {
      images: rec.length,
      altitude_max: Math.max(...rec.map((r) => r.alt)),
      hauteur_min: Math.min(...rec.map((r) => r.h)),
      hauteur_max: Math.max(...rec.map((r) => r.h)),
      largeur_min: Math.min(...rec.map((r) => r.w)),
      largeur_max: Math.max(...rec.map((r) => r.w)),
      base_min: Math.min(...rec.filter((r) => r.alt === 0).map((r) => r.bas)),
      base_max: Math.max(...rec.filter((r) => r.alt === 0).map((r) => r.bas)),
    };
    console.log("saut_dom", JSON.stringify(results.saut_dom));
    await ctx.close();
  }

  // V1 en pixels : silhouette seule, rendue à l'échelle 4x, pendant un saut, pour chaque forme.
  for (const shape of SHAPES) {
    const { ctx, page } = await open({ face: shape, size: "160", seed: "pixels", tile: "0" }, { deviceScaleFactor: 4 });
    await page.addStyleTag({ content: `svg > *:not([data-n="lift"]):not(defs), [data-n="lift"] > *:not([data-n="body"]) { display: none !important; } [data-n="body"] { fill: #000 !important; } ` });
    await page.waitForTimeout(150);
    const count = async () => {
      const buf = await page.screenshot({ type: "png" });
      return await pixelCount(buf);
    };
    const rest = await count();
    await page.evaluate(() => window.noahDemo.react("joy"));
    let worst = 0;
    const seen = [];
    for (let i = 0; i < 14; i++) {
      const n = await count();
      seen.push(n);
      worst = Math.max(worst, Math.abs(n / rest - 1));
    }
    results[`V1_pixels_${shape}`] = { repos: rest, ecart_max_pourcent: +(worst * 100).toFixed(2), vus: seen };
    console.log(`V1 ${shape}`, rest, (worst * 100).toFixed(2) + " %");
    await ctx.close();
  }

  // A5 : rien de coupé. Pose du saut le plus haut, figée, antenne comprise : l'image doit être la même qu'avec tout overflow forcé à visible.
  for (const size of [32, 48, 96, 240]) {
    let diff = 0;
    let boxes = 0;
    let above = 0;
    for (const shape of SHAPES) {
      const { ctx, page } = await open({ face: shape, detail: "antenne", size: String(size), seed: "coupe" }, { viewport: { width: 500, height: 560 }, deviceScaleFactor: 2 });
      const info = await page.evaluate(() => {
        window.noahDemo.setPaused(true);
        const f = window.noahDemo.faces()[0];
        Object.assign(f.sim.pose, { alt: f.sim.material.hop * 1.32, squash: -0.2 });
        f.draw();
        const svg = document.querySelector("svg");
        const tile = svg.parentElement.getBoundingClientRect();
        const top = document.querySelector('[data-n="antB"]').getBoundingClientRect().top;
        let bad = 0;
        for (let el = svg; el && el !== document.body; el = el.parentElement) if (getComputedStyle(el).overflow !== "visible") bad++;
        return { bad, above: +(tile.top - top).toFixed(1) };
      });
      boxes += info.bad;
      above = Math.max(above, info.above);
      const a = await page.screenshot({ type: "png" });
      await page.addStyleTag({ content: "* { overflow: visible !important; }" });
      const b = await page.screenshot({ type: "png" });
      diff += a.equals(b) ? 0 : await pixelDiff(a, b);
      await page.evaluate(() => window.noahDemo.setPaused(false));
      await ctx.close();
    }
    results[`A5_${size}px`] = { pixels_coupes: diff, boites_qui_coupent: boxes, depasse_de_la_tuile_px: above };
    console.log(`A5 ${size}px`, JSON.stringify(results[`A5_${size}px`]));
  }

  // G3 suite : les yeux ne quittent jamais la surface. Points du contour des yeux, testés dans le corps à chaque image.
  for (const shape of SHAPES) {
    const { ctx, page } = await open({ face: shape, detail: "", size: "240", seed: "dedans" }, { viewport: { width: 900, height: 700 } });
    await page.waitForTimeout(200);
    await page.mouse.move(880, 20);
    const r = await page.evaluate(
      () =>
        new Promise((done) => {
          const svg = document.querySelector("svg");
          const body = svg.querySelector('[data-n="body"]');
          const parts = ["eyeL", "eyeR", "mouth"].map((k) => svg.querySelector(`[data-n="${k}"]`));
          const seq = ["hop", "lookLeft", "surprise", "lookRight", "joy", "confused", "sad", "hop"];
          let frames = 0, out = 0, i = 0, worstPart = "";
          const t0 = performance.now();
          let next = 0;
          const tick = (now) => {
            if (now - t0 > next && i < seq.length) {
              window.noahDemo.react(seq[i++]);
              next += 1500;
            }
            frames++;
            for (const part of parts) {
              const L = part.getTotalLength();
              for (let k = 0; k < 8; k++) {
                const pt = part.getPointAtLength((L * k) / 8);
                if (!body.isPointInFill(pt)) {
                  out++;
                  worstPart = part.getAttribute("data-n");
                }
              }
            }
            if (now - t0 < 12000) requestAnimationFrame(tick);
            else done({ images: frames, points_dehors: out, piece: worstPart });
          };
          requestAnimationFrame(tick);
        }),
    );
    results[`G3_yeux_dans_le_corps_${shape}`] = r;
    console.log(`G3 dedans ${shape}`, JSON.stringify(r));
    await ctx.close();
  }

  // N1 en pixels : aucune paire de captures identiques, séparées de 2 s, sur 30 s.
  {
    const { ctx, page } = await open({ face: "gomme", size: "160", seed: "pixels-n1", detail: "antenne" });
    await page.waitForTimeout(300);
    const box = await page.locator("[data-face-box]").first().boundingBox();
    const shots = [];
    for (let i = 0; i < 15; i++) {
      shots.push((await page.screenshot({ type: "png", clip: box })).toString("base64"));
      await page.waitForTimeout(2000);
    }
    const same = shots.length - new Set(shots).size;
    results.N1_pixels = { captures: shots.length, identiques: same };
    console.log("N1 pixels", JSON.stringify(results.N1_pixels));
    await ctx.close();
  }

  // M3 : téléphone simulé. Surcoût par rapport à la même page sans visage, en 4x, 6x et 20x.
  for (const rate of [4, 6, 20]) {
    const row = {};
    for (const [label, params] of [["sans", { face: "gomme", count: "0", size: "40", seed: "m3" }], ["un", { face: "gomme", count: "1", size: "96", seed: "m3", detail: "antenne" }], ["liste30", { face: "gomme", count: "30", size: "40", seed: "m3", detail: "antenne" }]]) {
      const { ctx, page } = await open(params, { viewport: { width: 375, height: 812 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
      const cdp = await ctx.newCDPSession(page);
      await cdp.send("Performance.enable");
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      await page.waitForTimeout(1000);
      row[label] = await taskRate(page, cdp, 6000);
      await ctx.close();
    }
    results[`M3_telephone_${rate}x`] = { ...row, surcout_un: +(row.un - row.sans).toFixed(2), surcout_liste: +(row.liste30 - row.sans).toFixed(2) };
    console.log(`M3 ${rate}x`, JSON.stringify(results[`M3_telephone_${rate}x`]));
  }

  // M5 : trace Chrome. Temps de peinture par image, et filtres SVG.
  for (const [label, count, size, rate] of [["1_visage_6x", 1, 96, 6], ["30_visages_6x", 30, 40, 6], ["1_visage_4x", 1, 96, 4], ["30_visages_4x", 30, 40, 4]]) {
    const { ctx, page } = await open({ face: "gomme", count: String(count), size: String(size), seed: "m5", detail: "antenne" }, count > 1 ? { viewport: { width: 1400, height: 1000 } } : {});
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    await page.waitForTimeout(800);
    await browser.startTracing(page, { categories: ["devtools.timeline", "disabled-by-default-devtools.timeline"] });
    await page.waitForTimeout(10000);
    const trace = JSON.parse((await browser.stopTracing()).toString());
    const sum = {};
    const n = {};
    for (const e of trace.traceEvents) {
      if (e.ph === "X" && ["Paint", "PrePaint", "Layerize", "Commit", "Layout", "UpdateLayoutTree"].includes(e.name)) {
        sum[e.name] = (sum[e.name] ?? 0) + e.dur / 1000;
        n[e.name] = (n[e.name] ?? 0) + 1;
      }
    }
    const frames = n.Paint || 1;
    results[`M5_${label}`] = { peintures: n.Paint ?? 0, paint_ms_par_image: +((sum.Paint ?? 0) / frames).toFixed(3), prepaint_ms: +((sum.PrePaint ?? 0) / frames).toFixed(3), layout_ms: +((sum.Layout ?? 0) / frames).toFixed(3), style_ms: +((sum.UpdateLayoutTree ?? 0) / frames).toFixed(3) };
    console.log(`M5 ${label}`, JSON.stringify(results[`M5_${label}`]));
    await ctx.close();
  }

  // L1 : un signal connu dans un vrai AudioContext, enveloppe RMS lue par un AnalyserNode, comparée à l'ouverture de la bouche.
  {
    const { ctx, page } = await open({ face: "gomme", size: "240", seed: "voix", state: "speaking", voice: "1" });
    const r = await page.evaluate(
      () =>
        new Promise(async (done) => {
          const f = window.noahDemo.faces()[0];
          const ac = new AudioContext();
          await ac.resume();
          const osc = new OscillatorNode(ac, { frequency: 220 });
          const gain = new GainNode(ac, { gain: 0 });
          const an = new AnalyserNode(ac, { fftSize: 1024 });
          const sink = new GainNode(ac, { gain: 0 });
          osc.connect(gain).connect(an).connect(sink).connect(ac.destination);
          const t0 = ac.currentTime + 0.1;
          const dur = 12;
          // Enveloppe de type parole : syllabes de 4 Hz modulées par des phrases.
          const steps = dur * 100;
          const curve = new Float32Array(steps);
          for (let i = 0; i < steps; i++) {
            const t = i / 100;
            const syl = Math.max(0, Math.sin(2 * Math.PI * 3.7 * t));
            const phrase = Math.sin(2 * Math.PI * 0.35 * t) > -0.5 ? 1 : 0;
            curve[i] = 0.7 * syl * phrase;
          }
          gain.gain.setValueCurveAtTime(curve, t0, dur);
          osc.start();
          const buf = new Float32Array(an.fftSize);
          const rows = [];
          const tick = () => {
            an.getFloatTimeDomainData(buf);
            let s = 0;
            for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
            const rms = Math.min(1, Math.sqrt(s / buf.length) * 2.2);
            window.noahDemo.voice.current = rms;
            rows.push([performance.now(), rms, f.sim.pose.open]);
            if (ac.currentTime < t0 + dur) requestAnimationFrame(tick);
            else {
              osc.stop();
              ac.close();
              done({ etat: ac.state, rows });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
    const rows = r.rows.slice(30);
    const fps = (rows.length - 1) / ((rows[rows.length - 1][0] - rows[0][0]) / 1000);
    const a = rows.map((x) => x[1]);
    const b = rows.map((x) => x[2]);
    let best = -2, lag = 0;
    for (let k = -12; k <= 30; k++) {
      const c = corr(k >= 0 ? a.slice(0, a.length - k) : a.slice(-k), k >= 0 ? b.slice(k) : b.slice(0, b.length + k));
      if (c > best) { best = c; lag = k; }
    }
    results.L1_signal_connu = { images: rows.length, images_par_s: +fps.toFixed(1), correlation: +best.toFixed(3), retard_bouche_sur_son_ms: +((lag / fps) * 1000).toFixed(0), note: "retard de l'analyse et du moteur seulement : la latence de sortie du son n'est pas comprise" };
    console.log("L1", JSON.stringify(results.L1_signal_connu));
    await ctx.close();
  }

  // Branchement réel : la conversation et l'écran d'appel montés tels quels.
  {
    const { ctx, page, errors } = await open({ scene: "tour" }, { viewport: { width: 1100, height: 700 } });
    await page.waitForTimeout(600);
    const before = await page.evaluate(() => [...document.querySelectorAll("svg[data-state]")].map((s) => s.dataset.state));
    await page.locator("textarea").first().fill("Bonjour");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(800);
    const during = await page.evaluate(() => [...document.querySelectorAll("svg[data-state]")].map((s) => s.dataset.state));
    await page.screenshot({ path: join(OUT, "branchement-tour-pendant.png") });
    await page.evaluate(() => window.noahDemo.release());
    await page.waitForTimeout(800);
    const after = await page.evaluate(() => [...document.querySelectorAll("svg[data-state]")].map((s) => s.dataset.state));
    await page.screenshot({ path: join(OUT, "branchement-tour-apres.png") });
    results.branchement_tour = { avant: before, pendant: during, apres: after, erreurs: errors.slice(0, 3) };
    console.log("tour", JSON.stringify(results.branchement_tour));
    await ctx.close();
  }
  {
    const { ctx, page, errors } = await open({ scene: "appel", shape: "cube", detail: "lunettes" }, { viewport: { width: 1100, height: 700 } });
    await page.waitForTimeout(400);
    const seen = {};
    for (const phase of ["listening", "sending", "waiting", "speaking", "listening", "error"]) {
      await page.evaluate((p) => window.noahDemo.setPhase(p), phase);
      await page.waitForTimeout(400);
      seen[phase] = await page.evaluate(() => document.querySelector("svg[data-state]").dataset.state);
      await page.screenshot({ path: join(OUT, `branchement-appel-${phase}.png`) });
    }
    // Le micro fait réagir le corps
    await page.evaluate(() => window.noahDemo.setPhase("listening"));
    await page.waitForTimeout(500);
    const body = await page.evaluate(
      () =>
        new Promise((done) => {
          const f = window.noahDemo.faces()[0];
          const quiet = [], loud = [];
          const t0 = performance.now();
          const tick = (now) => {
            const a = now - t0;
            window.noahDemo.mic.current = a > 1500 ? 0.9 : 0;
            (a > 1500 ? loud : quiet).push(f.sim.pose.squash);
            if (a < 3000) requestAnimationFrame(tick);
            else {
              window.noahDemo.mic.current = 0;
              const m = (x) => x.slice(40).reduce((u, v) => u + v, 0) / (x.length - 40);
              done({ corps_calme: +m(quiet).toFixed(3), corps_micro_fort: +m(loud).toFixed(3) });
            }
          };
          requestAnimationFrame(tick);
        }),
    );
    results.branchement_appel = { etats: seen, ...body, erreurs: errors.slice(0, 3) };
    console.log("appel", JSON.stringify(results.branchement_appel));
    await ctx.close();
  }

  // U1 : mouvement réduit. Aucun appel de boucle au repos, expression par fondu.
  {
    const { ctx, page } = await open({ face: "gomme", size: "160", seed: "reduit" }, { reducedMotion: "reduce" });
    await page.waitForTimeout(300);
    const r = await page.evaluate(
      () =>
        new Promise((done) => {
          const s = window.noahDemo.stats;
          s.on = true;
          s.rafCalls = 0;
          s.writes = 0;
          const before = document.querySelector('[data-n="body"]').getAttribute("d");
          setTimeout(() => {
            const idle = { boucle: s.rafCalls, ecritures: s.writes, corps_inchange: before === document.querySelector('[data-n="body"]').getAttribute("d") };
            window.noahDemo.setState("thinking");
            const group = document.querySelector('[data-n="face"]');
            const t0 = performance.now();
            let seen = 0;
            let end = 0;
            const tick = (now) => {
              if (group.hasAttribute("opacity")) {
                seen++;
                end = now - t0;
              }
              if (now - t0 < 600) requestAnimationFrame(tick);
              else done({ repos: idle, fondu_images: seen, fondu_ms: +end.toFixed(0), corps_apres: before === document.querySelector('[data-n="body"]').getAttribute("d"), boucle_apres: s.rafCalls });
            };
            requestAnimationFrame(tick);
          }, 4000);
        }),
    );
    results.U1_mouvement_reduit = r;
    console.log("U1", JSON.stringify(r));
    await ctx.close();
  }

  // U2 : pause. Arrêt à l'image suivante, mémorisé au rechargement.
  {
    const { ctx, page } = await open({ face: "gomme", size: "160", seed: "pause" });
    await page.waitForTimeout(300);
    const r = await page.evaluate(
      () =>
        new Promise((done) => {
          const s = window.noahDemo.stats;
          s.on = true;
          window.noahDemo.setPaused(true);
          const f = window.noahDemo.faces()[0];
          const d0 = document.querySelector('[data-n="body"]').getAttribute("d");
          const t0 = f.sim.t;
          s.rafCalls = 0;
          s.writes = 0;
          setTimeout(() => done({ boucle: s.rafCalls, ecritures: s.writes, temps_sim: f.sim.t - t0, inchange: d0 === document.querySelector('[data-n="body"]').getAttribute("d") }), 2000);
        }),
    );
    await page.reload();
    await page.waitForFunction(() => window.noahDemo);
    r.memorise = await page.evaluate(() => window.noahDemo.isPaused());
    await page.evaluate(() => window.noahDemo.setPaused(false));
    results.U2_pause = r;
    console.log("U2", JSON.stringify(r));
    await ctx.close();
  }

  // M4 : onglet caché et visage hors écran.
  {
    const { ctx, page } = await open({ face: "gomme", size: "160", seed: "cache" });
    await page.waitForTimeout(300);
    const off = await page.evaluate(
      () =>
        new Promise((done) => {
          const s = window.noahDemo.stats;
          s.on = true;
          const box = document.querySelector("[data-face-box]");
          box.style.position = "fixed";
          box.style.top = "5000px";
          setTimeout(() => {
            s.rafCalls = 0;
            s.writes = 0;
            setTimeout(() => done({ boucle: s.rafCalls, ecritures: s.writes, actifs: window.noahDemo.active().length }), 2000);
          }, 500);
        }),
    );
    results.M4_hors_ecran = off;
    console.log("M4 hors écran", JSON.stringify(off));
    // Un onglet caché : on simule l'événement, l'onglet sans interface ne passe jamais vraiment en arrière-plan.
    const hidden = await page.evaluate(
      () =>
        new Promise((done) => {
          const box = document.querySelector("[data-face-box]");
          box.style.position = "";
          setTimeout(() => {
            const s = window.noahDemo.stats;
            Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
            document.dispatchEvent(new Event("visibilitychange"));
            s.rafCalls = 0;
            s.writes = 0;
            setTimeout(() => {
              const r = { boucle: s.rafCalls, ecritures: s.writes };
              delete document.hidden;
              document.dispatchEvent(new Event("visibilitychange"));
              s.rafCalls = 0;
              setTimeout(() => done({ ...r, repris: s.rafCalls > 0 }), 300);
            }, 2000);
          }, 300);
        }),
    );
    results.M4_onglet_cache_simule = hidden;
    console.log("M4 onglet caché (événement simulé)", JSON.stringify(hidden));
    await ctx.close();
  }

  // G3 : délai entre un déplacement de pointeur et le départ des yeux.
  {
    const { ctx, page } = await open({ face: "gomme", size: "240", seed: "pointeur" }, { viewport: { width: 900, height: 700 } });
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const f = window.noahDemo.faces()[0];
      window.__gaze = [];
      const tick = (now) => {
        window.__gaze.push([now, f.sim.pose.gazeX, f.sim.pose.gazeY]);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const delays = [];
    const spots = [[880, 40], [20, 40], [880, 680], [20, 680], [880, 350], [20, 350], [450, 20], [450, 690]];
    for (const [x, y] of spots) {
      await page.waitForTimeout(700);
      const t = await page.evaluate(() => performance.now());
      await page.mouse.move(x, y);
      await page.waitForTimeout(500);
      const d = await page.evaluate((t) => {
        const after = window.__gaze.filter((g) => g[0] >= t);
        const g0 = after[0];
        const moved = after.find((g) => Math.hypot(g[1] - g0[1], g[2] - g0[2]) > 0.1);
        return moved ? moved[0] - t : null;
      }, t);
      if (d !== null) delays.push(+d.toFixed(0));
    }
    results.G3_pointeur = { delais_ms: delays, min: Math.min(...delays), max: Math.max(...delays) };
    console.log("G3", JSON.stringify(results.G3_pointeur));
    await ctx.close();
  }
}

function corr(a, b) {
  const n = Math.min(a.length, b.length);
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** Nombre de pixels qui diffèrent entre deux captures de même taille. */
async function pixelDiff(a, b) {
  const p = await browser.newPage();
  const n = await p.evaluate(async ([x, y]) => {
    const read = async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext("2d");
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height).data;
    };
    const [u, v] = [await read(x), await read(y)];
    let d = 0;
    for (let i = 0; i < u.length; i += 4) if (Math.abs(u[i] - v[i]) + Math.abs(u[i + 1] - v[i + 1]) + Math.abs(u[i + 2] - v[i + 2]) > 12) d++;
    return d;
  }, [a.toString("base64"), b.toString("base64")]);
  await p.close();
  return n;
}

async function pixelCount(buf) {
  // Décodage dans une page : aucun paquet ajouté.
  const p = await browser.newPage();
  const n = await p.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = new OffscreenCanvas(img.width, img.height);
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 1 - d[i] / 255; // couverture : tient compte de l'anticrénelage
    return sum;
  }, buf.toString("base64"));
  await p.close();
  return n;
}

/** M4 : tas JS sur 10 minutes, après un ramasse-miettes forcé à chaque relevé. */
async function memoire() {
  const { ctx, page } = await open({ face: "gomme", size: "96", seed: "memoire", detail: "antenne" });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Performance.enable");
  await cdp.send("HeapProfiler.enable");
  const read = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const m = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
    return +(m.JSHeapUsedSize / 1048576).toFixed(3);
  };
  await page.waitForTimeout(10000);
  const seen = [await read()];
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(60000);
    seen.push(await read());
    await page.evaluate(() => window.noahDemo.react("joy"));
    console.log("tas", i + 1, "min", seen[seen.length - 1]);
  }
  results.M4_tas_10_min = { releves_mo: seen, croissance_mo: +(seen[seen.length - 1] - seen[0]).toFixed(3) };
  await ctx.close();
}

if (WHAT === "memoire") await memoire();
if (WHAT === "captures" || WHAT === "tout") await captures();
if (WHAT === "mesures" || WHAT === "tout") await mesures();
writeFileSync(join(OUT, "mesures.json"), JSON.stringify(results, null, 1));
await browser.close();
