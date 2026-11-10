"""Sous-ensemble Google HTTP du banc, en mémoire, sans dépendance ni réseau sortant.

Écart de fidélité : pageToken est un décalage entier propre au banc, alors que
Google émet un jeton opaque. Il ne doit pas être construit par les scénarios.

Formats (consultés le 2026-11-09) :
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts
https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/modify
https://developers.google.com/workspace/calendar/api/v3/reference/events
https://developers.google.com/workspace/calendar/api/v3/reference/events/list
https://developers.google.com/identity/protocols/oauth2/web-server#offline
https://developers.google.com/workspace/gmail/api/guides/handle-errors
"""
import base64
import copy
import re
import shlex
import time
from datetime import datetime, timezone
from email import policy
from email.parser import BytesParser
from urllib.parse import unquote
from zoneinfo import ZoneInfo

from http_local import Erreur, Handler, Serveur, lancer

TOKEN = "noah-banc-google-access"
REFRESH_TOKEN = "noah-banc-google-refresh"
GMAIL = "/gmail/v1/users/me/"
AGENDA = "/calendar/v3/calendars/"


def maintenant():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def date(valeur, fuseau="UTC"):
    result = datetime.fromisoformat(valeur.replace("Z", "+00:00"))
    if result.tzinfo is None:
        result = result.replace(tzinfo=timezone.utc if fuseau == "UTC" else ZoneInfo(fuseau))
    return result


def date_evenement(borne):
    return date(borne.get("dateTime") or borne["date"], borne.get("timeZone", "UTC"))


def message(raw, identifiant, labels):
    """Le corps reçu par drafts.create/messages.send est du RFC 2822 base64url."""
    data = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
    mime = BytesParser(policy=policy.default).parsebytes(data)
    part = mime.get_body(preferencelist=("plain", "html")) if mime.is_multipart() else mime
    texte = part.get_content() if part else ""
    contenu = texte.encode() if isinstance(texte, str) else texte
    return {"id": identifiant, "threadId": identifiant, "labelIds": labels,
            "snippet": str(texte)[:200], "historyId": str(time.time_ns()), "internalDate": str(int(time.time() * 1000)),
            "sizeEstimate": len(data), "raw": raw,
            "payload": {"partId": "", "mimeType": mime.get_content_type(), "filename": "",
                        "headers": [{"name": k, "value": v} for k, v in mime.items()],
                        "body": {"size": len(contenu), "data": base64.urlsafe_b64encode(contenu).decode().rstrip("=")}}}


def correspond(msg, query):
    headers = {h["name"].lower(): h["value"] for h in msg.get("payload", {}).get("headers", [])}
    texte = " ".join(headers.values()) + " " + msg.get("snippet", "")
    for terme in shlex.split(query):
        negatif = terme.startswith("-")
        terme = terme.lstrip("-")
        cle, sep, valeur = terme.partition(":")
        if cle in ("in", "label") and sep:
            trouve = valeur.upper() in msg.get("labelIds", [])
        elif cle == "is" and valeur in ("unread", "read"):
            trouve = ("UNREAD" in msg.get("labelIds", [])) == (valeur == "unread")
        elif cle in ("from", "to", "subject") and sep:
            trouve = valeur.lower() in headers.get(cle, "").lower()
        elif cle == "newer_than" and sep:
            duree = re.fullmatch(r"(\d+)([dhm])", valeur)
            if not duree:
                raise Erreur(400, "newer_than invalide")
            secondes = int(duree[1]) * {"d": 86400, "h": 3600, "m": 60}[duree[2]]
            trouve = int(msg.get("internalDate", "0")) / 1000 > time.time() - secondes
        elif sep:
            raise Erreur(400, f"Recherche non couverte par le banc : {cle}")
        else:
            trouve = terme.lower() in texte.lower()
        if trouve == negatif:
            return False
    return True


def page(items, query, maximum=100):
    debut = int(query.get("pageToken", [0])[0])
    taille = int(query.get("maxResults", [maximum])[0])
    if debut < 0 or not 1 <= taille <= 2500:
        raise Erreur(400, "Pagination invalide")
    suite = {"nextPageToken": str(debut + taille)} if debut + taille < len(items) else {}
    return items[debut:debut + taille], suite


