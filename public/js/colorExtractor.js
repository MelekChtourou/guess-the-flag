// Pulls the dominant "branding" color out of a country's flag.
//
// The big-picture goal: when the country panel opens, subtly tint the UI
// toward the country's own primary color (Spotify-style). Pure client-side,
// no API needed — we already have the flag image; we just sample it.
//
// Algorithm:
//   1. Load the small flag thumbnail (32×21 from flagcdn) into a canvas.
//   2. For each pixel, score it by saturation × inverse-of-blandness.
//      We deliberately down-weight pure white, pure black, and grey so a
//      flag like Japan (white field + red disc) returns red, not white.
//   3. Quantize colors into ~12 buckets and pick the highest-scoring bucket.
//   4. Cache the result by country code so we only sample once per session.

(function () {
  const cache = new Map();      // code -> "#rrggbb"
  const inflight = new Map();   // code -> Promise

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    const s = max === 0 ? 0 : d / max;
    const v = max;
    if (d !== 0) {
      switch (max) {
        case r: h = ((g - b) / d) % 6; break;
        case g: h = ((b - r) / d) + 2; break;
        case b: h = ((r - g) / d) + 4; break;
      }
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s, v };
  }

  function toHex(r, g, b) {
    const c = (n) => n.toString(16).padStart(2, "0");
    return `#${c(r)}${c(g)}${c(b)}`;
  }

  // Quantize a hue into one of 12 buckets (every 30°). Saturation/value
  // are quantized separately into 3 bins. This collapses near-identical
  // shades so the histogram has signal.
  function bucket(h, s, v) {
    const hb = Math.floor(h / 30);
    const sb = s < 0.4 ? 0 : s < 0.75 ? 1 : 2;
    const vb = v < 0.35 ? 0 : v < 0.7 ? 1 : 2;
    return `${hb}-${sb}-${vb}`;
  }

  async function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = url;
    });
  }

  async function extract(code) {
    if (cache.has(code)) return cache.get(code);
    if (inflight.has(code)) return inflight.get(code);

    const promise = (async () => {
      try {
        // Use the 80px flag — small enough to sample fast, big enough
        // to have full color information.
        const img = await loadImage(`https://flagcdn.com/w80/${code}.png`);
        const W = img.naturalWidth || 80;
        const H = img.naturalHeight || Math.round(W * 0.6);
        const canvas = document.createElement("canvas");
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0);
        const { data } = ctx.getImageData(0, 0, W, H);

        // Tally weighted-by-score buckets.
        const buckets = new Map();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
          if (a < 128) continue;
          const { h, s, v } = rgbToHsv(r, g, b);

          // Score: penalize unsaturated and very-bright/very-dark colors.
          // We want vibrant brand colors, not the white field of a tricolor.
          if (s < 0.2 || v < 0.15 || v > 0.97) continue;
          const score = s * (1 - Math.abs(v - 0.55) * 0.6);
          const key = bucket(h, s, v);
          const prev = buckets.get(key);
          if (prev) {
            prev.score += score;
            prev.r += r; prev.g += g; prev.b += b;
            prev.n += 1;
          } else {
            buckets.set(key, { score, r, g, b, n: 1 });
          }
        }

        if (buckets.size === 0) {
          // Pure b&w or unreadable — fall back to a neutral accent.
          const fallback = "#f5c77e";
          cache.set(code, fallback);
          return fallback;
        }

        // Pick the bucket with the highest accumulated score.
        let best = null;
        for (const v of buckets.values()) {
          if (!best || v.score > best.score) best = v;
        }
        const r = Math.round(best.r / best.n);
        const g = Math.round(best.g / best.n);
        const b = Math.round(best.b / best.n);
        const hex = toHex(r, g, b);
        cache.set(code, hex);
        return hex;
      } catch (e) {
        // Network / CORS / drawing failure — neutral fallback.
        const fallback = "#f5c77e";
        cache.set(code, fallback);
        return fallback;
      } finally {
        inflight.delete(code);
      }
    })();

    inflight.set(code, promise);
    return promise;
  }

  // Apply the extracted color as a CSS custom property scoped to a
  // specific element (so it doesn't bleed into the rest of the UI).
  function applyTo(element, hex) {
    if (!element) return;
    element.style.setProperty("--country-accent", hex);
    // Also set a soft variant for backgrounds (~16% alpha).
    element.style.setProperty("--country-accent-soft", hexToRgba(hex, 0.18));
  }

  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return `rgba(245, 199, 126, ${alpha})`;
    return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
  }

  window.ColorExtractor = { extract, applyTo };
})();
