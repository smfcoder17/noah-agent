"""Évalue le routeur « Automatique » sur les cas de référence (routing/cases.json).

Usage, dans le conteneur du serveur : python -m noah.routing_eval [image|video|music]
Chaque cas coûte un appel au modèle rapide (une fraction de centime).
"""
import asyncio
import json
import sys
from pathlib import Path

from . import media

CASES = json.loads((Path(__file__).parent / "routing" / "cases.json").read_text(encoding="utf-8"))


async def evaluate(kind: str) -> tuple[int, int]:
    ms = {m["id"]: m for m in await media.models(kind)}
    ok = 0
    cases = CASES.get(kind, [])
    for case in cases:
        d = await media.route(kind, case["demande"])
        good = d["methode"] == case["methode"]
        if good and case["methode"] == "generation" and case.get("tags"):
            strengths = set((ms.get(d["modele"]) or {}).get("strengths", []))
            good = bool(strengths & set(case["tags"]))
        ok += good
        mark = "ok " if good else "RATÉ"
        print(f"{mark} [{case['methode']:>10} → {d['methode']:>10}] {d.get('modele') or '':<40} {case['demande'][:70]}")
        if not good:
            print(f"       raison : {d['raison']}")
    return ok, len(cases)


async def main() -> None:
    kinds = sys.argv[1:] or ["image", "video", "music"]
    total = passed = 0
    for kind in kinds:
        ok, n = await evaluate(kind)
        print(f"== {kind} : {ok}/{n}")
        passed, total = passed + ok, total + n
    print(f"== total : {passed}/{total} ({100 * passed // max(total, 1)} %)")


if __name__ == "__main__":
    asyncio.run(main())
