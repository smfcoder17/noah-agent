"""Contrats hors réseau : manifeste MCP figé, vrais lecteurs Noah, mêmes erreurs.

L'erreur Google de référence est une HTTPError injectée au transport du vrai
_google_get, sans joindre Google. La même fonction lit ensuite le faux par HTTP.

Le test MCP est limité à la logique de session (_open, _request, list_tools)
extraite du code Noah : initialisation, conservation et reprise après perte.
Son transport et ses constantes sont des doublures. Il ne prouve ni les
en-têtes du transport httpx réel, ni ses codes HTTP, son résolveur ou ses délais.
"""
import ast
import asyncio
import io
import json
import os
import socket
import tempfile
import types
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError

import faux_github
import faux_google
from support_test import RACINE, appeler, charger_admin, echec_google, servir
from http_local import Handler, Serveur

ADMIN = charger_admin()
GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me/messages"
AGENDA = "https://www.googleapis.com/calendar/v3/calendars/primary/events"


class ConformiteTest(unittest.TestCase):
    def test_tools_list_egale_manifeste_fige(self):
        manifeste = json.loads((Path(__file__).parent / "manifestes/github.json").read_text(encoding="utf-8"))
        self.assertEqual(manifeste["fige_le"], "2026-11-09")
        with servir(faux_github.creer) as (base, _):
            _, _, headers = appeler(base, "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize",
                                                   "params": {"protocolVersion": faux_github.PROTOCOL}})
            _, result, _ = appeler(base, "/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                                  headers={"Mcp-Session-Id": headers["Mcp-Session-Id"]})
        self.assertEqual(result["result"]["tools"], manifeste["tools"])
        self.assertEqual({t["name"] for t in manifeste["tools"]},
                         {"list_pull_requests", "pull_request_read", "add_issue_comment", "list_notifications", "get_notification_details"})

    def test_logique_session_mcp_extraite_avec_doublures(self):
        # Portée volontairement limitée, voir l'en-tête ; aucun test de _post.
        source = RACINE / "server/noah/mcp.py"
        tree = ast.parse(source.read_text(encoding="utf-8"))
        names = {"_open", "_request", "list_tools"}
        tree.body = [n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name in names]
        self.assertEqual({n.name for n in tree.body}, names, "Les fonctions de session ont changé : revoir ce test limité")
        class Down(Exception):
            pass
        class SessionLost(Exception):
            pass
        with servir(faux_github.creer) as (base, serveur):
            async def post(url, token, payload, session, seconds):
                headers = {"Mcp-Session-Id": session} if session else {}
                code, response, result_headers = await asyncio.to_thread(appeler, base, "/mcp", payload, None, headers)
                if code == 404 and session:
                    raise SessionLost()
                self.assertIn(code, (200, 202), response)
                return response, result_headers.get("Mcp-Session-Id") or session
            client = {"PROTOCOL": faux_github.PROTOCOL, "LIST_SECONDS": 15, "_sessions": {}, "_post": post,
                      "Down": Down, "SessionLost": SessionLost, "AuthNeeded": type("AuthNeeded", (Exception,), {}),
                      "Refused": type("Refused", (Exception,), {}), "publication": types.SimpleNamespace(ours=lambda url: False)}
            exec(compile(tree, str(source), "exec"), client)
            async def cycle():
                outils = await client["list_tools"](("banc", "github"), base + "/mcp", None)
                self.assertEqual(outils, faux_github.TOOLS)
                serveur.etat["sessions"].clear()
                self.assertEqual(await client["list_tools"](("banc", "github"), base + "/mcp", None), outils)
                return await client["_request"](("banc", "github"), base + "/mcp", None, "tools/call",
                                               {"name": "list_pull_requests", "arguments": {"owner": "x", "repo": "y"}}, 3)
            result = asyncio.run(cycle())
            self.assertEqual(json.loads(result["result"]["content"][0]["text"]), [])

    def test_erreurs_google_identiques_au_vrai_lecteur(self):
        attendu = {401: "Google refuse cette lecture : l'accès n'est pas coché dans Détails → Connexions.",
                   403: "Google refuse cette lecture : l'accès n'est pas coché dans Détails → Connexions.",
                   429: "Google répond 429."}
        with servir(faux_google.creer) as (base, _):
            for code in attendu:
                with self.subTest(code=code):
                    with patch.dict(os.environ, {}, clear=True), patch("urllib.request.urlopen", side_effect=HTTPError(GMAIL, code, "Google", {}, io.BytesIO(b"{}"))):
                        reference = echec_google(lambda: ADMIN._google_get(GMAIL, "reference-non-envoyee"))
                    appeler(base, "/__injecter", {"erreur": {"code": code, "chemin": "/gmail/"}})
                    with patch.dict(os.environ, {"NOAH_BANC": "1", "NOAH_GOOGLE_BASE": base}, clear=True):
                        faux = echec_google(lambda: ADMIN._google_get(GMAIL, faux_google.TOKEN))
                    self.assertEqual(faux, reference)
                    self.assertEqual(faux, attendu[code])

    def test_vraies_lectures_gmail_agenda_et_renouvellement(self):
        with servir(faux_google.creer) as (base, _), tempfile.TemporaryDirectory() as tmp:
            token = {"token": faux_google.TOKEN, "refresh_token": faux_google.REFRESH_TOKEN,
                     "client_id": "noah-banc-client", "client_secret": "noah-banc-secret",
                     "token_uri": "https://oauth2.googleapis.com/token", "expiry": "2000-01-01T00:00:00Z"}
            token_file = Path(tmp) / "google_token.json"
            token_file.write_text(json.dumps(token), encoding="utf-8")
            appeler(base, "/__injecter", {"courriel": {"id": "urgent", "snippet": "À traiter",
                    "payload": {"headers": [{"name": "From", "value": "alice@example.test"}, {"name": "Subject", "value": "Urgent"}]}}})
            now = datetime.now(timezone.utc)
            appeler(base, "/__injecter", {"evenement": {"id": "revue", "summary": "Revue", "start": {"dateTime": (now + timedelta(hours=1)).isoformat()},
                                                                   "end": {"dateTime": (now + timedelta(hours=2)).isoformat()}}})
            with patch.dict(os.environ, {"NOAH_BANC": "1", "NOAH_GOOGLE_BASE": base}, clear=True), patch.object(ADMIN, "DATA", Path(tmp)):
                gmail = ADMIN.source_google({"service": "gmail"})
                self.assertEqual(gmail["cles"], ["urgent"])
                self.assertIn("Urgent", gmail["elements"][0]["titre"])
                self.assertEqual(ADMIN.source_google({"service": "gmail", "connus": ["urgent"]})["elements"], [])
                self.assertEqual(ADMIN.source_google({"service": "agenda"})["elements"][0]["titre"], "Revue")
            self.assertEqual(json.loads(token_file.read_text())["token"], faux_google.TOKEN)
            expiry = datetime.fromisoformat(json.loads(token_file.read_text())["expiry"].replace("Z", "+00:00"))
            self.assertGreater(expiry, now + timedelta(minutes=58))
            self.assertLess(expiry, datetime.now(timezone.utc) + timedelta(minutes=60))
            journal = appeler(base, "/__etat")[1]["journal"]
            self.assertEqual(sum(e["chemin"] == "/token" for e in journal), 1)
            self.assertTrue(any(e["chemin"].startswith("/calendar/v3/") for e in journal))


class GardeGoogleTest(unittest.TestCase):
    def test_toutes_les_fonctions_google_refusent_un_faux_jeton_avant_reseau(self):
        # Inventaire du fichier entier : toute nouvelle voie vers le transport
        # Google impose d'ajouter son invocation ici, même hors de la plage initiale.
        tree = ast.parse((RACINE / "launcher/agent_admin.py").read_text(encoding="utf-8"))
        functions = {n.name: n for n in tree.body if isinstance(n, ast.FunctionDef)}
        calls = {name: {n.func.id for n in ast.walk(fn) if isinstance(n, ast.Call) and isinstance(n.func, ast.Name)}
                 for name, fn in functions.items()}
        voies = {"_google_open"}
        while True:
            expanded = voies | {name for name, targets in calls.items() if targets & voies}
            if expanded == voies:
                break
            voies = expanded
        cas = {"_google_get": lambda: ADMIN._google_get(GMAIL, faux_google.TOKEN),
               "_google_token": ADMIN._google_token,
               "_gmail": lambda: ADMIN._gmail(faux_google.TOKEN, "", set()),
               "_agenda": lambda: ADMIN._agenda(faux_google.TOKEN, 24),
               "source_google": lambda: ADMIN.source_google({"service": "gmail"}),
               "google_revoke": lambda: ADMIN.google_revoke({})}
        self.assertEqual(voies - {"_google_open"}, set(cas))
        # L'autre urlopen est le retour OAuth MCP local, pas un appel Google.
        urlopen = {name for name, fn in functions.items() if any(
            isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr == "urlopen"
            for n in ast.walk(fn))}
        self.assertEqual(urlopen, {"_google_open", "_finish_login"})
        hotes_google = {name for name, fn in functions.items() if any(
            isinstance(n, ast.Constant) and isinstance(n.value, str)
            and (".googleapis.com" in n.value or ".google.com" in n.value)
            for n in ast.walk(fn))}
        self.assertEqual(hotes_google, {"google_revoke", "_google_url", "_google_token", "_gmail", "_agenda"},
                         "Nouvel hôte Google dans une fonction : compléter l'inventaire et son test de garde")
        # La vérification Hermes --check peut accéder à Google : elle doit aussi
        # refuser le jeton avant de déléguer au sous-processus.
        cas["google"] = lambda: ADMIN.google(None)
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            setup = home / "setup.py"
            setup.touch()
            for drapeau in (None, "0", "true", "", "1"):
                env = {"NOAH_GOOGLE_BASE": "http://127.0.0.1:9999"} if drapeau != "1" else {"NOAH_BANC": "1"}
                if drapeau is not None:
                    env["NOAH_BANC"] = drapeau
                for fresh in (False, True):
                    token_file = home / "google_token.json"
                    token_file.write_text(json.dumps({"token": faux_google.TOKEN, "refresh_token": faux_google.REFRESH_TOKEN,
                        "expiry": "2999-01-01T00:00:00Z" if fresh else "2000-01-01T00:00:00Z"}), encoding="utf-8")
                    with patch.dict(os.environ, env, clear=True), patch.object(ADMIN, "DATA", home), patch.object(ADMIN, "GOOGLE", setup), \
                            patch("socket.create_connection") as socket_reseau, patch("urllib.request.urlopen") as reseau, \
                            patch.object(ADMIN.subprocess, "run") as processus:
                        for nom, fonction in cas.items():
                            with self.subTest(fonction=nom, drapeau=drapeau, frais=fresh):
                                self.assertIn("Un jeton du banc", echec_google(fonction))
                                self.assertTrue(token_file.exists(), "Le refus doit précéder le retrait local")
                        reseau.assert_not_called()
                        socket_reseau.assert_not_called()
                        processus.assert_not_called()

    def test_revocation_va_uniquement_au_faux_et_retirer_local_ne_contacte_personne(self):
        with servir(faux_google.creer) as (base, _), tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            token_file = home / "google_token.json"
            token_file.write_text(json.dumps({"token": faux_google.TOKEN, "refresh_token": faux_google.REFRESH_TOKEN}), encoding="utf-8")
            with patch.dict(os.environ, {"NOAH_BANC": "1", "NOAH_GOOGLE_BASE": base}, clear=True), \
                    patch.object(ADMIN, "DATA", home), patch.object(ADMIN, "GOOGLE", home / "absent"):
                self.assertEqual(ADMIN.google_revoke({}), {"disponible": False})
            self.assertFalse(token_file.exists())
            self.assertEqual([(e["methode"], e["chemin"]) for e in appeler(base, "/__etat")[1]["journal"]],
                             [("POST", "/revoke"), ("GET", "/__etat")])
            token_file.write_text(json.dumps({"token": faux_google.TOKEN}), encoding="utf-8")
            with patch.object(ADMIN, "DATA", home), patch.object(ADMIN, "GOOGLE", home / "absent"), \
                    patch.object(ADMIN, "_google_open") as reseau:
                ADMIN.google_revoke({"local": True})
                reseau.assert_not_called()

    def test_faux_jeton_jamais_envoye_sans_activation_exacte(self):
        for drapeau in (None, "0", "true", ""):
            env = {"NOAH_GOOGLE_BASE": "http://127.0.0.1:9999"}
            if drapeau is not None:
                env["NOAH_BANC"] = drapeau
            with self.subTest(drapeau=drapeau), patch.dict(os.environ, env, clear=True), patch("urllib.request.urlopen") as reseau:
                for url in (GMAIL, AGENDA):
                    self.assertIn("Un jeton du banc", echec_google(lambda: ADMIN._google_get(url, faux_google.TOKEN)))
                self.assertEqual(ADMIN._google_url(GMAIL, "jeton-normal"), GMAIL)
                reseau.assert_not_called()

    def test_renouvellement_factice_bloque_avant_tout_transport(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "google_token.json"
            for fresh in (False, True):
                path.write_text(json.dumps({"token": faux_google.TOKEN, "refresh_token": faux_google.REFRESH_TOKEN,
                                           "expiry": "2999-01-01T00:00:00Z" if fresh else "2000-01-01T00:00:00Z"}), encoding="utf-8")
                with patch.object(ADMIN, "DATA", Path(tmp)), patch.dict(os.environ, {}, clear=True), patch("urllib.request.urlopen") as reseau:
                    self.assertIn("Un jeton du banc", echec_google(ADMIN._google_token))
                    reseau.assert_not_called()

    def test_banc_sans_base_ou_base_publique_refuse(self):
        for base in ("", "https://gmail.googleapis.com", "http://8.8.8.8", "http://127.0.0.1/prefixe", "http://user@localhost", "http://169.254.169.254"):
            with self.subTest(base=base), patch.dict(os.environ, {"NOAH_BANC": "1", "NOAH_GOOGLE_BASE": base}, clear=True), patch("urllib.request.urlopen") as reseau:
                echec_google(lambda: ADMIN._google_get(GMAIL, faux_google.TOKEN))
                reseau.assert_not_called()

    def test_jeton_normal_hors_banc_garde_url_originale(self):
        with patch.dict(os.environ, {"NOAH_GOOGLE_BASE": "http://127.0.0.1:9999"}, clear=True), patch("urllib.request.urlopen") as reseau:
            reseau.return_value.__enter__.return_value = io.BytesIO(b'{"messages": []}')
            self.assertEqual(ADMIN._google_get(GMAIL, "jeton-normal"), {"messages": []})
            self.assertEqual(reseau.call_args.args[0].full_url, GMAIL)

    def test_redirection_du_faux_ne_fuit_pas_vers_google(self):
        class Redirection(Handler):
            def traiter(self, chemin, query, body):
                return 302, {}, {"Location": GMAIL}
        def fabrique():
            return Serveur(("127.0.0.1", 0), Redirection, {"journal": []})
        connexion = socket.create_connection
        def locale(adresse, *args, **kwargs):
            self.assertEqual(adresse[0], "127.0.0.1", "Une connexion hors du faux a été tentée")
            return connexion(adresse, *args, **kwargs)
        with servir(fabrique) as (base, _), patch.dict(os.environ, {"NOAH_BANC": "1", "NOAH_GOOGLE_BASE": base}, clear=True), patch("socket.create_connection", side_effect=locale):
            self.assertEqual(echec_google(lambda: ADMIN._google_get(GMAIL, faux_google.TOKEN)), "Google répond 302.")


if __name__ == "__main__":
    unittest.main(verbosity=2)
