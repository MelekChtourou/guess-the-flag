// 3D Atlas globe with country-level precision.
//
// Three layers of interactivity:
//   1. Drag/touch to spin the planet (with momentum).
//   2. Tap a country → camera tweens + zooms in, the country's borders
//      get drawn in black on the surface, and the menu controller is
//      told which country was hit.
//   3. Tap an empty ocean → zoom out, clear the borders.
//
// Country detection uses the Natural Earth 110m TopoJSON bundled at
// /data/world-110m.json. We point-in-polygon the click's lat/lng
// against each country's rings (TopoJSONMini handles the math). If the
// data fails to load (CDN/PWA hiccup), we silently degrade to the old
// continent-by-centroid mode so the menu still works.

(function () {
  const THREE_URL          = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
  const EARTH_TEXTURE_URL  = "https://unpkg.com/three-globe@2.30.0/example/img/earth-blue-marble.jpg";
  const TOPOJSON_URL       = "/data/world-110m.json";

  // Continent centroids — used as the fallback "nearest region" when
  // TopoJSON isn't available, and as the camera target when the menu
  // controller asks for a continent.
  const CONTINENTS = [
    { id: "Africa",        lat:   2,   lng:  17 },
    { id: "Asia",          lat:  35,   lng: 100 },
    { id: "Europe",        lat:  52,   lng:  15 },
    { id: "North America", lat:  45,   lng: -100 },
    { id: "South America", lat: -15,   lng: -60 },
    { id: "Oceania",       lat: -22,   lng: 140 },
  ];

  let renderer, scene, camera, earth, atmosphere, marker, borders, THREE;
  let renderTimer = null;
  let bootAttempted = false;
  let supported = true;
  let countryFeatures = null;   // [{ id, name, type, coords }, ...] from topojson-mini, or null

  // Rotation + interaction. Initial pitch puts the equator on-screen;
  // a small tilt (~10°) gives the globe a more "earth-like" feel without
  // breaking the centering math (which assumes pitch is part of rot, not
  // baked into the formula).
  const rot = { x: 0.18, y: 0, velX: 0, velY: 0 };
  const AUTO_DRIFT_Y = 0.0025;
  const VEL_DECAY    = 0.94;
  const DRAG_SENS    = 0.005;
  const PITCH_LIMIT  = 1.2;
  let dragging = false;
  let lastIdleAt = 0;
  const IDLE_RESUME_MS = 1500;

  // Camera target (zoom + framing).
  //
  // The clicked country needs to land in the *visible* part of the
  // viewport — between the floating header at top and the games tray
  // at bottom — not at the geometric center (where the tray hides it).
  // We shift the camera DOWN on Y when zoomed in, which pushes the
  // focus point UP on screen, into the visible band.
  const CAM_OUT_Z = 4.0;
  const CAM_IN_Z  = 2.4;
  const CAM_OUT_Y = 0;
  // -0.10 nudges the focused country slightly UP in the viewport so it
  // sits comfortably between the header (top ~80px) and the tray
  // (bottom ~280px). At z=2.4 with 35° FOV, this corresponds to
  // ~12% of the viewport height — enough to escape the tray, not so
  // much that the country flies out the top.
  const CAM_IN_Y  = -0.10;
  let camZ = CAM_OUT_Z;
  let camY = CAM_OUT_Y;

  // Active tween for {rotX, rotY, camZ}. easeOutQuart for cinematic feel.
  let tween = null;
  const TWEEN_MS = 1400;

  // Tap vs drag discriminator.
  let pressStart = null;
  const TAP_MAX_DIST = 8;
  const TAP_MAX_MS   = 350;

  // Border-drawing animation state.
  let borderDrawHandle = null;

  // External listeners.
  const continentListeners = new Set();
  const countryListeners   = new Set();

  function $(id) { return document.getElementById(id); }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function hasWebGL() {
    try {
      const c = document.createElement("canvas");
      return !!(c.getContext("webgl") || c.getContext("experimental-webgl"));
    } catch (e) { return false; }
  }
  function showFallback() {
    supported = false;
    const fb = $("hero-fallback");
    if (fb) fb.hidden = false;
  }

  // --- Spherical / texture-mapping helpers -------------------------

  // Apply earth's rotation so a given (lat,lng) faces the camera at +Z.
  //
  // Three.js applies Euler XYZ as M = Rx · Ry, which for a point P means
  // P'' = Rx (Ry P) — Y rotation first, then X. To take the earth-local
  // point at (lat, lng) to world (0, 0, 1):
  //   1. Rotate around Y by -(lng + 90) so the longitude lands at +Z
  //   2. Rotate around X by +lat so the latitude lifts the point to the equator
  //
  // The previous formula had the X sign flipped and a phantom +0.41 axial
  // tilt baked in, which dragged every focus off-target by ~47°. The drift
  // was barely noticeable for big landmasses (Brazil) but pushed smaller
  // ones (France) clean off the visible viewport.
  function rotForLatLng(lat, lng) {
    return {
      x: lat * Math.PI / 180,
      y: -(lng + 90) * Math.PI / 180,
    };
  }

  // Inverse — from a unit vector in the earth's local frame to lat/lng.
  function latLngFromVector(v) {
    const lat = Math.asin(v.y) * 180 / Math.PI;
    let lng = Math.atan2(v.x, v.z) * 180 / Math.PI;
    lng -= 90;
    if (lng < -180) lng += 360;
    if (lng >  180) lng -= 360;
    return { lat, lng };
  }

  // Convert a (lat,lng) on the sphere to a vec3 (in the earth's local
  // frame). Mirrors the seam adjustment used elsewhere.
  function latLngToVec3(lat, lng, radius) {
    const φ = lat * Math.PI / 180;
    const λ = lng * Math.PI / 180;
    return {
      x: Math.cos(φ) * Math.sin(λ + Math.PI / 2) * radius,
      y: Math.sin(φ) * radius,
      z: Math.cos(φ) * Math.cos(λ + Math.PI / 2) * radius,
    };
  }

  function gcDistance(a, b) {
    const toRad = Math.PI / 180;
    const φ1 = a.lat * toRad, φ2 = b.lat * toRad;
    const Δφ = (b.lat - a.lat) * toRad;
    const Δλ = (b.lng - a.lng) * toRad;
    const sin = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
    return 2 * Math.asin(Math.min(1, Math.sqrt(sin))) * 180 / Math.PI;
  }
  function nearestContinent(latlng) {
    let best = null, bestD = Infinity;
    for (const c of CONTINENTS) {
      const d = gcDistance(latlng, c);
      if (d < bestD) { best = c; bestD = d; }
    }
    return best;
  }

  // --- TopoJSON load (best-effort) --------------------------------

  async function loadCountriesData() {
    if (!window.TopoJSONMini) return;
    try {
      const res = await fetch(TOPOJSON_URL);
      if (!res.ok) return;
      const topology = await res.json();
      const features = window.TopoJSONMini.decode(topology, "countries");
      // Translate ISO numeric → alpha-2; drop entries we can't map.
      countryFeatures = features
        .map((f) => ({ ...f, alpha2: window.TopoJSONMini.numericToAlpha2(f.id) }))
        .filter((f) => f.alpha2);
    } catch (e) {
      // Silent — the menu still works on continent fallback.
    }
  }

  // --- Country detection from a click -----------------------------

  function countryAtLatLng(lat, lng) {
    if (!countryFeatures) return null;
    // We use point-in-polygon in plain (lng, lat) space — close enough
    // for visible-resolution clicks at 110m.
    for (const f of countryFeatures) {
      if (window.TopoJSONMini.pointInFeature(lng, lat, f)) {
        return { code: f.alpha2, name: f.name, feature: f };
      }
    }
    return null;
  }

  // --- Border rendering ------------------------------------------

  // Build a LineSegments mesh that traces every edge of the country.
  // We allocate the full geometry once and reveal it progressively via
  // `setDrawRange` for the draw-on animation.
  function buildBorderMesh(feature) {
    if (!THREE) return null;
    const positions = [];
    const RAD = 1.005;     // slightly above the earth's surface

    function addRing(ring) {
      // Each ring is a closed polygon — emit pairs of vertices for
      // LineSegments: (p0,p1), (p1,p2), ... (pn,p0).
      let prev = null;
      for (let i = 0; i < ring.length; i++) {
        const [lng, lat] = ring[i];
        const v = latLngToVec3(lat, lng, RAD);
        if (prev) {
          positions.push(prev.x, prev.y, prev.z, v.x, v.y, v.z);
        }
        prev = v;
      }
    }

    if (feature.type === "Polygon") {
      feature.coords.forEach(addRing);
    } else if (feature.type === "MultiPolygon") {
      feature.coords.forEach((poly) => poly.forEach(addRing));
    }

    if (positions.length === 0) return null;

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const mat = new THREE.LineBasicMaterial({
      color: 0x0b0b14,
      linewidth: 2,        // mostly ignored on WebGL but harmless
      transparent: true,
      opacity: 0.95,
      depthTest: false,    // always on top of the texture
    });
    const mesh = new THREE.LineSegments(geom, mat);
    mesh.renderOrder = 5;
    mesh.frustumCulled = false;
    geom.setDrawRange(0, 0);
    return { mesh, total: positions.length / 3 };
  }

  function clearBorders() {
    if (borderDrawHandle) { cancelAnimationFrame(borderDrawHandle); borderDrawHandle = null; }
    if (borders) {
      if (borders.geometry) borders.geometry.dispose();
      if (borders.material) borders.material.dispose();
      earth.remove(borders);
      borders = null;
    }
  }

  function drawBorders(feature) {
    clearBorders();
    const built = buildBorderMesh(feature);
    if (!built) return;
    borders = built.mesh;
    earth.add(borders);

    // Animate setDrawRange from 0 → total over BORDER_MS.
    const total = built.total;
    const BORDER_MS = 700;
    const t0 = performance.now();
    function step() {
      const t = clamp((performance.now() - t0) / BORDER_MS, 0, 1);
      const e = 1 - Math.pow(1 - t, 3);   // easeOutCubic
      const n = Math.round(e * total);
      borders.geometry.setDrawRange(0, n);
      if (t < 1) borderDrawHandle = requestAnimationFrame(step);
    }
    borderDrawHandle = requestAnimationFrame(step);
  }

  // --- Drag / tap input ------------------------------------------

  function attachInteraction(domElement) {
    let lastX = 0, lastY = 0, lastT = 0;
    let movedDist = 0;

    domElement.style.touchAction = "none";
    domElement.style.cursor = "grab";

    domElement.addEventListener("pointerdown", (e) => {
      try { domElement.setPointerCapture(e.pointerId); } catch (_) {}
      dragging = true;
      domElement.style.cursor = "grabbing";
      lastX = e.clientX; lastY = e.clientY; lastT = e.timeStamp;
      pressStart = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      movedDist = 0;
      tween = null;
      rot.velX = 0; rot.velY = 0;
    });

    domElement.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      const dt = Math.max(1, e.timeStamp - lastT);
      lastX = e.clientX; lastY = e.clientY; lastT = e.timeStamp;
      movedDist += Math.hypot(dx, dy);

      rot.y += dx * DRAG_SENS;
      rot.x += dy * DRAG_SENS;
      if (rot.x >  PITCH_LIMIT) rot.x =  PITCH_LIMIT;
      if (rot.x < -PITCH_LIMIT) rot.x = -PITCH_LIMIT;

      rot._vy = (dx * DRAG_SENS) / (dt / 33);
      rot._vx = (dy * DRAG_SENS) / (dt / 33);
    });

    function release(e) {
      if (!dragging) return;
      dragging = false;
      domElement.style.cursor = "grab";
      try { domElement.releasePointerCapture(e.pointerId); } catch (_) {}

      const totalDt = e.timeStamp - (pressStart?.t || 0);
      if (movedDist < TAP_MAX_DIST && totalDt < TAP_MAX_MS) {
        handleTap(e);
      } else {
        rot.velX = rot._vx || 0;
        rot.velY = rot._vy || 0;
        lastIdleAt = performance.now();
      }
    }
    domElement.addEventListener("pointerup",     release);
    domElement.addEventListener("pointercancel", release);
    domElement.addEventListener("pointerleave",  (e) => { if (dragging) release(e); });
  }

  function handleTap(e) {
    if (!earth || !THREE) return;
    // Force the camera + earth world matrices to match the very latest
    // rotation/position values from the tween. Without these calls,
    // setFromCamera() / worldToLocal() use whatever was cached on the
    // last render — fine on a still globe but wrong by tens of degrees
    // when the user clicks during (or immediately after) a tween.
    // This was the "2nd click is always off" bug.
    camera.updateMatrixWorld(true);
    earth.updateMatrixWorld(true);

    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(earth);
    if (!hits.length) {
      // Clicked outside the globe entirely.
      onOceanTap();
      return;
    }
    const localHit = hits[0].point.clone();
    earth.worldToLocal(localHit);
    localHit.normalize();
    const ll = latLngFromVector(localHit);

    // Country-precision attempt first; fall back to nearest continent
    // if no country contains the click (ocean) or if the topojson failed.
    const country = countryAtLatLng(ll.lat, ll.lng);
    if (country) {
      tweenTo(ll.lat, ll.lng, { zoom: true });
      placeMarker(ll.lat, ll.lng);
      drawBorders(country.feature);
      countryListeners.forEach((fn) => { try { fn(country.code, country.name); } catch (_) {} });
      return;
    }
    // No country = ocean. If we don't have country data at all, fall
    // back to the continent picker so the menu still does something.
    if (!countryFeatures) {
      const cont = nearestContinent(ll);
      if (cont) {
        tweenTo(cont.lat, cont.lng, { zoom: false });
        placeMarker(cont.lat, cont.lng);
        continentListeners.forEach((fn) => { try { fn(cont.id); } catch (_) {} });
      }
      return;
    }
    // We have country data but the click was on water — treat as a clear.
    onOceanTap();
  }

  function onOceanTap() {
    clearMarker();
    clearBorders();
    tweenTo(null, null, { zoom: false });
    countryListeners.forEach((fn) => { try { fn(null, null); } catch (_) {} });
    continentListeners.forEach((fn) => { try { fn(null); } catch (_) {} });
  }

  // --- Marker ----------------------------------------------------

  function placeMarker(lat, lng) {
    if (!THREE) return;
    if (!marker) {
      const dot = new THREE.Mesh(
        new THREE.SphereGeometry(0.025, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xf5c77e }),
      );
      const halo = new THREE.Mesh(
        new THREE.SphereGeometry(0.06, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xf5c77e, transparent: true, opacity: 0.35 }),
      );
      marker = new THREE.Group();
      marker.add(halo);
      marker.add(dot);
      earth.add(marker);
    }
    const v = latLngToVec3(lat, lng, 1.02);
    marker.position.set(v.x, v.y, v.z);
    marker.visible = true;
  }
  function clearMarker() { if (marker) marker.visible = false; }

  // --- Camera tween ----------------------------------------------

  function tweenTo(lat, lng, opts = {}) {
    const target = (lat == null || lng == null)
      ? { x: 0.18, y: rot.y }            // keep the current azimuth, level the pitch
      : rotForLatLng(lat, lng);
    const targetZ = opts.zoom ? CAM_IN_Z : CAM_OUT_Z;
    const targetY = opts.zoom ? CAM_IN_Y : CAM_OUT_Y;
    tween = {
      fromX: rot.x,  fromY: rot.y,  fromZ: camZ,  fromCamY: camY,
      toX:   target.x, toY: target.y, toZ: targetZ, toCamY: targetY,
      t0:    performance.now(),
      dur:   TWEEN_MS,
    };
  }
  function easeOutQuart(t) { return 1 - Math.pow(1 - t, 4); }

  // --- Boot ------------------------------------------------------

  async function boot() {
    if (bootAttempted) return;
    bootAttempted = true;
    const container = $("globe-canvas");
    if (!container) return;
    if (!hasWebGL()) { showFallback(); return; }

    // Load Three.js + TopoJSON in parallel.
    const [maybeThree] = await Promise.all([
      import(THREE_URL).catch(() => null),
      loadCountriesData(),
    ]);
    if (!maybeThree) { showFallback(); return; }
    THREE = maybeThree;

    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 100);
    camera.position.set(0, CAM_OUT_Y, CAM_OUT_Z);

    const loader = new THREE.TextureLoader();
    loader.crossOrigin = "anonymous";
    earth = new THREE.Mesh(
      new THREE.SphereGeometry(1, 48, 48),
      new THREE.MeshBasicMaterial({ color: 0x1a2a52 }),
    );
    scene.add(earth);
    loader.load(EARTH_TEXTURE_URL, (tex) => {
      earth.material = new THREE.MeshBasicMaterial({ map: tex });
    });

    // Atmosphere — back-side Fresnel rim glow.
    //
    // Soft cool-white tint matching what a real atmosphere looks like
    // from space (vs. the previous saturated amber, which dominated
    // the screen). Lower exponent + lower max alpha keeps it subtle.
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader:
        "varying vec3 vNormal; void main() { vNormal = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
      fragmentShader:
        "varying vec3 vNormal; void main() { float i = pow(0.65 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.4); gl_FragColor = vec4(0.55, 0.72, 0.95, 0.55) * i; }",
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
    });
    atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.16, 48, 48), atmoMat);
    scene.add(atmosphere);

    attachInteraction(renderer.domElement);

    const TICK_MS = 1000 / 30;
    function tick() {
      // Camera + rotation tween.
      if (tween) {
        const t = Math.min(1, (performance.now() - tween.t0) / tween.dur);
        const e = easeOutQuart(t);
        rot.x = tween.fromX    + (tween.toX    - tween.fromX)    * e;
        rot.y = tween.fromY    + (tween.toY    - tween.fromY)    * e;
        camZ  = tween.fromZ    + (tween.toZ    - tween.fromZ)    * e;
        camY  = tween.fromCamY + (tween.toCamY - tween.fromCamY) * e;
        camera.position.set(0, camY, camZ);
        if (t >= 1) { tween = null; lastIdleAt = performance.now(); }
      } else if (!dragging) {
        if (Math.abs(rot.velX) > 0.0001 || Math.abs(rot.velY) > 0.0001) {
          rot.x += rot.velX;
          rot.y += rot.velY;
          rot.velX *= VEL_DECAY;
          rot.velY *= VEL_DECAY;
          if (rot.x >  PITCH_LIMIT) { rot.x =  PITCH_LIMIT; rot.velX = 0; }
          if (rot.x < -PITCH_LIMIT) { rot.x = -PITCH_LIMIT; rot.velX = 0; }
          lastIdleAt = performance.now();
        } else if (performance.now() - lastIdleAt > IDLE_RESUME_MS && camZ > CAM_OUT_Z - 0.05) {
          // Only auto-spin when fully zoomed out.
          rot.y += AUTO_DRIFT_Y;
        }
      }

      earth.rotation.x = rot.x;
      earth.rotation.y = rot.y;
      atmosphere.rotation.x = rot.x;
      atmosphere.rotation.y = rot.y;

      renderer.render(scene, camera);
    }
    renderTimer = setInterval(tick, TICK_MS);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden && renderTimer) {
        clearInterval(renderTimer); renderTimer = null;
      } else if (!document.hidden && !renderTimer) {
        renderTimer = setInterval(tick, TICK_MS);
      }
    });

    window.addEventListener("resize", () => {
      const w2 = container.clientWidth, h2 = container.clientHeight;
      if (w2 && h2 && renderer) {
        renderer.setSize(w2, h2);
        camera.aspect = w2 / h2;
        camera.updateProjectionMatrix();
      }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    const menu = $("screen-menu");
    if (menu && menu.classList.contains("screen-active")) boot();
    const observer = new MutationObserver(() => {
      if (menu && menu.classList.contains("screen-active")) {
        boot(); observer.disconnect();
      }
    });
    if (menu) observer.observe(menu, { attributes: true, attributeFilter: ["class"] });
  });

  // Find a country feature by alpha-2 code (loaded TopoJSON only).
  function featureByCode(code) {
    if (!countryFeatures) return null;
    return countryFeatures.find((f) => f.alpha2 === code) || null;
  }

  // Compute a representative lat/lng for a country — naive centroid of
  // its first ring. Good enough for camera framing.
  function countryCentroid(feature) {
    let ring;
    if (feature.type === "Polygon") ring = feature.coords[0];
    else if (feature.type === "MultiPolygon") {
      // Pick the largest ring (most vertices = main landmass).
      let best = null, bestN = 0;
      for (const poly of feature.coords) {
        if (poly[0] && poly[0].length > bestN) { best = poly[0]; bestN = poly[0].length; }
      }
      ring = best;
    }
    if (!ring || !ring.length) return null;
    let sx = 0, sy = 0;
    for (const [lng, lat] of ring) { sx += lng; sy += lat; }
    return { lat: sy / ring.length, lng: sx / ring.length };
  }

  // Public: focus a country by code — tween + zoom + border draw +
  // notify listeners (so menu's setCountry path fires too).
  function focusCountry(code, name) {
    const feature = featureByCode(code);
    if (!feature) return false;
    const c = countryCentroid(feature);
    if (!c) return false;
    tweenTo(c.lat, c.lng, { zoom: true });
    placeMarker(c.lat, c.lng);
    drawBorders(feature);
    countryListeners.forEach((fn) => { try { fn(code, name || feature.name); } catch (_) {} });
    return true;
  }

  window.Globe = {
    boot,
    isSupported: () => supported,
    onContinentSelected(fn) { continentListeners.add(fn); return () => continentListeners.delete(fn); },
    onCountrySelected(fn)   { countryListeners.add(fn);   return () => countryListeners.delete(fn); },
    focusContinent(id) {
      const c = CONTINENTS.find((x) => x.id === id);
      if (c) { tweenTo(c.lat, c.lng, { zoom: false }); placeMarker(c.lat, c.lng); }
    },
    focusCountry,
    clearSelection() {
      clearMarker(); clearBorders(); tweenTo(null, null, { zoom: false });
    },
    continents: CONTINENTS,
  };
})();
