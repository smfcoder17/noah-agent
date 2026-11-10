"""Adaptateur réservé à la pile de test : horloge et faux Google dans les agents.

Le lanceur de production reste inchangé. L'agent est créé à la demande par son
SDK Docker, il ne figure donc pas comme service fixe dans Compose.
"""
import os
import sys


def options_agent(options):
    if "noah.agent" not in (options.get("labels") or {}):
        return options
    options = dict(options)
    options["environment"] = {**options.get("environment", {}), "NOAH_BANC": "1",
                              "NOAH_GOOGLE_BASE": "http://faux-google:8081",
                              "FAKETIME_TIMESTAMP_FILE": "/banc-horloge/temps.rc",
                              "FAKETIME_NO_CACHE": "1", "FAKETIME_DONT_FAKE_MONOTONIC": "1"}
    options["volumes"] = {**options.get("volumes", {}), os.environ["NOAH_BANC_HORLOGE_VOLUME"]:
                          {"bind": "/banc-horloge", "mode": "ro"}}
    return options


def main():
    if os.environ.get("NOAH_BANC") != "1":
        raise RuntimeError("Ce lanceur est réservé au banc")
    if not os.environ.get("NOAH_BANC_HORLOGE_VOLUME", "").strip():
        raise RuntimeError("NOAH_BANC_HORLOGE_VOLUME doit nommer le volume d'horloge commun du banc")
    from docker.models.containers import ContainerCollection
    import uvicorn
    create = ContainerCollection.create

    def creer(self, image, *args, **kwargs):
        return create(self, image, *args, **options_agent(kwargs))

    ContainerCollection.create = creer
    sys.path.insert(0, "/app")
    uvicorn.run("launcher:app", host="0.0.0.0", port=9000)


if __name__ == "__main__":
    main()
