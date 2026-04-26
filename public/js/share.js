// Wordle-style result card formatting + sharing.
//
// Pure text output so it survives copy/paste anywhere (chat apps strip
// formatting). Emoji grid for the round-by-round result, plus a header
// and the URL so people who see the card can click through.

(function () {
  const SQUARE = {
    correct: "🟩",
    wrong:   "🟥",
    timeout: "⬛",
  };

  const SITE_URL = location.origin || "https://guess-flag.mohamedmelekchtourou.com";

  // Build the canonical share string.
  //
  // opts:
  //   mode:    "daily" | "solo"
  //   day:     dayNumber (only for daily)
  //   results: array of "correct" | "wrong" | "timeout"
  //   score:   number
  //   streak:  longest streak in this game (optional)
  function format(opts) {
    const { mode, day, results = [], score = 0, streak = 0 } = opts;

    let header;
    if (mode === "daily") {
      header = `Guess the Flag — Daily #${day}`;
    } else {
      header = "Guess the Flag — Solo";
    }

    const grid = results.map((r) => SQUARE[r] || SQUARE.wrong).join("");
    const correctCount = results.filter((r) => r === "correct").length;

    const stats = [
      `${correctCount}/${results.length}`,
      `${score} pts`,
      streak >= 3 ? `🔥${streak}` : null,
    ].filter(Boolean).join(" — ");

    return [
      header,
      grid,
      stats,
      "",
      SITE_URL,
    ].join("\n");
  }

  // Try the native share sheet first (mobile); fall back to clipboard
  // copy with a toast.
  async function share(text, title = "Guess the Flag") {
    if (navigator.share) {
      try {
        await navigator.share({ title, text });
        return "shared";
      } catch (e) {
        // User canceled or browser blocked — fall through to clipboard.
      }
    }
    return await copy(text);
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      if (window.UI) window.UI.toast("Copied result");
      return "copied";
    } catch (e) {
      // Old-school fallback: a hidden textarea.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        ta.remove();
        if (window.UI) window.UI.toast("Copied result");
        return "copied";
      } catch (_) {
        if (window.UI) window.UI.toast("Couldn't copy — long-press to share");
        return "failed";
      }
    }
  }

  window.Share = { format, share, copy };
})();
