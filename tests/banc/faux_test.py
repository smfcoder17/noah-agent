"""Tests des faux sur sockets locales : ressources, mutations et traces durables."""
import base64
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import ProxyHandler, Request, build_opener

import faux_github
import faux_google
import horloge
import lanceur_banc
from http_local import Handler, Serveur
from lanceur_banc import options_agent
from support_test import appeler, servir

AUTH = {"Authorization": "Bearer " + faux_google.TOKEN}
RAW = base64.urlsafe_b64encode(b"From: alice@example.test\r\nTo: bob@example.test\r\nSubject: Urgent\r\n\r\nBonjour").decode().rstrip("=")
EVENT = {"id": "rendezvous", "summary": "Revue", "start": {"dateTime": "2026-11-10T10:00:00+01:00"},
         "end": {"dateTime": "2026-11-10T11:00:00+01:00"}}


class GoogleTest(unittest.TestCase):
    def setUp(self):
        self.contexte = servir(faux_google.creer)
        self.base, self.serveur = self.contexte.__enter__()
        self.addCleanup(self.contexte.__exit__, None, None, None)

    def api(self, chemin, body=None, method=None):
        code, resultat, _ = appeler(self.base, chemin, body, method, AUTH)
        self.assertEqual(code, 200, resultat)
        return resultat

    def test_courriel_lecture_filtrage_et_labels(self):
        self.api("/__injecter", {"courriel": {"id": "m1", "raw": RAW}})
        messages = faux_google.GMAIL + "messages"
        self.assertEqual(self.api(messages + "?q=in:inbox+is:unread+from:alice")['messages'], [{"id": "m1", "threadId": "m1"}])
        self.assertEqual(self.api(messages + "?q=subject:absent")["messages"], [])
        msg = self.api(messages + "/m1?format=metadata&metadataHeaders=From&metadataHeaders=Subject")
        self.assertEqual([h["name"] for h in msg["payload"]["headers"]], ["From", "Subject"])
        self.assertNotIn("raw", msg)
        self.assertEqual(self.api(messages + "/m1?format=raw")["raw"], RAW)
        self.api(messages + "/m1/modify", {"removeLabelIds": ["INBOX", "UNREAD"], "addLabelIds": ["IMPORTANT"]})
        self.assertEqual(self.api(messages + "?q=in:inbox")["messages"], [])
        self.assertEqual(self.api(messages + "/m1")["labelIds"], ["IMPORTANT"])
        self.assertEqual(appeler(self.base, messages + "/absent", headers=AUTH)[0], 404)

    def test_brouillons_envois_et_journal(self):
        drafts = faux_google.GMAIL + "drafts"
        draft = self.api(drafts, {"message": {"raw": RAW}})
        self.assertEqual(self.api(drafts)["drafts"][0]["message"], {k: draft["message"][k] for k in ("id", "threadId")})
        self.api(drafts + "/send", {"id": draft["id"]})
        self.api(faux_google.GMAIL + "messages/send", {"raw": RAW})
        etat = self.api("/__etat")
        self.assertEqual(etat["brouillons"], {})
        self.assertEqual(len(etat["envois"]), 2)
        self.assertEqual(etat["envois"][0]["payload"]["body"]["data"], base64.urlsafe_b64encode(b"Bonjour").decode().rstrip("="))
        self.assertEqual([(e["methode"], e["chemin"]) for e in etat["journal"]],
                         [("POST", drafts), ("GET", drafts), ("POST", drafts + "/send"),
                          ("POST", faux_google.GMAIL + "messages/send"), ("GET", "/__etat")])

    def test_calendar_fenetre_insert_patch_et_calendrier(self):
        events = faux_google.AGENDA + "primary/events"
        self.api("/__injecter", {"evenement": EVENT})
        self.api(events, EVENT | {"id": "autre"})
        self.api(events + "/rendezvous", {"summary": "Déplacé", "start": {"dateTime": "2026-11-11T10:00:00+01:00"},
                                          "end": {"dateTime": "2026-11-11T11:00:00+01:00"}}, "PATCH")
        items = self.api(events + "?timeMin=2026-11-10T00:00:00Z&timeMax=2026-11-11T00:00:00Z&orderBy=startTime")["items"]
        self.assertEqual([e["id"] for e in items], ["autre"])
        self.assertEqual(self.api(faux_google.AGENDA + "secondaire/events")["items"], [])
        self.assertEqual(self.api("/__etat")["evenements"]["primary"]["rendezvous"]["summary"], "Déplacé")

    def test_pagination_et_etat_isole(self):
        for i in range(3):
            self.api("/__injecter", {"courriel": {"id": str(i), "raw": RAW}})
        first = self.api(faux_google.GMAIL + "messages?maxResults=2")
        self.assertEqual(first["nextPageToken"], "2")
        self.assertEqual(len(self.api(faux_google.GMAIL + "messages?maxResults=2&pageToken=2")["messages"]), 1)
        with servir(faux_google.creer) as (autre, _):
            self.assertEqual(appeler(autre, "/__etat")[1]["messages"], {})

    def test_auth_et_injection_erreur_une_fois(self):
        path = faux_google.GMAIL + "messages"
        code, error, _ = appeler(self.base, path)
        self.assertEqual((code, error["error"]["errors"][0]["reason"]), (401, "authError"))
        self.api("/__injecter", {"erreur": {"code": 429, "chemin": path}})
        self.assertEqual(appeler(self.base, path, headers=AUTH)[0], 429)
        self.api(path)
        self.assertEqual([e["statut"] for e in self.api("/__etat")["journal"][:-1]], [401, 200, 429, 200])


