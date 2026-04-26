// Tiny History-API router.
//
// Routes are real URLs. Browser back/forward, refresh-in-place, and
// deep-linking all work. The Express server has a catchall that serves
// index.html for any non-asset path so refreshing on /stats actually
// loads the page.
//
// Mental model: URLs reflect *intent*, not in-game state. "/daily" means
// "I want to play daily" — what's actually shown (locked result, game
// in progress, results screen) is decided by the daily controller from
// localStorage and live state. URLs don't change mid-round.

(function () {
  // Order matters: more-specific patterns first.
  const ROUTES = [
    { match: /^\/$/,                       handler: routeMenu  },
    { match: /^\/daily\/?$/,               handler: routeDaily },
    { match: /^\/flag\/?$/,                handler: routeFlag  },
    { match: /^\/capital\/?$/,             handler: routeCapital },
    { match: /^\/population\/?$/,          handler: routePopulation },
    { match: /^\/solo\/?$/,                handler: routeFlag  },     // back-compat
    { match: /^\/stats\/?$/,               handler: routeStats },
    { match: /^\/host\/?$/,                handler: routeHost  },
    { match: /^\/join\/?$/,                handler: routeJoin  },
    { match: /^\/r\/([A-Z0-9]{2,8})\/?$/i, handler: routeRoomCode },
  ];

  let current = null;       // last path we routed to (avoid double-fire on popstate)

  // --- Mode lifecycle helpers --------------------------------------

  // Whenever the route changes, clean up the previous mode so timers
  // and sockets don't leak. Each controller already exposes leave().
  function leaveAll() {
    if (window.Games) {
      Object.values(window.Games).forEach((g) => { if (typeof g.leave === "function") g.leave(); });
    }
    if (window.Daily)       window.Daily.leave();
    if (window.Multiplayer) window.Multiplayer.leave();
  }

  // --- Route handlers ----------------------------------------------

  function routeMenu()  { leaveAll(); window.App.show("menu"); }

  function routeStats() { leaveAll(); window.App.show("stats"); }

  function routeDaily() {
    leaveAll();
    if (window.Daily) window.Daily.start();
    else { window.App.show("menu"); }
  }

  function routeFlag() {
    leaveAll();
    if (window.Games && window.Games.flag) window.Games.flag.start();
    else if (window.Solo) window.Solo.start();   // ultra-defensive fallback
    else { window.App.show("menu"); }
  }

  function routeCapital() {
    leaveAll();
    if (window.Games && window.Games.capital) window.Games.capital.start();
    else { window.App.show("menu"); }
  }

  function routePopulation() {
    leaveAll();
    if (window.Games && window.Games.population) window.Games.population.start();
    else { window.App.show("menu"); }
  }

  function routeHost() {
    leaveAll();
    window.App.openNickname("create-room");
  }

  function routeJoin() {
    leaveAll();
    window.App.openNickname("join-room");
  }

  function routeRoomCode(_, code) {
    leaveAll();
    window.App.openNickname("join-room", { code: code.toUpperCase() });
  }

  // --- Navigation API ----------------------------------------------

  function go(path, { replace = false } = {}) {
    // Normalize and dedupe — clicking the menu button while on /
    // shouldn't push another / entry.
    const target = path || "/";
    if (target === current) return;
    if (replace) history.replaceState({ path: target }, "", target);
    else         history.pushState({ path: target }, "", target);
    handle(target);
  }

  function handle(path) {
    current = path;
    for (const r of ROUTES) {
      const m = path.match(r.match);
      if (m) {
        try { r.handler(...m); } catch (e) { console.error(e); }
        return;
      }
    }
    // Unknown path → home.
    history.replaceState({ path: "/" }, "", "/");
    current = "/";
    routeMenu();
  }

  function init() {
    window.addEventListener("popstate", () => handle(location.pathname));

    // Back-compat: if someone hits /?room=ABCD (the old query-string
    // deep link), redirect to the canonical /r/ABCD URL.
    const params = new URLSearchParams(location.search);
    const queryRoom = params.get("room");
    if (queryRoom && /^[A-Z0-9]{2,8}$/i.test(queryRoom)) {
      go(`/r/${queryRoom.toUpperCase()}`, { replace: true });
      return;
    }
    handle(location.pathname || "/");
  }

  window.Router = { go, handle, init };
})();
