// Theme toggle. The initial theme is set in <head> before the page paints
// to avoid a light-flash; this file just wires the toggle button.

(function () {
  const STORAGE_KEY = "gtf-theme";

  function current() {
    return document.documentElement.getAttribute("data-theme") || "dark";
  }

  function setTheme(name) {
    document.documentElement.setAttribute("data-theme", name);
    try { localStorage.setItem(STORAGE_KEY, name); } catch (e) {}
  }

  document.addEventListener("DOMContentLoaded", () => {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", () => {
      setTheme(current() === "dark" ? "light" : "dark");
    });
  });

  window.Theme = { setTheme, current };
})();
