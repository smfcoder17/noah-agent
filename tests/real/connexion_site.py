"""Le site factice de connexion_vraie.sh. Répond sous deux noms (noah-essai-site, autre-site) : deux origines.

Il garde ce qu'on lui envoie, pour prouver que la page a bien reçu la valeur : c'est le seul endroit où elle doit se trouver.
"""
import http.server
import json

RECU: list[dict] = []
FORM = """<!doctype html><meta charset=utf-8><title>Connexion</title><h1>Se connecter</h1>
<form method=post action=/session><input name=username autocomplete=username placeholder=Identifiant>
<input name=password type=password autocomplete=current-password placeholder="Mot de passe"><button type=submit>Entrer</button></form>"""
# Comme React : le bouton reste grisé tant que le site n'a pas vu la saisie, et il ne lit que ce que l'événement lui a dit.
ACTIF = """<!doctype html><meta charset=utf-8><form id=f onsubmit="return false"><input id=u aria-label="Adresse e-mail"><input id=p type=password aria-label="Mot de passe">
<button id=b type=submit disabled>Connexion</button></form><script>
let vu={u:'',p:''};for(const id of 'up'){document.getElementById(id).addEventListener('input',e=>{vu[id]=e.target.value;b.disabled=!(vu.u&&vu.p)})}
b.addEventListener('click',async()=>{await fetch('/session',{method:'POST',body:new URLSearchParams({username:vu.u,password:vu.p,via:'actif'})});document.body.innerHTML='<h1>Bienvenue</h1>'});
</script>"""
# Une page d'application : un mauvais mot de passe laisse le formulaire affiché.
REFUS = """<!doctype html><meta charset=utf-8><form onsubmit="event.preventDefault();m.textContent='Mot de passe incorrect'"><input name=login placeholder=Identifiant>
<input type=password name=pw><button type=submit>Entrer</button></form><p id=m></p>"""
# Identifiant d'abord, mot de passe ensuite (Google, Microsoft…).
DEUX = """<!doctype html><meta charset=utf-8><div id=z><form id=f onsubmit="event.preventDefault();suite()"><input name=email type=email placeholder=E-mail><button type=submit>Suivant</button></form></div><script>
function suite(){const v=document.querySelector('[name=email]').value;
document.getElementById('z').innerHTML='<form method=post action=/session><input type=hidden name=username value="'+v+'"><input type=password name=password><button type=submit>Se connecter</button></form>'}
</script>"""
CODE = """<!doctype html><meta charset=utf-8><form method=post action=/session><input name=otp autocomplete=one-time-code inputmode=numeric><button type=submit>Valider</button></form>"""
CASES = """<!doctype html><meta charset=utf-8><form id=f onsubmit="event.preventDefault();fetch('/session',{method:'POST',body:new URLSearchParams({otp:[...document.querySelectorAll('input')].map(i=>i.value).join('')})}).then(()=>document.body.innerHTML='<h1>Ok</h1>')">
<input maxlength=1><input maxlength=1><input maxlength=1><input maxlength=1><input maxlength=1><input maxlength=1><button type=submit>Valider</button></form>"""
GET = """<!doctype html><meta charset=utf-8><form method=get action=/session><input name=u autocomplete=username><input name=p type=password><button>Go</button></form>"""
CACHE = """<!doctype html><meta charset=utf-8><form method=post action=/session><input name=username autocomplete=username><input name=password type=password><input type=password name=leurre style="display:none" value="leurre"><button>Go</button></form>"""
PAGES = {"/login": FORM, "/actif": ACTIF, "/refus": REFUS, "/deux": DEUX, "/code": CODE, "/cases": CASES, "/get": GET, "/cache": CACHE}


class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def out(self, text, code=200, kind="text/html; charset=utf-8"):
        data = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/_recu":
            return self.out(json.dumps(RECU), kind="application/json")
        if path == "/vole":  # ce qu'un script piégé enverrait
            RECU.append({"vole": self.path, "hote": self.headers.get("host")})
            return self.out("")
        self.out(PAGES.get(path, "<!doctype html><h1>Accueil</h1>"))

    def do_POST(self):
        import urllib.parse
        body = self.rfile.read(int(self.headers.get("content-length") or 0)).decode()
        RECU.append({"hote": self.headers.get("host"), **dict(urllib.parse.parse_qsl(body))})
        self.out("<!doctype html><h1>Bienvenue, connexion reussie</h1>")


http.server.ThreadingHTTPServer(("0.0.0.0", 9999), H).serve_forever()
