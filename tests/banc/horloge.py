"""Pilote le fichier libfaketime commun, depuis un processus à l'heure réelle.

Un décalage relatif donne la même heure aux processus démarrés à des instants
différents. Le dossier est monté (pas son fichier : les écritures sont atomiques).
"""
import argparse
import math
import os
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path


def lire(fichier):
    try:
        return float(Path(fichier).read_text(encoding="ascii").strip())
    except FileNotFoundError:
        return 0.0


def ecrire(fichier, decalage):
    if not math.isfinite(decalage):
        raise ValueError("Décalage non fini")
    fichier = Path(fichier)
    fichier.parent.mkdir(parents=True, exist_ok=True)
    tmp = fichier.with_suffix(".tmp")
    tmp.write_text(f"{decalage:+.6f}\n", encoding="ascii")
    tmp.replace(fichier)
    return decalage


def avancer(fichier, secondes):
    if not math.isfinite(secondes) or secondes < 0:
        raise ValueError("L'horloge ne recule pas")
    return ecrire(fichier, lire(fichier) + secondes)


@contextmanager
def pilote(fichier):
    """Un seul écrivain CLI, même entre conteneurs (PID purement indicatif)."""
    verrou = Path(str(fichier) + ".pid")
    verrou.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(verrou, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        raise ValueError(f"Un pilote possède déjà l'horloge : {verrou}. Après un arrêt brutal, vérifier son arrêt avant de retirer ce verrou.") from None
    try:
        with os.fdopen(fd, "w", encoding="ascii") as stream:
            stream.write(str(os.getpid()))
        yield
    finally:
        verrou.unlink()


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fichier", type=Path)
    choix = parser.add_mutually_exclusive_group(required=True)
    choix.add_argument("--avancer", type=float, metavar="SECONDES")
    choix.add_argument("--fixer", help="Date ISO avec fuseau, par exemple 2026-11-09T09:00:00Z")
    choix.add_argument("--vitesse", type=float, help="60 : une heure simulée par minute réelle ; un seul pilote")
    choix.add_argument("--initialiser", action="store_true")
    args = parser.parse_args(argv)
    if os.environ.get("LD_PRELOAD") or os.environ.get("FAKETIME"):
        parser.error("Le pilote doit tourner sans libfaketime")
    try:
        with pilote(args.fichier):
            executer(args, parser)
    except ValueError as e:
        parser.error(str(e))


def executer(args, parser):
    if args.initialiser:
        if not args.fichier.exists():
            ecrire(args.fichier, 0)
    elif args.fixer:
        date = datetime.fromisoformat(args.fixer.replace("Z", "+00:00"))
        if date.tzinfo is None:
            parser.error("La date doit porter un fuseau")
        ecrire(args.fichier, date.timestamp() - time.time())
    elif args.avancer is not None:
        avancer(args.fichier, args.avancer)
    else:
        if not math.isfinite(args.vitesse) or args.vitesse < 1:
            parser.error("La vitesse doit être finie et au moins égale à 1")
        debut, decalage = time.monotonic(), lire(args.fichier)
        try:
            while True:
                ecrire(args.fichier, decalage + (time.monotonic() - debut) * (args.vitesse - 1))
                time.sleep(0.1)
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
