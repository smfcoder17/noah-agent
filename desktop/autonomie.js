// Réglage de cet ordinateur seulement. Aucun champ reçu du serveur n'entre ici.
function create(read, write) {
  const get = () => read().autonomie_ordinateur === "auto" ? "auto" : "prudent";
  const set = (value) => {
    if (value !== "auto" && value !== "prudent") return;
    write({ autonomie_ordinateur: value });
  };
  return { get, set };
}
module.exports = { create };