class GitHubTest(unittest.TestCase):
    def setUp(self):
        self.contexte = servir(faux_github.creer)
        self.base, self.serveur = self.contexte.__enter__()
        self.addCleanup(self.contexte.__exit__, None, None, None)
        code, result, headers = appeler(self.base, "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": faux_github.PROTOCOL}})
        self.assertEqual(code, 200)
        self.headers = {"Mcp-Session-Id": headers["Mcp-Session-Id"]}
        self.assertEqual(result["result"]["protocolVersion"], faux_github.PROTOCOL)

    def rpc(self, methode, params=None):
        code, result, _ = appeler(self.base, "/mcp", {"jsonrpc": "2.0", "id": 2, "method": methode, "params": params or {}}, headers=self.headers)
        self.assertEqual(code, 200)
        return result

    def tool(self, nom, args):
        result = self.rpc("tools/call", {"name": nom, "arguments": args})["result"]
        self.assertFalse(result.get("isError"), result)
        text = result["content"][0]["text"]
        return text if args.get("method") == "get_diff" else json.loads(text)

    def test_pr_diff_commentaires_notifications(self):
        repo = {"owner": "equipe", "repo": "projet"}
        body = repo | {"pr": {"number": 40, "title": "Correction critique"}, "diff": "diff --git a/x b/x\n+correction"}
        self.assertEqual(appeler(self.base, "/__injecter", body)[0], 200)
        self.assertEqual(self.tool("list_pull_requests", repo)[0]["number"], 40)
        args = repo | {"pullNumber": 40}
        self.assertEqual(self.tool("pull_request_read", args | {"method": "get"})["title"], "Correction critique")
        self.assertEqual(self.tool("pull_request_read", args | {"method": "get_diff"}), body["diff"])
        self.tool("add_issue_comment", repo | {"issue_number": 40, "body": "Analyse"})
        self.assertEqual(self.tool("pull_request_read", args | {"method": "get_comments"})[0]["body"], "Analyse")
        self.assertEqual(self.tool("list_notifications", repo)[0]["subject"]["type"], "PullRequest")
        self.assertEqual(self.tool("get_notification_details", {"notificationID": "40"})["reason"], "review_requested")
        etat = appeler(self.base, "/__etat")[1]
        self.assertEqual(len(etat["commentaires"]), 1)
        self.assertEqual([e["arguments"]["body"] for e in etat["journal"] if e.get("outil") == "add_issue_comment"], ["Analyse"])

    def test_sessions_notifications_et_erreurs(self):
        code, result, _ = appeler(self.base, "/mcp", {"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=self.headers)
        self.assertEqual((code, result), (202, None))
        self.assertEqual(appeler(self.base, "/mcp", {"jsonrpc": "2.0", "id": 2, "method": "tools/list"})[0], 404)
        self.assertEqual(self.rpc("inconnue")["error"]["code"], -32601)
        self.assertEqual(self.rpc("tools/call", {"name": "inconnu"})["error"]["code"], -32602)
        self.assertTrue(self.rpc("tools/call", {"name": "list_pull_requests", "arguments": {}})["result"]["isError"])
        self.assertEqual(self.rpc("tools/call", "invalide")["error"]["code"], -32602)

    def test_initialize_refuse_versions_absentes_ou_incompatibles_sans_session(self):
        nombre = len(self.serveur.etat["sessions"])
        for params in (None, {}, {"protocolVersion": "1900-01-01"}, {"protocolVersion": 123}, []):
            with self.subTest(params=params):
                code, result, headers = appeler(self.base, "/mcp", {"jsonrpc": "2.0", "id": 3, "method": "initialize", "params": params})
                self.assertEqual((code, result["error"]["code"]), (200, -32602))
                self.assertIn(faux_github.PROTOCOL, result["error"]["message"])
                self.assertNotIn("Mcp-Session-Id", headers)
                self.assertEqual(len(self.serveur.etat["sessions"]), nombre)

    def test_json_malforme_donne_erreur_rpc_et_reste_journalise(self):
        req = Request(self.base + "/mcp", data=b'{invalide', headers={"Content-Type": "application/json", **self.headers})
        with self.assertRaises(HTTPError) as erreur:
            build_opener(ProxyHandler({})).open(req, timeout=3)
        with erreur.exception as response:
            self.assertEqual(json.load(response)["error"]["code"], -32700)
        self.assertEqual(appeler(self.base, "/__etat")[1]["journal"][-2]["statut"], 400)

    def test_filtres_pagination_et_reinjection(self):
        repo = {"owner": "equipe", "repo": "projet"}
        for i in range(1, 4):
            appeler(self.base, "/__injecter", repo | {"pr": {"number": i, "state": "closed" if i == 3 else "open"}})
        self.assertEqual(len(self.tool("list_pull_requests", repo)), 2)
        self.assertEqual(len(self.tool("list_pull_requests", repo | {"state": "all", "perPage": 2, "page": 2})), 1)
        self.assertEqual(self.tool("list_pull_requests", {"owner": "autre", "repo": "projet"}), [])
        appeler(self.base, "/__injecter", repo | {"pr": {"number": 1}})
        self.assertEqual(len(self.tool("list_notifications", {})), 3)


class HorlogeTest(unittest.TestCase):
    def test_un_seul_pilote_y_compris_avance_manuelle_et_liberation(self):
        with tempfile.TemporaryDirectory() as tmp, patch.dict("os.environ", {}, clear=True):
            fichier = Path(tmp) / "temps.rc"
            # Le premier --vitesse tient le verrou ; le second et une avance
            # manuelle doivent échouer avant de modifier le fichier partagé.
            def concurrent(_):
                contenu = fichier.read_text()
                for args in (("--vitesse", "60"), ("--avancer", "1")):
                    diagnostic = io.StringIO()
                    with contextlib.redirect_stderr(diagnostic), self.assertRaises(SystemExit) as e:
                        horloge.main([str(fichier), *args])
                    self.assertEqual(e.exception.code, 2)
                    self.assertIn("Un pilote possède déjà l'horloge", diagnostic.getvalue())
                    self.assertEqual(fichier.read_text(), contenu)
                raise KeyboardInterrupt
            with patch.object(horloge.time, "sleep", side_effect=concurrent):
                horloge.main([str(fichier), "--vitesse", "60"])
            self.assertFalse(Path(str(fichier) + ".pid").exists())
            horloge.main([str(fichier), "--avancer", "1"])

    def test_lanceur_refuse_volume_absent_des_le_demarrage(self):
        for volume in (None, "", "   "):
            env = {"NOAH_BANC": "1"}
            if volume is not None:
                env["NOAH_BANC_HORLOGE_VOLUME"] = volume
            with self.subTest(volume=volume), patch.dict("os.environ", env, clear=True):
                with self.assertRaisesRegex(RuntimeError, "NOAH_BANC_HORLOGE_VOLUME.*volume d'horloge"):
                    lanceur_banc.main()  # avant même d'importer Docker ou uvicorn

    def test_fichier_commun_avance_et_reste_lisible(self):
        with tempfile.TemporaryDirectory() as tmp:
            fichier = Path(tmp) / "temps.rc"
            self.assertEqual(horloge.lire(fichier), 0)
            horloge.ecrire(fichier, 10)
            horloge.avancer(fichier, 3600)
            self.assertEqual(horloge.lire(fichier), 3610)
            self.assertEqual(fichier.read_text(), "+3610.000000\n")
            with self.assertRaises(ValueError):
                horloge.avancer(fichier, -1)
            with self.assertRaises(ValueError):
                horloge.ecrire(fichier, float("nan"))

    def test_agents_dynamiques_partagent_volume_et_base(self):
        original = {"labels": {"noah.agent": "rita"}, "volumes": {"data": {"bind": "/opt/data"}}, "environment": {"API_SERVER_ENABLED": "true"}}
        with patch.dict("os.environ", {"NOAH_BANC_HORLOGE_VOLUME": "volume-commun"}):
            result = options_agent(original)
        self.assertEqual(result["volumes"]["volume-commun"], {"bind": "/banc-horloge", "mode": "ro"})
        self.assertEqual(result["environment"]["NOAH_GOOGLE_BASE"], "http://faux-google:8081")
        self.assertNotIn("NOAH_BANC", original["environment"])
        self.assertEqual(options_agent({"labels": {"noah.browser": "rita"}}), {"labels": {"noah.browser": "rita"}})


class TransportTest(unittest.TestCase):
    def test_bug_interne_repond_500_journalise_et_serveur_reste_disponible(self):
        class Casse(Handler):
            def traiter(self, chemin, query, body):
                if chemin == "/bug":
                    raise RuntimeError("bug interne")
                return 200, self.server.etat, {}
        with servir(lambda: Serveur(("127.0.0.1", 0), Casse, {"journal": []})) as (base, _):
            code, result, _ = appeler(base, "/bug")
            self.assertEqual((code, result), (500, {"erreur": "Erreur interne du faux"}))
            code, etat, _ = appeler(base, "/__etat")
            self.assertEqual(code, 200)
            self.assertEqual(etat["journal"][0], {"methode": "GET", "chemin": "/bug", "statut": 500, "erreur_interne": "RuntimeError"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
