// L'appel en cours sur Android : la page vit-elle encore hors de l'application et écran éteint ? Compte un minuteur de 50 ms et les relevés du micro.
// Il faut un émulateur en appel, sorti de l'application (fenêtre flottante), et l'APK de débogage (ses pages s'inspectent).
//     NOAH_PLAYWRIGHT=<chemin de playwright> node tests/real/appel_android_vivant.mjs
import { execFileSync as x } from "node:child_process";
import { createRequire } from "node:module";
const A = process.env.LOCALAPPDATA + "/Android/Sdk/platform-tools/adb";
const adb = (...a) => x(A, a, { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } }).trim();
const pid = adb("shell", "pidof", "agent.noah.mobile");
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
const { chromium } = createRequire(import.meta.url)(process.env.NOAH_PLAYWRIGHT);
const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = b.contexts()[0].pages().find((p) => !p.url().startsWith("https://localhost"));
console.log("page :", page.url().slice(0, 60));
await page.evaluate(() => {
  window.__t = { ticks: 0, t0: performance.now() };
  setInterval(() => window.__t.ticks++, 50);
  const read = AnalyserNode.prototype.getByteTimeDomainData;
  window.__t.reads = 0;
  AnalyserNode.prototype.getByteTimeDomainData = function (buf) { window.__t.reads++; return read.call(this, buf); };
});
const lap = async (name, ms) => {
  const a = await page.evaluate(() => ({ ...window.__t, now: performance.now() }));
  await new Promise((r) => setTimeout(r, ms));
  const z = await page.evaluate(() => ({ ...window.__t, now: performance.now(), vis: document.visibilityState, w: innerWidth }));
  const s = (z.now - a.now) / 1000;
  console.log(name, "|", s.toFixed(1), "s |", ((z.ticks - a.ticks) / s).toFixed(1), "minuteurs/s |", ((z.reads - a.reads) / s).toFixed(1), "relevés micro/s |", z.vis, "largeur", z.w);
};
await lap("fenêtre flottante", 15000);
adb("shell", "input", "keyevent", "KEYCODE_SLEEP");
await new Promise((r) => setTimeout(r, 2000));
await lap("écran éteint     ", 30000);
adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
await new Promise((r) => setTimeout(r, 2000));
await lap("écran rallumé    ", 10000);
await b.close();
adb("forward", "--remove", "tcp:9333");
