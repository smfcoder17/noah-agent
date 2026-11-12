"""Crée un skill exactement comme l'agent le fait : par l'outil d'Hermes, avec un frontmatter YAML.

    /opt/hermes/.venv/bin/python /tmp/probe.py /tmp/probe.json
"""
import json
import sys

from tools.skill_manager_tool import skill_manage

body = json.load(open(sys.argv[1], encoding="utf-8"))
print(skill_manage(action="create", name=body["name"], content=body["content"]))
