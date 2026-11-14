// Premier lancement : Noah sur un serveur (adresse + code de Réglages → Appareils) ou sur cet ordinateur.
const $ = (id) => document.getElementById(id);
const form = $("form");
// Textes : textes.js (chargé avant ce fichier), dans la langue des menus de l'app, transmise par le preload.
let lang = NoahTextes.langue(); // navigator.language en attendant la réponse
const t = (key, vars) => NoahTextes.t(key, vars, lang);
NoahTextes.appliquer(document, lang);
window.noahSetup.langue().then((l) => {
  lang = NoahTextes.choisir(l || navigator.language);
  NoahTextes.appliquer(document, lang);
  $("toggle").textContent = withCode ? t("setup.avec_navigateur") : t("setup.avec_code");
}).catch(() => {});

$("local").onclick = () => window.noahSetup.useLocal();
$("remote").onclick = () => {
  $("choices").style.display = "none";
  form.style.display = "flex";
  $("server").focus();
};
$("back").onclick = () => {
  form.style.display = "none";
  $("choices").style.display = "flex";
};

let withCode = false;
$("toggle").onclick = (e) => {
  e.preventDefault();
  withCode = !withCode;
  $("codeRow").style.display = withCode ? "flex" : "none";
  $("code").required = withCode;
  $("toggle").textContent = withCode ? t("setup.avec_navigateur") : t("setup.avec_code");
};

// Le lien du QR code (https://hote/?appairage=…) contient les deux : on le découpe.
$("server").addEventListener("input", () => {
  try {
    const u = new URL($("server").value.trim());
    const code = u.searchParams.get("appairage") || (u.hash.match(/appairage=([\w-]+)/) || [])[1];
    if (code) {
      $("server").value = u.origin;
      $("code").value = code;
      if (!withCode) $("toggle").click();
    }
  } catch {
    /* adresse en cours de saisie */
  }
});

// Code court accepté : le serveur attend que l'utilisateur autorise cet ordinateur depuis un appareil déjà relié.
// Flux navigateur : la page d'accord affiche un nombre ; le recopier ici prouve que c'est bien toi qui as accepté.
window.noahSetup.onAskNumber(() => {
  $("numberRow").style.display = "flex";
  $("number").focus();
  $("go").textContent = t("setup.nombre.demande");
});
$("number").addEventListener("input", () => {
  $("number").value = $("number").value.replace(/\D/g, "");
  if ($("number").value.length === 3) window.noahSetup.sendNumber($("number").value);
});

window.noahSetup.onWaiting((verification) => {
  $("go").textContent = verification
    ? t("setup.attente.verification", { nombre: verification })
    : t("setup.attente");
});

form.onsubmit = async (e) => {
  e.preventDefault();
  $("error").textContent = "";
  $("go").disabled = true;
  $("go").textContent = withCode ? t("setup.connexion") : t("setup.attente.navigateur");
  const r = withCode
    ? await window.noahSetup.connect($("server").value.trim(), $("code").value.trim())
    : await window.noahSetup.authorize($("server").value.trim());
  if (r && r.error) {
    $("error").textContent = r.error;
    $("go").disabled = false;
    $("go").textContent = t("setup.relier");
  }
};
