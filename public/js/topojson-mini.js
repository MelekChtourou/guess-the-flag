// Minimal TopoJSON decoder + ISO numeric → alpha-2 country lookup.
//
// Just enough to take the Natural Earth 110m world atlas
// (`/data/world-110m.json`) and produce, for each country, a polygon
// ring of [lng, lat] pairs in plain GeoJSON-ish coordinates.
//
// Why not pull `topojson-client` from a CDN: ~6KB and an extra request,
// but more importantly we need exactly two functions out of it. Inlining
// avoids a runtime dependency for offline / PWA use.

(function () {
  // --- TopoJSON decoder --------------------------------------------

  // Apply the topology's affine transform + delta-decode to a single
  // arc, returning an array of [x, y] points in original coords.
  function decodeArc(arc, transform) {
    const x0 = transform.translate[0];
    const y0 = transform.translate[1];
    const sx = transform.scale[0];
    const sy = transform.scale[1];
    const out = new Array(arc.length);
    let x = 0, y = 0;
    for (let i = 0; i < arc.length; i++) {
      x += arc[i][0];
      y += arc[i][1];
      out[i] = [x * sx + x0, y * sy + y0];
    }
    return out;
  }

  // Stitch a list of arc indices into a continuous coordinate ring.
  // Negative index ~i means "arc i, reversed".
  function stitchRing(arcRefs, decodedArcs) {
    const ring = [];
    for (const ref of arcRefs) {
      const reverse = ref < 0;
      const idx = reverse ? ~ref : ref;
      const arc = decodedArcs[idx];
      if (!arc) continue;
      const part = reverse ? arc.slice().reverse() : arc;
      // Avoid duplicating the seam point between consecutive arcs.
      if (ring.length > 0) ring.pop();
      ring.push(...part);
    }
    return ring;
  }

  // Convert a single TopoJSON geometry to GeoJSON-like coordinates.
  // Polygon → [ring, ring, ...]
  // MultiPolygon → [[ring,...], [ring,...]]
  function geometryCoords(geom, decodedArcs) {
    if (geom.type === "Polygon") {
      return geom.arcs.map((arcRefs) => stitchRing(arcRefs, decodedArcs));
    }
    if (geom.type === "MultiPolygon") {
      return geom.arcs.map((poly) =>
        poly.map((arcRefs) => stitchRing(arcRefs, decodedArcs))
      );
    }
    return null;
  }

  // Public: take a Topology + an object name, return a list of
  // { id, name, type, coords } features.
  function decode(topology, objectName) {
    const obj = topology.objects[objectName];
    if (!obj || !obj.geometries) return [];
    const decodedArcs = topology.arcs.map((a) => decodeArc(a, topology.transform));
    return obj.geometries.map((g) => ({
      id:     g.id,
      name:   g.properties && g.properties.name,
      type:   g.type,
      coords: geometryCoords(g, decodedArcs),
    }));
  }

  // --- Point-in-polygon -------------------------------------------

  // Standard ray-casting: cast a horizontal ray east from (x, y), count
  // the number of polygon edges it crosses. Odd = inside.
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      const intersect = ((yi > y) !== (yj > y))
        && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  // Polygon = [outer, hole1, hole2, ...]. Point inside if inside outer
  // but not inside any hole.
  function pointInPolygon(x, y, polygon) {
    if (!polygon || polygon.length === 0) return false;
    if (!pointInRing(x, y, polygon[0])) return false;
    for (let i = 1; i < polygon.length; i++) {
      if (pointInRing(x, y, polygon[i])) return false;
    }
    return true;
  }

  // Given a feature (Polygon or MultiPolygon), test the point.
  function pointInFeature(lng, lat, feat) {
    if (!feat.coords) return false;
    if (feat.type === "Polygon") return pointInPolygon(lng, lat, feat.coords);
    if (feat.type === "MultiPolygon") {
      for (const poly of feat.coords) {
        if (pointInPolygon(lng, lat, poly)) return true;
      }
    }
    return false;
  }

  // --- ISO numeric → alpha-2 lookup -------------------------------
  //
  // The TopoJSON identifies countries by their ISO 3166-1 numeric code
  // (M.49). We use the alpha-2 codes everywhere else (flagcdn URLs,
  // server/countries.js etc), so map between them.
  //
  // Source: ISO 3166-1 official list. Includes all countries that
  // appear in the Natural Earth 110m dataset.

  const NUMERIC_TO_ALPHA2 = {
    "004":"af","008":"al","010":"aq","012":"dz","016":"as","020":"ad","024":"ao",
    "028":"ag","031":"az","032":"ar","036":"au","040":"at","044":"bs","048":"bh",
    "050":"bd","051":"am","052":"bb","056":"be","060":"bm","064":"bt","068":"bo",
    "070":"ba","072":"bw","074":"bv","076":"br","084":"bz","086":"io","090":"sb",
    "092":"vg","096":"bn","100":"bg","104":"mm","108":"bi","112":"by","116":"kh",
    "120":"cm","124":"ca","132":"cv","136":"ky","140":"cf","144":"lk","148":"td",
    "152":"cl","156":"cn","158":"tw","162":"cx","166":"cc","170":"co","174":"km",
    "175":"yt","178":"cg","180":"cd","184":"ck","188":"cr","191":"hr","192":"cu",
    "196":"cy","203":"cz","204":"bj","208":"dk","212":"dm","214":"do","218":"ec",
    "222":"sv","226":"gq","231":"et","232":"er","233":"ee","234":"fo","238":"fk",
    "239":"gs","242":"fj","246":"fi","248":"ax","250":"fr","254":"gf","258":"pf",
    "260":"tf","262":"dj","266":"ga","268":"ge","270":"gm","275":"ps","276":"de",
    "288":"gh","292":"gi","296":"ki","300":"gr","304":"gl","308":"gd","312":"gp",
    "316":"gu","320":"gt","324":"gn","328":"gy","332":"ht","334":"hm","336":"va",
    "340":"hn","344":"hk","348":"hu","352":"is","356":"in","360":"id","364":"ir",
    "368":"iq","372":"ie","376":"il","380":"it","384":"ci","388":"jm","392":"jp",
    "398":"kz","400":"jo","404":"ke","408":"kp","410":"kr","414":"kw","417":"kg",
    "418":"la","422":"lb","426":"ls","428":"lv","430":"lr","434":"ly","438":"li",
    "440":"lt","442":"lu","446":"mo","450":"mg","454":"mw","458":"my","462":"mv",
    "466":"ml","470":"mt","474":"mq","478":"mr","480":"mu","484":"mx","492":"mc",
    "496":"mn","498":"md","499":"me","500":"ms","504":"ma","508":"mz","512":"om",
    "516":"na","520":"nr","524":"np","528":"nl","531":"cw","533":"aw","534":"sx",
    "535":"bq","540":"nc","548":"vu","554":"nz","558":"ni","562":"ne","566":"ng",
    "570":"nu","574":"nf","578":"no","580":"mp","581":"um","583":"fm","584":"mh",
    "585":"pw","586":"pk","591":"pa","598":"pg","600":"py","604":"pe","608":"ph",
    "612":"pn","616":"pl","620":"pt","624":"gw","626":"tl","630":"pr","634":"qa",
    "638":"re","642":"ro","643":"ru","646":"rw","652":"bl","654":"sh","659":"kn",
    "660":"ai","662":"lc","663":"mf","666":"pm","670":"vc","674":"sm","678":"st",
    "682":"sa","686":"sn","688":"rs","690":"sc","694":"sl","702":"sg","703":"sk",
    "704":"vn","705":"si","706":"so","710":"za","716":"zw","724":"es","728":"ss",
    "729":"sd","732":"eh","740":"sr","744":"sj","748":"sz","752":"se","756":"ch",
    "760":"sy","762":"tj","764":"th","768":"tg","772":"tk","776":"to","780":"tt",
    "784":"ae","788":"tn","792":"tr","795":"tm","796":"tc","798":"tv","800":"ug",
    "804":"ua","807":"mk","818":"eg","826":"gb","831":"gg","832":"je","833":"im",
    "834":"tz","840":"us","850":"vi","854":"bf","858":"uy","860":"uz","862":"ve",
    "876":"wf","882":"ws","887":"ye","894":"zm",
    // Special / Natural Earth-specific
    "-99":null,    // unknown / disputed (Western Sahara, etc.)
  };

  function numericToAlpha2(numeric) {
    if (numeric == null) return null;
    // The TopoJSON ids can be strings or numbers; pad to 3 digits.
    const padded = String(numeric).padStart(3, "0");
    return NUMERIC_TO_ALPHA2[padded] || null;
  }

  window.TopoJSONMini = { decode, pointInFeature, numericToAlpha2 };
})();
