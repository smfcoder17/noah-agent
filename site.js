// Copy buttons and header border. No tracking, no external request.
(function () {
  var fr = document.documentElement.lang === "fr";
  document.querySelectorAll(".copy").forEach(function (b) {
    b.addEventListener("click", function () {
      var t = b.parentElement.querySelector("code").textContent;
      navigator.clipboard.writeText(t).then(function () {
        b.textContent = fr ? "Copié" : "Copied";
        setTimeout(function () { b.textContent = fr ? "Copier" : "Copy"; }, 1600);
      });
    });
  });
  var top = document.querySelector(".top");
  if (top) {
    var on = function () { top.classList.toggle("scrolled", window.scrollY > 8); };
    on();
    window.addEventListener("scroll", on, { passive: true });
  }
})();
