"""GitHub MCP HTTP du banc. Aucun appel à GitHub, état propre à chaque serveur.

Contrat figé : manifestes/github.json (sources officielles et date de consultation).
Les descriptions sont abrégées ; noms, arguments et enveloppes suivent ces sources.
"""
import copy
import json
import uuid
from datetime import datetime, timezone

from http_local import Erreur, Handler, Serveur, lancer

PROTOCOL = "2025-06-18"


def champ(type_, description, **kwargs):
    return {"type": type_, "description": description, **kwargs}


REPO = {"owner": champ("string", "Repository owner"), "repo": champ("string", "Repository name")}
PAGINATION = {"page": champ("number", "Page number (min 1)"), "perPage": champ("number", "Results per page (min 1, max 100)")}


def outil(name, description, title, lecture, properties, required=()):
    schema = {"type": "object", "properties": properties}
    if required:
        schema["required"] = list(required)
    return {"name": name, "description": description, "inputSchema": schema,
            "annotations": {"title": title, "readOnlyHint": lecture}}


TOOLS = [
    outil("list_pull_requests", "List repository pull requests; use search_pull_requests when filtering by author.",
          "List pull requests", True, {**REPO, **PAGINATION,
          "state": champ("string", "Filter by state", enum=["open", "closed", "all"]),
          "head": champ("string", "Filter by head user/org and branch"), "base": champ("string", "Filter by base branch"),
          "sort": champ("string", "Sort by", enum=["created", "updated", "popularity", "long-running"]),
          "direction": champ("string", "Sort direction", enum=["asc", "desc"])}, ("owner", "repo")),
    outil("pull_request_read", "Read a pull request, its diff, status, files, reviews or comments.",
          "Get details for a single pull request", True, {**REPO, **PAGINATION,
          "method": champ("string", "Pull request data to retrieve", enum=["get", "get_diff", "get_status", "get_files", "get_review_comments", "get_reviews", "get_comments"]),
          "pullNumber": champ("number", "Pull request number")}, ("method", "owner", "repo", "pullNumber")),
    outil("add_issue_comment", "Comment on an issue or PR; use a review tool for review comments.",
          "Add comment to issue", False, {**REPO, "issue_number": champ("number", "Issue number to comment on"),
          "body": champ("string", "Comment content")}, ("owner", "repo", "issue_number", "body")),
    outil("list_notifications", "List GitHub notifications, including pending reviews and unread updates.",
          "List notifications", True, {**REPO, **PAGINATION,
          "filter": champ("string", "Notification filter", enum=["default", "include_read_notifications", "only_participating"]),
          "since": champ("string", "Updated after (ISO 8601)"), "before": champ("string", "Updated before (ISO 8601)")}),
    outil("get_notification_details", "Read one notification; list notifications first if its ID is unknown.",
          "Get notification details", True, {"notificationID": champ("string", "The ID of the notification")}, ("notificationID",)),
]


def maintenant():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def contenu(value, erreur=False):
    return {"content": [{"type": "text", "text": value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)}],
            **({"isError": True} if erreur else {})}


def paginer(items, args):
    page, taille = int(args.get("page", 1)), int(args.get("perPage", 30))
    if page < 1 or not 1 <= taille <= 100:
        raise ValueError("Pagination invalide")
    return items[(page - 1) * taille:page * taille]


def verifier(schema, args):
    if not isinstance(args, dict):
        raise ValueError("Arguments must be an object")
    for key in schema.get("required", []):
        if key not in args:
            raise ValueError(f"Missing required argument: {key}")
    for key, value in args.items():
        prop = schema["properties"].get(key)
        if not prop:
            raise ValueError(f"Unknown argument: {key}")
        if prop["type"] == "string" and not isinstance(value, str):
            raise ValueError(f"{key} must be a string")
        if prop["type"] == "number" and (isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value):
            raise ValueError(f"{key} must be an integer")
        if "enum" in prop and value not in prop["enum"]:
            raise ValueError(f"Invalid {key}")


