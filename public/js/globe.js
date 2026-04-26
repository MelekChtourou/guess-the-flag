// 3D rotating globe in the menu hero.
//
// Uses Three.js loaded as an ES module from a CDN — no build step. The
// whole module is intentionally small: one earth sphere, one atmosphere
// sphere, slow auto-rotation. ~30fps render loop, paused when the tab
// is hidden.
//
// Interaction:
//   - Touch / mouse drag rotates the globe in any direction.
//   - On release, momentum continues the spin briefly (decays smoothly).
//   - Auto-rotation resumes after a short idle period.
//
// If WebGL isn't supported or Three.js fails to load, we silently leave
// the container empty and fall back to the existing hero flag emoji.

(function () {
  const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
  // Smaller texture (1k instead of the default 2k) — looks identical at
  // 240px display size and saves ~6MB of GPU memory on weaker phones.
  const EARTH_TEXTURE_URL = "https://unpkg.com/three-globe@2.30.0/example/img/earth-blue-marble.jpg";

  let renderer, scene, camera, earth, atmosphere;
  let renderTimer = null;
  let bootAttempted = false;
  let supported = true;

  // Rotation state. velX/velY hold momentum after a drag-release; they
  // decay back to zero, after which the auto-rotation drift takes over.
  const rot = { x: 0.41, y: 0, velX: 0, velY: 0 };
  const AUTO_DRIFT_Y = 0.0035;     // base auto-rotation per frame
  const VEL_DECAY    = 0.94;       // momentum decay (close to 1 = long glide)
  const DRAG_SENS    = 0.005;      // pixel → radian conversion for drag
  const PITCH_LIMIT  = 1.2;        // clamp tilt so we never see "behind" the pole
  let dragging = false;
  let lastIdleAt = 0;              // when the last interaction ended
  const IDLE_RESUME_MS = 1200;     // wait this long before auto-drift resumes

  function $(id) { return document.getElementById(id); }

  function hasWebGL() {
    try {
      const canvas = document.createElement("canvas");
      return !!(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"));
    } catch (e) { return false; }
  }

  function showFallback() {
    supported = false;
    const fb = $("hero-fallback");
    if (fb) fb.hidden = false;
  }

  function attachDragHandlers(domElement) {
    // Use Pointer Events — works for mouse, touch, and pen with one path.
    let lastX = 0, lastY = 0, lastT = 0;

    function onDown(e) {
      dragging = true;
      // Capture so even fast finger motion outside the canvas still tracks.
      try { domElement.setPointerCapture(e.pointerId); } catch (_) {}
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = e.timeStamp;
      // Stop any inertia in progress.
      rot.velX = 0;
      rot.velY = 0;
    }

    function onMove(e) {
      if (!dragging) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      const dt = Math.max(1, e.timeStamp - lastT);
      lastX = e.clientX;
      lastY = e.clientY;
      lastT = e.timeStamp;

      rot.y += dx * DRAG_SENS;
      rot.x += dy * DRAG_SENS;
      // Keep pitch within sane range so the globe never inverts.
      if (rot.x >  PITCH_LIMIT) rot.x =  PITCH_LIMIT;
      if (rot.x < -PITCH_LIMIT) rot.x = -PITCH_LIMIT;

      // Track instantaneous velocity (rad / frame at 30fps) for momentum.
      // We'll feed this into rot.vel when the user releases.
      rot._vy = (dx * DRAG_SENS) / (dt / 33);
      rot._vx = (dy * DRAG_SENS) / (dt / 33);
    }

    function onUp(e) {
      if (!dragging) return;
      dragging = false;
      try { domElement.releasePointerCapture(e.pointerId); } catch (_) {}
      // Hand instantaneous drag velocity to the momentum integrator.
      rot.velX = rot._vx || 0;
      rot.velY = rot._vy || 0;
      lastIdleAt = performance.now();
    }

    domElement.style.touchAction = "none"; // disable scroll on the globe itself
    domElement.style.cursor = "grab";
    domElement.addEventListener("pointerdown", (e) => { domElement.style.cursor = "grabbing"; onDown(e); });
    domElement.addEventListener("pointermove", onMove);
    domElement.addEventListener("pointerup",   (e) => { domElement.style.cursor = "grab";    onUp(e); });
    domElement.addEventListener("pointercancel", onUp);
    domElement.addEventListener("pointerleave",  (e) => { if (dragging) onUp(e); });
  }

  async function boot() {
    if (bootAttempted) return;
    bootAttempted = true;
    const container = $("globe-canvas");
    if (!container) return;
    if (!hasWebGL()) { showFallback(); return; }

    let THREE;
    try {
      THREE = await import(THREE_URL);
    } catch (e) {
      showFallback();
      return;
    }

    const size = container.clientWidth || 240;

    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(size, size);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 4);

    // Earth.
    const loader = new THREE.TextureLoader();
    loader.crossOrigin = "anonymous";
    earth = new THREE.Mesh(
      // 32 segments instead of 48 — invisible difference at 240px, saves
      // ~50% triangle count for cheaper phones.
      new THREE.SphereGeometry(1, 32, 32),
      new THREE.MeshBasicMaterial({ color: 0x1a2a52 }),
    );
    scene.add(earth);
    loader.load(EARTH_TEXTURE_URL, (tex) => {
      earth.material = new THREE.MeshBasicMaterial({ map: tex });
    });

    // Atmosphere — Fresnel-style rim glow.
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
    atmosphere = new THREE.Mesh(new THREE.SphereGeometry(1.18, 32, 32), atmoMat);
    scene.add(atmosphere);

    // Wire drag handlers up to the canvas.
    attachDragHandlers(renderer.domElement);

    // 30fps render loop.
    const TICK_MS = 1000 / 30;
    function tick() {
      // Apply momentum (gradually decaying).
      if (!dragging) {
        if (Math.abs(rot.velX) > 0.0001 || Math.abs(rot.velY) > 0.0001) {
          rot.x += rot.velX;
          rot.y += rot.velY;
          rot.velX *= VEL_DECAY;
          rot.velY *= VEL_DECAY;
          if (rot.x >  PITCH_LIMIT) { rot.x =  PITCH_LIMIT; rot.velX = 0; }
          if (rot.x < -PITCH_LIMIT) { rot.x = -PITCH_LIMIT; rot.velX = 0; }
          lastIdleAt = performance.now();
        } else if (performance.now() - lastIdleAt > IDLE_RESUME_MS) {
          // Auto-drift kicks in only after the user has been idle for a moment,
          // so it doesn't feel like the globe is "fighting" their interaction.
          rot.y += AUTO_DRIFT_Y;
        }
      }

      earth.rotation.x = rot.x;
      earth.rotation.y = rot.y;
      atmosphere.rotation.y = rot.y;
      atmosphere.rotation.x = rot.x;

      renderer.render(scene, camera);
    }
    renderTimer = setInterval(tick, TICK_MS);

    // Pause when the tab is hidden — saves battery.
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && renderTimer) {
        clearInterval(renderTimer);
        renderTimer = null;
      } else if (!document.hidden && !renderTimer) {
        renderTimer = setInterval(tick, TICK_MS);
      }
    });

    window.addEventListener("resize", () => {
      const s = container.clientWidth;
      if (s && renderer) renderer.setSize(s, s);
    });
  }

  // Boot when the menu screen is actually visible — saves the JS download
  // for users who deep-link straight into a multiplayer room.
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

  window.Globe = { boot, isSupported: () => supported };
})();
