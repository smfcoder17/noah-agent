"""Banc anti-robot du navigateur de l'agent (plan 0.3.0, docs/epics/0.3.0/navigateur.md).

Compare plusieurs moteurs sur des pages publiques qui détectent les robots, depuis la machine où il tourne
(le VPS : c'est son adresse qui compte). Aucun compte, aucun identifiant. Chaque passage part d'un profil vierge,
comme le futur navigateur Lecture. Les tâches s'enchaînent avec des pauses irrégulières : on mesure le moteur,
pas une rafale.

    python banc.py [--moteurs chromium,patchright,camoufox] [--passages 2] [--taches cloudflare,google] [--sortie /out]

Sortie : resultats.json, resultats.md et une capture par tâche dans --sortie.
"""
import argparse
import asyncio
import json
import platform
import random
import re
import tempfile
import time
import urllib.request
from importlib import metadata
from pathlib import Path

TASK_S = 75
UA = "noah-banc"


# --- Moteurs ---------------------------------------------------------------------------------------------------------
# Chacun ouvre un navigateur avec écran (dans Xvfb), donne une page, et se ferme. Profil vierge à chaque passage.

class Chromium:
    """Chromium de Playwright, sans correction : le témoin."""
    nom = "chromium"

    async def __aenter__(self):
        from playwright.async_api import async_playwright
        self._p = await async_playwright().start()
        self._b = await self._p.chromium.launch(headless=False)
        ctx = await self._b.new_context(locale="fr-FR", timezone_id=IP.get("timezone") or "Europe/Paris")
        return await ctx.new_page()

    async def __aexit__(self, *exc):
        await self._b.close()
        await self._p.stop()


class Patchright:
    """Chrome réel (Chromium sur ARM) piloté par Patchright : Playwright sans les traces CDP connues."""
    nom = "patchright"

    async def __aenter__(self):
        from patchright.async_api import async_playwright
        self._p = await async_playwright().start()
        self._dir = tempfile.mkdtemp(prefix="banc-pr-")
        channel = "chrome" if platform.machine() == "x86_64" else None
        # Réglages conseillés par Patchright : profil persistant, pas de viewport forcé, pas d'en-têtes ajoutés.
        self._ctx = await self._p.chromium.launch_persistent_context(
            self._dir, channel=channel, headless=False, no_viewport=True,
            locale="fr-FR", timezone_id=IP.get("timezone") or "Europe/Paris")
        return self._ctx.pages[0] if self._ctx.pages else await self._ctx.new_page()

    async def __aexit__(self, *exc):
        await self._ctx.close()
        await self._p.stop()


class Camoufox:
    """Camoufox, le moteur actuel de Noah : Firefox corrigé dans son code, empreintes de vraies machines."""
    nom = "camoufox"

    async def __aenter__(self):
        from camoufox.async_api import AsyncCamoufox
        self._cm = AsyncCamoufox(headless=False, geoip=True, locale="fr-FR", humanize=True)
        self._b = await self._cm.__aenter__()
        return await self._b.new_page()

    async def __aexit__(self, *exc):
        await self._cm.__aexit__(*exc)


MOTEURS = {m.nom: m for m in (Chromium, Patchright, Camoufox)}


# --- Tâches ----------------------------------------------------------------------------------------------------------
# Chacune rend (verdict, détail). Verdicts : passe, bloqué, signalé (la page dit « robot » sans bloquer),
# mesure (un chiffre à lire), incertain.

async def texte(page):
    try:
        return await page.evaluate("document.body ? document.body.innerText : ''")
    except Exception:
        return ""


async def cliquer_texte(page, motif):
    """Clique le premier bouton ou lien dont le texte correspond (refus des cookies). Rend vrai si cliqué."""
    for role in ("button", "link"):
        loc = page.get_by_role(role, name=re.compile(motif, re.I))
        if await loc.count():
            try:
                await loc.first.click(timeout=5000)
                await page.wait_for_timeout(2500)
                return True
            except Exception:
                pass
    return False


async def sannysoft(page):
    await page.goto("https://bot.sannysoft.com", wait_until="load")
    await page.wait_for_timeout(4000)
    rouges = await page.evaluate(
        "[...document.querySelectorAll('td.failed')].map(td => (td.previousElementSibling || td).innerText.split('\\n')[0].trim())")
    if "Firefox" in await page.evaluate("navigator.userAgent"):
        # Un vrai Firefox n'a pas d'objet window.chrome : cette ligne rouge est normale pour lui.
        rouges = [r for r in rouges if r.strip().lower() != "chrome"]
    if not rouges:
        return "passe", "aucune ligne rouge"
    return "signalé", f"{len(rouges)} lignes rouges : " + ", ".join(r[:30] for r in rouges[:6])


