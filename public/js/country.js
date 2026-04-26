// Country detail panel renderer.
//
// Fetches /api/country/:code (capital, population, languages, intro, photo)
// and paints it into the #country-panel block. Pre-renders the basic
// header (flag + name + region) instantly from the local question data,
// then progressively fills in remote fields as they arrive — so a slow
// network never holds up the reveal.

(function () {
  const cache = new Map(); // code -> details

  function $(id) { return document.getElementById(id); }

  function formatNumber(n) {
    if (typeof n !== "number") return null;
    return n.toLocaleString("en-US");
  }

  function formatArea(km2) {
    if (typeof km2 !== "number") return null;
    return `${formatNumber(Math.round(km2))} km²`;
  }

  // Build a compact "label + value" stat tile.
  function statTile(label, value) {
    if (!value) return null;
    const tile = document.createElement("div");
    tile.className = "cp-stat";
    const l = document.createElement("div");
    l.className = "cp-stat-label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "cp-stat-value";
    v.textContent = value;
    v.title = value;
    tile.appendChild(l);
    tile.appendChild(v);
    return tile;
  }

  function renderStats(details) {
    const wrap = $("cp-stats");
    wrap.innerHTML = "";
    const tiles = [
      statTile("Capital",    details.capital),
      statTile("Population", formatNumber(details.population)),
      statTile("Region",     details.subregion || details.region),
      statTile("Area",       formatArea(details.area)),
      statTile("Languages",  (details.languages || []).slice(0, 3).join(", ") || null),
      statTile("Currency",   (details.currencies || [])[0] || null),
    ].filter(Boolean);
    tiles.forEach((t) => wrap.appendChild(t));
  }

  function renderPhoto(details) {
    const wrap = $("cp-hero");
    const img = $("cp-hero-img");
    // Prefer the full-resolution Wikipedia image, but only if it's
    // moderately-sized — some originals are 5+ MB and a real pain on 4G.
    // Above ~1500px width we fall back to the small thumbnail.
    const fullIsReasonable = details.photoFull
      && (!details.photoFullW || details.photoFullW <= 1500);
    const src = (fullIsReasonable ? details.photoFull : null) || details.photo;
    if (src) {
      // Cross-fade: clear → set → wait for load → fade in.
      img.style.opacity = "0";
      img.onload = () => {
        img.style.opacity = "1";
      };
      img.onerror = () => { wrap.hidden = true; };
      img.src = src;
      img.alt = `Photo of ${details.name}`;
      wrap.hidden = false;
    } else {
      wrap.hidden = true;
    }
  }

  function renderIntro(details) {
    const intro = $("cp-intro");
    if (details.intro) {
      // Wikipedia summaries occasionally include "(listen)" or trailing
      // pronunciation notes — fine to leave; they're short.
      intro.textContent = details.intro;
      intro.hidden = false;
    } else {
      intro.hidden = true;
    }
  }

  // Show the panel with the basics we always have (code + name + fact),
  // then load the rich details from the server in the background.
  function show({ code, name, region, fact }) {
    // Header (mini flag + name) appears instantly with what we already know.
    $("cp-flag").src = `https://flagcdn.com/w160/${code}.png`;
    $("cp-flag").alt = `Flag of ${name}`;
    $("cp-name").textContent = name;
    $("cp-region").textContent = region || "";

    // Hero overlay shows the same name + region until the photo loads.
    const heroName = $("cp-hero-name");
    const heroRegion = $("cp-hero-region");
    if (heroName)   heroName.textContent = name;
    if (heroRegion) heroRegion.textContent = region || "";

    // Bundled local fact appears immediately as a quote.
    const factEl = $("cp-fact");
    if (fact) { factEl.textContent = fact; factEl.hidden = false; }
    else      { factEl.hidden = true; }

    // Reset remote-only sections to empty until they load.
    $("cp-stats").innerHTML = "";
    $("cp-hero").hidden = true;
    $("cp-intro").hidden = true;

    const panel = $("country-panel");
    panel.classList.add("is-visible");

    // Sample the country's flag and tint the panel's accent color
    // toward it. Falls back to the global amber accent if extraction fails.
    if (window.ColorExtractor) {
      window.ColorExtractor.extract(code).then((hex) => {
        if (panel.classList.contains("is-visible")) {
          window.ColorExtractor.applyTo(panel, hex);
        }
      });
    }

    // Fire the server fetch (cached after the first hit per country).
    loadAndRender(code, name);
  }

  function hide() {
    $("country-panel").classList.remove("is-visible");
  }

  async function loadAndRender(code, name) {
    let details = cache.get(code);
    if (!details) {
      try {
        const res = await fetch(`/api/country/${encodeURIComponent(code)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        details = await res.json();
        cache.set(code, details);
      } catch (e) {
        // Soft-fail — the panel still shows what we have locally.
        return;
      }
    }
    // Make sure the panel still belongs to this country (user could have
    // tapped Next very fast and started the next round already).
    if ($("cp-name").textContent !== (details.name || name)) return;
    renderStats(details);
    renderPhoto(details);
    renderIntro(details);

    // Backfill the small region line on both the header and the hero
    // overlay now that we know the proper subregion.
    const niceRegion = details.subregion || details.region || "";
    if (niceRegion) {
      $("cp-region").textContent = niceRegion;
      const heroRegion = $("cp-hero-region");
      if (heroRegion) heroRegion.textContent = niceRegion;
    }
  }

  window.Country = { show, hide };
})();
