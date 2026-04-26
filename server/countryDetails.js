// Fetches rich detail for a single country and caches it in memory.
//
// Two upstream sources, both free and key-less:
//
//   restcountries.com  → structured facts (capital, population, languages,
//                        currencies, region, area, neighbors, timezones)
//   en.wikipedia.org   → one-paragraph intro + a thumbnail photo
//
// Each upstream is best-effort — if either fails, we still return what we
// have. Results are cached forever in this process: the dataset doesn't
// change minute-to-minute and we'd rather avoid hammering free APIs.

const cache = new Map();          // ISO-2 lowercase -> details object
const inflight = new Map();       // ISO-2 lowercase -> Promise (dedupes concurrent fetches)

const REST_COUNTRIES_FIELDS = [
  "name", "capital", "population", "area", "region", "subregion",
  "languages", "currencies", "timezones", "borders", "flag", "maps",
].join(",");

async function fetchJson(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "GuessTheFlag/1.0 (game; thelandlordrentals@gmail.com)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchRestCountries(code) {
  const url = `https://restcountries.com/v3.1/alpha/${code}?fields=${REST_COUNTRIES_FIELDS}`;
  const data = await fetchJson(url);
  // Endpoint returns either an array or a single object depending on the path.
  const c = Array.isArray(data) ? data[0] : data;
  if (!c) return null;
  return {
    capital: (c.capital && c.capital[0]) || null,
    population: c.population || null,
    area: c.area || null,
    region: c.region || null,
    subregion: c.subregion || null,
    languages: c.languages ? Object.values(c.languages) : [],
    currencies: c.currencies
      ? Object.values(c.currencies).map((cur) => cur.name).filter(Boolean)
      : [],
    timezones: c.timezones || [],
    borders: c.borders || [],
    mapUrl: (c.maps && c.maps.googleMaps) || null,
  };
}

async function fetchWikipedia(name) {
  // Wikipedia REST summary endpoint. URL-encode the title and use redirect=true
  // so e.g. "South Korea" lands on the full article, not the disambiguator.
  const title = encodeURIComponent(name.replace(/ /g, "_"));
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${title}?redirect=true`;
  const data = await fetchJson(url);
  if (!data || data.type === "disambiguation") return null;
  return {
    intro: data.extract || null,
    // Thumbnail is small (~300px). originalimage is full-res — used as
    // the cinematic hero in the reveal panel. Keep both: clients that
    // can't display the hero (e.g. low-bandwidth) can fall back.
    photo:        (data.thumbnail && data.thumbnail.source) || null,
    photoWidth:   (data.thumbnail && data.thumbnail.width)  || null,
    photoHeight:  (data.thumbnail && data.thumbnail.height) || null,
    photoFull:    (data.originalimage && data.originalimage.source) || null,
    photoFullW:   (data.originalimage && data.originalimage.width)  || null,
    photoFullH:   (data.originalimage && data.originalimage.height) || null,
    wikiUrl:      (data.content_urls && data.content_urls.desktop && data.content_urls.desktop.page) || null,
  };
}

async function loadDetails(code, name) {
  const key = code.toLowerCase();
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  // Fetch both in parallel; tolerate individual failures.
  const promise = (async () => {
    const [restResult, wikiResult] = await Promise.allSettled([
      fetchRestCountries(key),
      fetchWikipedia(name),
    ]);
    const details = {
      code: key,
      name,
      ...(restResult.status === "fulfilled" && restResult.value ? restResult.value : {}),
      ...(wikiResult.status === "fulfilled" && wikiResult.value ? wikiResult.value : {}),
    };
    cache.set(key, details);
    inflight.delete(key);
    return details;
  })();

  inflight.set(key, promise);
  return promise;
}

module.exports = { loadDetails };