class Google(Handler):
    def erreur(self, code, texte):
        raison = {401: "authError", 403: "insufficientPermissions", 429: "rateLimitExceeded"}.get(code, "invalidArgument")
        return {"error": {"code": code, "message": texte, "errors": [{"domain": "global", "reason": raison, "message": texte}]}}

    def traiter(self, chemin, query, body):
        etat, verbe = self.server.etat, self.command
        if chemin == "/__etat" and verbe == "GET":
            return 200, etat, {}
        if chemin == "/__injecter" and verbe == "POST":
            if "courriel" in body:
                msg = copy.deepcopy(body["courriel"])
                mid = str(msg.get("id") or self.identifiant("m"))
                if "raw" in msg:
                    msg = message(msg["raw"], mid, msg.get("labelIds", ["INBOX", "UNREAD"])) | msg
                msg = {"id": mid, "threadId": mid, "labelIds": ["INBOX", "UNREAD"], "snippet": "",
                       "internalDate": str(int(time.time() * 1000)), "payload": {"headers": []}} | msg
                etat["messages"][mid] = msg
                return 200, msg, {}
            if "evenement" in body:
                return 200, self.evenement(body["evenement"], body.get("calendrier", "primary")), {}
            if "erreur" in body:
                erreur = body["erreur"]
                if erreur["code"] not in (401, 403, 429):
                    raise Erreur(400, "Seules 401, 403 et 429 sont injectables")
                etat["erreurs"].append({"chemin": erreur.get("chemin", "/"), "code": erreur["code"], "fois": int(erreur.get("fois", 1))})
                return 200, {"ok": True}, {}
            raise Erreur(400, "courriel, evenement ou erreur attendu")
        for erreur in etat["erreurs"]:
            if erreur["fois"] and chemin.startswith(erreur["chemin"]):
                erreur["fois"] -= 1
                raise Erreur(erreur["code"], {401: "Invalid Credentials", 403: "Insufficient Permission", 429: "Too many requests"}[erreur["code"]])
        if chemin == "/token" and verbe == "POST":
            if body.get("refresh_token") != [REFRESH_TOKEN] or body.get("grant_type") != ["refresh_token"]:
                return 400, {"error": "invalid_grant", "error_description": "Bad Request"}, {}
            return 200, {"access_token": TOKEN, "expires_in": 3600, "token_type": "Bearer",
                         "scope": "https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar"}, {}
        if chemin == "/revoke" and verbe == "POST":
            if body.get("token") not in ([TOKEN], [REFRESH_TOKEN]):
                return 400, {"error": "invalid_token"}, {}
            return 200, {}, {}
        if self.headers.get("Authorization") != "Bearer " + TOKEN:
            raise Erreur(401, "Invalid Credentials")
        if chemin.startswith(GMAIL):
            return 200, self.gmail(chemin[len(GMAIL):], query, body), {}
        if chemin.startswith(AGENDA):
            cal, separateur, fin = chemin[len(AGENDA):].partition("/events")
            if not cal or not separateur or (fin and not fin.startswith("/")):
                raise Erreur(404, "Not Found")
            return 200, self.agenda(unquote(cal), fin.strip("/"), query, body), {}
        raise Erreur(404, "Not Found")

    def identifiant(self, prefixe):
        self.server.etat["sequence"] += 1
        return prefixe + str(self.server.etat["sequence"])

    def gmail(self, chemin, query, body):
        etat, verbe = self.server.etat, self.command
        if chemin == "messages" and verbe == "GET":
            found = [m for m in etat["messages"].values() if correspond(m, query.get("q", [""])[0])
                     and all(label in m["labelIds"] for label in query.get("labelIds", []))]
            listed, suite = page([{"id": m["id"], "threadId": m["threadId"]} for m in found], query)
            return {"messages": listed, "resultSizeEstimate": len(found), **suite}
        if chemin == "drafts" and verbe == "GET":
            found = [{"id": d["id"], "message": {k: d["message"][k] for k in ("id", "threadId")}} for d in etat["brouillons"].values()]
            listed, suite = page(found, query)
            return {"drafts": listed, "resultSizeEstimate": len(found), **suite}
        if chemin in ("drafts", "messages/send", "drafts/send") and verbe == "POST":
            if chemin == "drafts/send":
                draft = etat["brouillons"].pop(body["id"], None)
                if not draft:
                    raise Erreur(404, "Requested entity was not found.")
                source = body.get("message") or draft["message"]
                etat["messages"].pop(draft["message"]["id"], None)
            else:
                source = body["message"] if chemin == "drafts" else body
            msg = message(source["raw"], self.identifiant("m"), ["DRAFT"] if chemin == "drafts" else ["SENT"])
            msg["threadId"] = source.get("threadId") or msg["threadId"]
            etat["messages"][msg["id"]] = msg
            if chemin == "drafts":
                draft = {"id": self.identifiant("d"), "message": msg}
                etat["brouillons"][draft["id"]] = draft
                return draft
            etat["envois"].append(msg)
            return msg
        match = re.fullmatch(r"messages/([^/]+)(/modify)?", chemin)
        if match:
            msg = etat["messages"].get(unquote(match[1]))
            if not msg:
                raise Erreur(404, "Requested entity was not found.")
            if match[2] and verbe == "POST":
                labels = set(msg["labelIds"]) - set(body.get("removeLabelIds", []))
                msg["labelIds"] = sorted(labels | set(body.get("addLabelIds", [])))
                msg["historyId"] = str(time.time_ns())
                return msg
            if not match[2] and verbe == "GET":
                fmt = query.get("format", ["full"])[0].lower()
                result = copy.deepcopy(msg)
                if fmt == "raw":
                    result.pop("payload", None)
                else:
                    result.pop("raw", None)
                if fmt == "minimal":
                    result.pop("payload", None)
                elif fmt == "metadata":
                    headers = result.get("payload", {}).get("headers", [])
                    wanted = [v.lower() for v in query.get("metadataHeaders", [])]
                    result["payload"] = {"headers": [h for h in headers if not wanted or h["name"].lower() in wanted]}
                elif fmt not in ("full", "raw"):
                    raise Erreur(400, "Format inconnu")
                return result
        raise Erreur(404, "Not Found")

    def evenement(self, body, calendrier):
        eid = str(body.get("id") or self.identifiant("e"))
        if not body.get("start") or not body.get("end"):
            raise Erreur(400, "Missing start or end time.")
        event = {"kind": "calendar#event", "id": eid, "status": "confirmed", "created": maintenant(),
                 "updated": maintenant(), "htmlLink": f"https://calendar.google.com/calendar/event?eid={eid}"} | copy.deepcopy(body)
        self.server.etat["evenements"].setdefault(calendrier, {})[eid] = event
        return event

    def agenda(self, calendrier, eid, query, body):
        events = self.server.etat["evenements"].setdefault(calendrier, {})
        if not eid and self.command == "POST":
            if body.get("id") in events:
                raise Erreur(409, "The requested identifier already exists.")
            return self.evenement(body, calendrier)
        if eid and self.command == "PATCH":
            if eid not in events:
                raise Erreur(404, "Not Found")
            event = copy.deepcopy(events[eid])
            for key, value in body.items():
                if key in ("id", "kind", "created"):
                    continue
                if value is None:
                    event.pop(key, None)
                elif isinstance(value, dict) and isinstance(event.get(key), dict):
                    event[key].update(value)
                else:
                    event[key] = value
            event["updated"] = maintenant()
            events[eid] = event
            return event
        if not eid and self.command == "GET":
            found = []
            for event in events.values():
                if event.get("status") == "cancelled" and query.get("showDeleted") != ["true"]:
                    continue
                start = date_evenement(event["start"])
                end = date_evenement(event["end"])
                if query.get("timeMin") and end <= date(query["timeMin"][0]):
                    continue
                if query.get("timeMax") and start >= date(query["timeMax"][0]):
                    continue
                found.append(event)
            if query.get("orderBy") == ["startTime"]:
                found.sort(key=lambda e: date_evenement(e["start"]))
            listed, suite = page(found, query, 250)
            return {"kind": "calendar#events", "summary": "Agenda du banc", "timeZone": "UTC", "items": listed, **suite}
        raise Erreur(404, "Not Found")


def creer(adresse=("127.0.0.1", 0)):
    return Serveur(adresse, Google, {"messages": {}, "brouillons": {}, "envois": [], "evenements": {},
                                     "journal": [], "erreurs": [], "sequence": 0})


if __name__ == "__main__":
    lancer(creer, 8081)