async def creepjs(page):
    await page.goto("https://abrahamjuliot.github.io/creepjs/", wait_until="load")
    await page.wait_for_timeout(15000)
    t = await texte(page)
    mesures = re.findall(r"(\d+(?:\.\d+)?)%\s*(like headless|headless|stealth)", t, re.I)
    if not mesures:
        return "incertain", "scores non trouvés"
    return "mesure", ", ".join(f"{v}% {k.lower()}" for v, k in mesures[:3])


async def cloudflare(page):
    await page.goto("https://www.scrapingcourse.com/cloudflare-challenge", wait_until="domcontentloaded")
    for _ in range(30):
        t = await texte(page)
        if re.search(r"bypassed the Cloudflare", t, re.I):
            return "passe", "défi franchi"
        await page.wait_for_timeout(1000)
    titre = await page.title()
    return "bloqué", f"toujours sur « {titre[:40]} » après 30 s"


async def google(page):
    await page.goto("https://www.google.com/search?q=meteo+paris&hl=fr", wait_until="load")
    if "consent." in page.url:
        await cliquer_texte(page, r"tout refuser|reject all")
    await page.wait_for_timeout(2000)
    t = await texte(page)
    if "/sorry/" in page.url or re.search(r"trafic exceptionnel|unusual traffic", t, re.I):
        return "bloqué", "page « trafic exceptionnel » (/sorry)"
    n = await page.locator("#search a h3").count()
    if n:
        return "passe", f"{n} résultats"
    return "incertain", f"aucun résultat lisible ({page.url[:60]})"


async def x_profil(page):
    await page.goto("https://x.com/NASA", wait_until="domcontentloaded")
    await page.wait_for_timeout(10000)
    t = await texte(page)
    if re.search(r"Something went wrong|Un problème est survenu|Une erreur s'est produite", t, re.I):
        return "bloqué", "« un problème est survenu »"
    n = await page.locator("article").count()
    if n:
        return "passe", f"{n} posts visibles sans compte"
    if re.search(r"Se connecter|Log in|Sign in|Inscrivez-vous|Sign up", t):
        return "incertain", "mur de connexion, aucun post"
    return "incertain", "page vide"


async def linkedin(page):
    rep = await page.goto("https://www.linkedin.com/in/williamhgates", wait_until="domcontentloaded")
    await page.wait_for_timeout(4000)
    if rep and rep.status == 999:
        return "bloqué", "code 999 (refus des robots)"
    if re.search(r"authwall|checkpoint|/login|/signup", page.url):
        return "bloqué", "mur de connexion (" + page.url.split("?")[0][-40:] + ")"
    h1 = page.locator("h1")
    if await h1.count():
        return "passe", "profil public lu : " + (await h1.first.inner_text())[:40]
    return "incertain", "ni profil ni mur"


async def amazon(page):
    await page.goto("https://www.amazon.fr/s?k=clavier+sans+fil", wait_until="load")
    await page.wait_for_timeout(2000)
    if await page.locator("#sp-cc-rejectall-link").count():
        await page.locator("#sp-cc-rejectall-link").click()
        await page.wait_for_timeout(1500)
    html = await page.content()
    if "validateCaptcha" in html or "/errors/validateCaptcha" in page.url:
        return "bloqué", "captcha"
    if re.search(r"Toutes nos excuses|Sorry! Something went wrong", await texte(page)):
        return "bloqué", "page « Toutes nos excuses » (refus déguisé en erreur)"
    n = await page.locator('[data-component-type="s-search-result"]').count()
    if n:
        return "passe", f"{n} produits"
    return "incertain", "aucun produit lisible"


TACHES = {f.__name__: f for f in (sannysoft, creepjs, cloudflare, google, x_profil, linkedin, amazon)}


# --- Déroulé ---------------------------------------------------------------------------------------------------------

def adresse():
    """Adresse publique de la machine, son fuseau et son hébergeur : c'est la première chose que voit un site."""
    try:
        req = urllib.request.Request("https://ipinfo.io/json", headers={"user-agent": UA})
        d = json.load(urllib.request.urlopen(req, timeout=15))
        return {k: d.get(k) for k in ("country", "city", "org", "timezone")}
    except Exception as e:
        return {"erreur": str(e)[:80]}


