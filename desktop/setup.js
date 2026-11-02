// Premier lancement : Noah sur un serveur (adresse + code de Réglages → Appareils) ou sur cet ordinateur.
const $ = (id) => document.getElementById(id);
const form = $("form");

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
  $("toggle").textContent = withCode ? "Autoriser depuis le navigateur à la place" : "J'ai un code à la place";
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
  $("go").textContent = "Autorise dans le navigateur, puis saisis le nombre ici";
});
$("number").addEventListener("input", () => {
  $("number").value = $("number").value.replace(/\D/g, "");
  if ($("number").value.length === 2) window.noahSetup.sendNumber($("number").value);
});

window.noahSetup.onWaiting((verification) => {
  $("go").textContent = verification
    ? `Sur l'appareil déjà relié, accepte cet ordinateur et saisis le nombre ${verification}`
    : "En attente de ton accord…";
});

form.onsubmit = async (e) => {
  e.preventDefault();
  $("error").textContent = "";
  $("go").disabled = true;
  $("go").textContent = withCode ? "Connexion…" : "En attente de ton accord dans le navigateur…";
  const r = withCode
    ? await window.noahSetup.connect($("server").value.trim(), $("code").value.trim())
    : await window.noahSetup.authorize($("server").value.trim());
  if (r && r.error) {
    $("error").textContent = r.error;
    $("go").disabled = false;
    $("go").textContent = "Relier";
  }
};
