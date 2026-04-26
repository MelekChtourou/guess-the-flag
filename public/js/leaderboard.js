// Leaderboard client. Submits the daily score and renders the result
// panel: rank / total players, score distribution histogram, top 5.

(function () {
  // We cache the latest snapshot keyed by dayNumber so showLast() (used
  // when the user replays an already-finished daily) doesn't re-submit
  // — it just re-paints from the last known state.
  const lastByDay = new Map();

  function $(id) { return document.getElementById(id); }

  async function submitAndShow({ dayNumber, score, correct, durationMs }) {
    const profile = window.Profile ? window.Profile.get() : { playerId: null };
    const body = {
      dayNumber,
      playerId:   profile.playerId,
      playerName: null,                   // anonymous by default
      score, correct, durationMs,
    };
    let snap = null;
    try {
      const res = await fetch("/api/daily-result", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
      });
      if (res.ok) snap = await res.json();
    } catch (e) { /* leaderboard is best-effort */ }
    if (snap) {
      lastByDay.set(dayNumber, snap);
      render(snap, { dayNumber, myScore: score });
    } else {
      hide();
    }
  }

  async function showLast(dayNumber) {
    let snap = lastByDay.get(dayNumber);
    if (!snap) {
      try {
        const profile = window.Profile ? window.Profile.get() : { playerId: null };
        const url = `/api/daily-leaderboard?day=${dayNumber}` + (profile.playerId ? `&playerId=${encodeURIComponent(profile.playerId)}` : "");
        const res = await fetch(url);
        if (res.ok) snap = await res.json();
        if (snap) lastByDay.set(dayNumber, snap);
      } catch (e) {}
    }
    if (!snap) { hide(); return; }
    render(snap, { dayNumber, myScore: snap.me ? snap.me.score : null });
  }

  function hide() {
    const wrap = $("leaderboard");
    if (wrap) wrap.hidden = true;
  }

  // Build the panel under the share-card on the results screen.
  function render(snap, { dayNumber, myScore }) {
    const wrap = $("leaderboard");
    if (!wrap) return;

    if (!snap || snap.total === 0) {
      // Nobody else has played today yet — show a friendly first-mover line.
      wrap.hidden = false;
      wrap.innerHTML = `
        <div class="lb-header">Leaderboard · Daily #${dayNumber}</div>
        <div class="lb-empty">You're the first to finish today's challenge 🎉</div>
      `;
      return;
    }

    // Rank line.
    const rankLine = (snap.rank != null)
      ? `Rank <strong>#${snap.rank}</strong> of ${snap.total} ${snap.percentile != null ? `· Top ${snap.percentile}%` : ""}`
      : `${snap.total} players today`;

    // Histogram bars — find max count for normalization.
    const maxCount = Math.max(1, ...snap.distribution.map((b) => b.count));
    const myBucket = (myScore != null) ? Math.floor(myScore / 200) : -1;
    const histHtml = snap.distribution.map((b, i) => {
      const h = Math.max(4, Math.round((b.count / maxCount) * 60));
      const isMe = i === myBucket;
      return `<div class="lb-bar ${isMe ? "is-me" : ""}" style="height:${h}px" title="${b.from}-${b.to}: ${b.count}"></div>`;
    }).join("");

    // Top list (5 max).
    const topHtml = snap.top.slice(0, 5).map((t, i) => `
      <li class="lb-top-row">
        <span class="lb-top-rank">${i + 1}</span>
        <span class="lb-top-name">${(t.name || "Anonymous").replace(/[<>&]/g, "")}</span>
        <span class="lb-top-score">${t.score}</span>
      </li>
    `).join("");

    wrap.hidden = false;
    wrap.innerHTML = `
      <div class="lb-header">Leaderboard · Daily #${dayNumber}</div>
      <div class="lb-rank">${rankLine}</div>
      <div class="lb-hist">${histHtml}</div>
      <div class="lb-hist-axis"><span>0</span><span>1k</span><span>2k</span></div>
      ${topHtml ? `<ul class="lb-top">${topHtml}</ul>` : ""}
    `;
  }

  window.Leaderboard = { submitAndShow, showLast };
})();
