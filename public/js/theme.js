// Theme toggle. The initial theme is set in <head> before the page paints
// to avoid a light-flash; this file just wires the toggles.
//
// Two ways to switch theme:
//   - Tap the SUN  → light theme (always available, even when active)
//   - Tap the MOON → dark theme
//   - Old `#theme-toggle` icon button is still supported as a fallback
//     for any third-party deep-link, but the celestial bodies are the
//     primary control on the menu.

(function () {
  const STORAGE_KEY = "gtf-theme";

  function current() {
    return document.documentElement.getAttribute("data-theme") || "dark";
  }

  function setTheme(name) {
    if (name !== "light" && name !== "dark") return;
    if (current() === name) return;
    document.documentElement.setAttribute("data-theme", name);
    try { localStorage.setItem(STORAGE_KEY, name); } catch (e) {}
    if (window.Sound) window.Sound.play("tap");
  }

  document.addEventListener("DOMContentLoaded", () => {
    // Sun / moon — primary controls on the menu.
    const sun  = document.getElementById("celestial-sun");
    const moon = document.getElementById("celestial-moon");
    if (sun)  sun.addEventListener("click",  () => setTheme("light"));
    if (moon) moon.addEventListener("click", () => setTheme("dark"));

    // Legacy icon button — kept for compatibility; toggles between modes.
    const btn = document.getElementById("theme-toggle");
    if (btn) {
      btn.addEventListener("click", () => {
        setTheme(current() === "dark" ? "light" : "dark");
      });
    }
  });

  window.Theme = { setTheme, current };
})();
