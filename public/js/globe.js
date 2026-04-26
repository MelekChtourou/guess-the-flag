// 3D rotating Atlas globe.
//
// Now drives the full-screen menu. Three layers of interactivity:
//   1. Drag/touch to spin the planet (with momentum).
//   2. Tap a continent → camera tweens cinematically to face it.
//   3. A glowing pin marks the selected continent until you clear it.
//
// Continents are detected by raycasting the click against the sphere,
// converting the hit point to lat/lng, then matching to the closest
// continent centroid. No SVG / map texture overlay — just math.
//
// If WebGL is unavailable or Three.js fails to load, we silently leave
// the container empty and unhide the hero fallback so the menu still
// has *some* visual, just static.

(function () {
  const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
  const EARTH_TEXTURE_URL = "https://unpkg.com/three-globe@2.30.0/example/img/earth-blue-marble.jpg";

  // Continent centroids — used both to convert a click to a region and
  // to animate the camera to a region when the menu controller asks.
  const CONTINENTS = [
    { id: "Africa",        lat:   2,   lng:  17 },
    { id: "Asia",          lat:  35,   lng: 100 },
    { id: "Europe",        lat:  52,   lng:  15 },
    { id: "North America", lat:  45,   lng: -100 },
    { id: "South America", lat: -15,   lng: -60 },
    { id: "Oceania",       lat: -22,   lng: 140 },
  ];

  let renderer, scene, camera, earth, atmosphere, marker, THREE;
  let renderTimer = null;
  let bootAttempted = false;
  let supported = true;

  // Rotation + interaction state.
  const rot = { x: 0.41, y: 0, velX: 0, velY: 0 };
  const AUTO_DRIFT_Y = 0.0025;
  const VEL_DECAY    = 0.94;
  const DRAG_SENS    = 0.005;
  const PITCH_LIMIT  = 1.2;
  let dragging = false;
  let lastIdleAt = 0;
  const IDLE_RESUME_MS = 1500;

  // Camera tween state.
  let tween = null;        // { fromX, fromY, toX, toY, t0, dur }
  const TWEEN_MS = 1300;

  // Track movement during a press to distinguish drag from tap.
  let pressStart = null;   // { x, y, t }
  const TAP_MAX_DIST = 8;
  const TAP_MAX_MS   = 350;

  // External listeners — populated by the menu controller.
  const continentListeners = new Set();

  function $(id) { return document.getElementById(id); }

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

  // --- Spherical coords helpers ------------------------------------

  // Convert lat/lng (degrees) to the world-space rotation pair (x, y) we
  // need to apply to the earth so that point faces the camera.
  // The camera looks down +Z; we want lat/lng to be at (0, 0, 1).
  function rotForLatLng(lat, lng) {
    // Account for the earth's natural axial tilt that's baked into rot.x.
    return {
      x: -lat * Math.PI / 180 + 0.41,
      y: -(lng + 90) * Math.PI / 180,   // texture seam adjustment
    };
  }

  // Inverse: given a hit point on the sphere (in earth-local coords),
  // convert to lat/lng.
  function latLngFromVector(v) {
    // v is a unit vector in the earth's local frame. The texture is
    // mapped so that lat/lng follows the standard equirectangular layout.
    // Lat = arcsin(y); lng comes from atan2(x, z) with the same seam
    // adjustment used in rotForLatLng.
    const lat = Math.asin(v.y) * 180 / Math.PI;
    let lng = Math.atan2(v.x, v.z) * 180 / Math.PI;
    lng = lng - 90;
    if (lng < -180) lng += 360;
    if (lng >  180) lng -= 360;
    return { lat, lng };
  }

  // Greatest-circle distance in degrees between two lat/lng (rough — we
  // only need it for picking the nearest continent centroid).
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

  // --- Drag / tap handling -----------------------------------------

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
      tween = null;       // any in-flight camera tween is cancelled by user touch
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
      // If it was a tap (small movement, short duration) → continent select.
      if (movedDist < TAP_MAX_DIST && totalDt < TAP_MAX_MS) {
        handleTap(e);
      } else {
        // Real drag → keep momentum.
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
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top)  / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObject(earth);
    if (!hits.length) return;
    // Hit point in WORLD space — convert back into the earth's LOCAL
    // space so latLngFromVector reads off the texture's lat/lng grid.
    const localHit = hits[0].point.clone();
    earth.worldToLocal(localHit);
    localHit.normalize();
    const ll = latLngFromVector(localHit);
    const continent = nearestContinent(ll);
    if (continent) {
      tweenTo(continent.lat, continent.lng);
      placeMarker(continent.lat, continent.lng);
      continentListeners.forEach((fn) => { try { fn(continent.id); } catch (_) {} });
    }
  }

  // --- Marker (small glowing pin on the picked continent) ----------

  function placeMarker(lat, lng) {
    if (!THREE) return;
    if (!marker) {
      // Two stacked sprites: a soft glow + a sharp dot.
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
    // Convert lat/lng to a local-space position 1.0 from earth center.
    const φ = lat * Math.PI / 180;
    const λ = lng * Math.PI / 180;
    // Mirror the seam adjustment used elsewhere.
    const rad = 1.02;
    marker.position.set(
       Math.cos(φ) * Math.sin(λ + Math.PI / 2) * rad,
       Math.sin(φ) * rad,
       Math.cos(φ) * Math.cos(λ + Math.PI / 2) * rad,
    );
    marker.visible = true;
  }

  function clearMarker() { if (marker) marker.visible = false; }

  // --- Camera tween ------------------------------------------------

  function tweenTo(lat, lng) {
    const target = rotForLatLng(lat, lng);
    tween = {
      fromX: rot.x, fromY: rot.y,
      toX: target.x, toY: target.y,
      t0: performance.now(),
      dur: TWEEN_MS,
    };
  }

  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  // --- Boot --------------------------------------------------------

  async function boot() {
    if (bootAttempted) return;
    bootAttempted = true;
    const container = $("globe-canvas");
    if (!container) return;
    if (!hasWebGL()) { showFallback(); return; }

    try {
      THREE = await import(THREE_URL);
    } catch (e) {
      showFallback(); return;
    }

    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 100);
    camera.position.set(0, 0, 4);

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

    // Atmosphere — Fresnel-style rim glow (back-side, additive).
    const atmoMat = new THREE.ShaderMaterial({
      vertexShader: `
        varying vec3 vNormal;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        varying vec3 vNormal;
        void main() {
          float intensity = pow(0.7 - dot(vNormal, vec3(0.0, 0.0, 1.0)), 2.0);
          gl_FragColor = vec4(0.96, 0.78, 0.49, 1.0) * intensity;
        }
      `,
      blending: THREE.AdditiveBlending,
      side: THREE.BackSide,
      transparent: true,
    });
    atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.20, 48, 48), atmoMat);
    scene.add(atmosphere);

    attachInteraction(renderer.domElement);

    const TICK_MS = 1000 / 30;
    function tick() {
      // Run the camera tween if active.
      if (tween) {
        const t = Math.min(1, (performance.now() - tween.t0) / tween.dur);
        const e = easeOutCubic(t);
        rot.x = tween.fromX + (tween.toX - tween.fromX) * e;
        rot.y = tween.fromY + (tween.toY - tween.fromY) * e;
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
        } else if (performance.now() - lastIdleAt > IDLE_RESUME_MS) {
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

    // Resize — full-screen menu changes a lot on rotation/keyboard.
    window.addEventListener("resize", () => {
      const w2 = container.clientWidth, h2 = container.clientHeight;
      if (w2 && h2 && renderer) {
        renderer.setSize(w2, h2);
        camera.aspect = w2 / h2;
        camera.updateProjectionMatrix();
      }
    });
  }

  // Boot when the menu screen is actually visible.
  document.addEventListener("DOMContentLoaded", () => {
    const menu = $("screen-menu");
    if (menu && menu.classList.contains("screen-active")) boot();
    const observer = new MutationObserver(() => {
      if (menu && menu.classList.contains("screen-active")) {
        boot();
        observer.disconnect();
      }
    });
    if (menu) observer.observe(menu, { attributes: true, attributeFilter: ["class"] });
  });

  // Public API for the menu controller.
  window.Globe = {
    boot,
    isSupported: () => supported,
    onContinentSelected(fn) { continentListeners.add(fn); return () => continentListeners.delete(fn); },
    focusContinent(id) {
      const c = CONTINENTS.find((x) => x.id === id);
      if (c) { tweenTo(c.lat, c.lng); placeMarker(c.lat, c.lng); }
    },
    clearSelection() { clearMarker(); },
    continents: CONTINENTS,
  };
})();