IP = {}


def version(paquet):
    try:
        return metadata.version(paquet)
    except metadata.PackageNotFoundError:
        return "absent"


async def passage(moteur, n, taches, sortie):
    lignes = []
    try:
        async with MOTEURS[moteur]() as page:
            for nom in taches:
                t0 = time.monotonic()
                try:
                    verdict, detail = await asyncio.wait_for(TACHES[nom](page), TASK_S)
                except asyncio.TimeoutError:
                    verdict, detail = "bloqué", f"rien après {TASK_S} s"
                except Exception as e:
                    verdict, detail = "erreur", f"{type(e).__name__} : {str(e)[:100]}"
                duree = round(time.monotonic() - t0, 1)
                try:
                    await page.screenshot(path=str(sortie / f"{moteur}-{n}-{nom}.png"), timeout=10000)
                except Exception:
                    pass
                print(f"  {moteur} #{n} {nom:<11} {verdict:<9} {duree:>5} s  {detail}", flush=True)
                lignes.append({"moteur": moteur, "passage": n, "tache": nom, "verdict": verdict,
                               "detail": detail, "secondes": duree})
                await asyncio.sleep(random.uniform(4, 9))
    except Exception as e:
        print(f"  {moteur} #{n} : le navigateur ne démarre pas : {e}", flush=True)
        lignes += [{"moteur": moteur, "passage": n, "tache": t, "verdict": "erreur",
                    "detail": f"démarrage : {str(e)[:100]}", "secondes": 0} for t in taches]
    return lignes


def rapport(info, lignes, moteurs, taches):
    md = ["# Banc anti-robot", "",
          f"Machine : {info['machine']}, adresse {info['adresse']}.",
          f"Versions : {info['versions']}.", f"Passages par moteur : {info['passages']}.", "",
          "Chaque case : passages réussis / total, puis le temps moyen. Le détail du dernier passage suit.", "",
          "| Tâche | " + " | ".join(moteurs) + " |", "|---|" + "---|" * len(moteurs)]
    for t in taches:
        cases = []
        for m in moteurs:
            r = [l for l in lignes if l["moteur"] == m and l["tache"] == t]
            ok = sum(l["verdict"] in ("passe", "mesure") for l in r)
            moy = round(sum(l["secondes"] for l in r) / len(r), 1) if r else 0
            der = r[-1] if r else {"verdict": "?", "detail": ""}
            cases.append(f"{ok}/{len(r)} en {moy} s — {der['verdict']} : {der['detail'][:60].replace(chr(10), ' ').replace('|', '/')}")
        md.append(f"| {t} | " + " | ".join(cases) + " |")
    md += ["", "Verdicts : passe ; bloqué ; signalé (la page voit un robot sans bloquer) ; mesure (chiffre à lire) ;"
           " incertain (à regarder sur la capture) ; erreur (le banc ou le navigateur a échoué)."]
    return "\n".join(md) + "\n"


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--moteurs", default=",".join(MOTEURS))
    ap.add_argument("--passages", type=int, default=2)
    ap.add_argument("--taches", default=",".join(TACHES))
    ap.add_argument("--sortie", default="/out")
    a = ap.parse_args()
    moteurs = [m for m in a.moteurs.split(",") if m in MOTEURS]
    taches = [t for t in a.taches.split(",") if t in TACHES]
    sortie = Path(a.sortie)
    sortie.mkdir(parents=True, exist_ok=True)

    IP.update(adresse())
    info = {
        "machine": f"{platform.system()} {platform.machine()}",
        "adresse": ", ".join(f"{k} {v}" for k, v in IP.items() if v),
        "versions": ", ".join(f"{p} {version(p)}" for p in ("playwright", "patchright", "camoufox")),
        "passages": a.passages,
    }
    print(f"Banc anti-robot : {info['machine']}, {info['adresse']}", flush=True)
    lignes = []
    # Moteur par moteur, passage par passage : un seul navigateur ouvert à la fois, pour ne pas peser sur le VPS.
    for n in range(1, a.passages + 1):
        for m in moteurs:
            lignes += await passage(m, n, taches, sortie)
    (sortie / "resultats.json").write_text(json.dumps({"info": info, "lignes": lignes}, ensure_ascii=False, indent=1))
    md = rapport(info, lignes, moteurs, taches)
    (sortie / "resultats.md").write_text(md)
    print("\n" + md)


if __name__ == "__main__":
    asyncio.run(main())