class GitHub(Handler):
    def erreur(self, code, message):
        return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": message}}

    def json_invalide(self):
        return 400, {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}

    def traiter(self, chemin, query, body):
        etat, verbe = self.server.etat, self.command
        if chemin == "/__etat" and verbe == "GET":
            return 200, {k: v for k, v in etat.items() if k != "sessions"}, {}
        if chemin == "/__injecter" and verbe == "POST":
            pr = copy.deepcopy(body["pr"])
            owner, repo = body["owner"], body["repo"]
            number = int(pr["number"])
            key = f"{owner}/{repo}/{number}"
            stamp = maintenant()
            pr = {"id": number, "state": "open", "title": "", "body": "", "created_at": stamp,
                  "updated_at": stamp, "html_url": f"https://github.com/{owner}/{repo}/pull/{number}",
                  "url": f"https://api.github.com/repos/{owner}/{repo}/pulls/{number}",
                  "user": {"login": "auteur-banc"}, "head": {"ref": "branche-banc", "label": f"{owner}:branche-banc"},
                  "base": {"ref": "main"}} | pr
            etat["prs"][key] = {"pr": pr, "diff": body.get("diff", ""), "files": body.get("files", []),
                                "reviews": body.get("reviews", []), "review_comments": body.get("review_comments", []),
                                "status": body.get("status", {"state": "success", "statuses": [], "total_count": 0})}
            # Une même PR réinjectée actualise sa notification au lieu de la dupliquer.
            etat["notifications"][key] = {"id": str(pr["id"]), "unread": True, "reason": "review_requested",
                                          "updated_at": stamp, "last_read_at": None,
                                          "repository": {"name": repo, "full_name": f"{owner}/{repo}", "owner": {"login": owner}},
                                          "subject": {"title": pr["title"], "type": "PullRequest", "url": pr["url"], "latest_comment_url": None},
                                          "url": f"https://api.github.com/notifications/threads/{pr['id']}"}
            return 200, pr, {}
        if chemin != "/mcp":
            raise Erreur(404, "Not Found")
        if verbe != "POST":
            return 405, None, {"Allow": "POST"}
        if body.get("jsonrpc") != "2.0" or not isinstance(body.get("method"), str):
            return self.rpc(body.get("id"), error=(-32600, "Invalid Request"))
        method, mid = body["method"], body.get("id")
        sid = self.headers.get("Mcp-Session-Id")
        if method == "initialize":
            params = body.get("params")
            if not isinstance(params, dict) or params.get("protocolVersion") != PROTOCOL:
                return self.rpc(mid, error=(-32602, f"Unsupported protocolVersion; supported: {PROTOCOL}"))
            sid = uuid.uuid4().hex
            etat["sessions"].add(sid)
            return self.rpc(mid, {"protocolVersion": PROTOCOL, "capabilities": {"tools": {"listChanged": False}},
                                  "serverInfo": {"name": "github-banc", "version": "1"}}, sid=sid)
        if not sid or sid not in etat["sessions"]:
            raise Erreur(404, "Session not found")
        if "id" not in body:
            return 202, None, {"Mcp-Session-Id": sid}
        if method == "ping":
            return self.rpc(mid, {}, sid=sid)
        if method == "tools/list":
            return self.rpc(mid, {"tools": TOOLS}, sid=sid)
        if method != "tools/call":
            return self.rpc(mid, error=(-32601, "Method not found"), sid=sid)
        params = body.get("params") or {}
        if not isinstance(params, dict):
            return self.rpc(mid, error=(-32602, "Invalid params"), sid=sid)
        name, args = params.get("name"), params.get("arguments") or {}
        etat["journal"][-1].update({"outil": name, "arguments": copy.deepcopy(args)})
        tool = next((t for t in TOOLS if t["name"] == name), None)
        if not tool:
            return self.rpc(mid, error=(-32602, "Unknown tool"), sid=sid)
        try:
            verifier(tool["inputSchema"], args)
            answer = contenu(self.appeler(name, args))
        except (ValueError, KeyError) as e:
            answer = contenu(str(e), erreur=True)
        return self.rpc(mid, answer, sid=sid)

    def rpc(self, mid, result=None, error=None, sid=None):
        value = {"error": {"code": error[0], "message": error[1]}} if error else {"result": result}
        return 200, {"jsonrpc": "2.0", "id": mid, **value}, {"Mcp-Session-Id": sid} if sid else {}

    def appeler(self, name, args):
        etat = self.server.etat
        if name in ("list_notifications", "get_notification_details"):
            found = list(etat["notifications"].values())
            if name == "get_notification_details":
                return next((n for n in found if n["id"] == args["notificationID"]), None) or self.introuvable()
            if args.get("owner") and args.get("repo"):
                found = [n for n in found if n["repository"]["full_name"] == f"{args['owner']}/{args['repo']}"]
            if args.get("filter", "default") == "default":
                found = [n for n in found if n["unread"]]
            if args.get("filter") == "only_participating":
                found = [n for n in found if n["reason"] in ("mention", "review_requested", "assign", "author", "comment")]
            for bound, sign in (("since", 1), ("before", -1)):
                if args.get(bound):
                    limit = datetime.fromisoformat(args[bound].replace("Z", "+00:00"))
                    found = [n for n in found if (datetime.fromisoformat(n["updated_at"].replace("Z", "+00:00")) - limit).total_seconds() * sign > 0]
            return paginer(found, args)
        prefixe = f"{args['owner']}/{args['repo']}/"
        if name == "list_pull_requests":
            prs = [v["pr"] for k, v in etat["prs"].items() if k.startswith(prefixe)]
            state = args.get("state", "open")
            prs = [pr for pr in prs if state == "all" or pr["state"] == state]
            for branch in ("head", "base"):
                if args.get(branch):
                    prs = [pr for pr in prs if args[branch] in (pr[branch].get("ref"), pr[branch].get("label"))]
            sort = {"created": "created_at", "updated": "updated_at", "popularity": "comments", "long-running": "created_at"}[args.get("sort", "created")]
            prs.sort(key=lambda p: p.get(sort, 0 if sort == "comments" else ""), reverse=args.get("direction", "desc") == "desc")
            return paginer(prs, args)
        number = args.get("pullNumber", args.get("issue_number"))
        key = prefixe + str(int(number))
        pr = etat["prs"].get(key)
        if not pr:
            self.introuvable()
        comments = [c for c in etat["commentaires"] if c["issue_url"] == f"https://api.github.com/repos/{args['owner']}/{args['repo']}/issues/{int(number)}"]
        if name == "add_issue_comment":
            cid = len(etat["commentaires"]) + 1
            result = {"id": cid, "body": args["body"], "user": {"login": "noah-banc"}, "created_at": maintenant(),
                      "html_url": pr["pr"]["html_url"] + f"#issuecomment-{cid}",
                      "issue_url": f"https://api.github.com/repos/{args['owner']}/{args['repo']}/issues/{int(number)}"}
            etat["commentaires"].append(result)
            return result
        method = args["method"]
        if method == "get":
            return pr["pr"]
        if method == "get_diff":
            return pr["diff"]
        if method == "get_status":
            return pr["status"]
        if method == "get_comments":
            return paginer(comments, args)
        return paginer(pr[{"get_files": "files", "get_reviews": "reviews", "get_review_comments": "review_comments"}[method]], args)

    def introuvable(self):
        raise ValueError("Not Found")


def creer(adresse=("127.0.0.1", 0)):
    return Serveur(adresse, GitHub, {"prs": {}, "commentaires": [], "notifications": {}, "journal": [], "sessions": set()})


if __name__ == "__main__":
    lancer(creer, 8082)
