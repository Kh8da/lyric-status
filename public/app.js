/* app.js — Lyric Status frontend */
"use strict";

// ── State ──────────────────────────────────────────────────────────────────
const A = {
  track:          null,
  trackId:        "",
  lyricsLines:    [],
  lyricLine:      "",
  prevLyricLine:  "",
  nextLyricLine:  "",
  lyricsFetching: false,
  hasLyrics:      false,
  lyricsSource:   null,
  gatewayUser:    "",
  posBase:        0,
  posBaseTime:    0,
  durationMs:     0,
  isPaused:       false,
  config:         {},
};

// ── Init ───────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll(".nav-btn").forEach(btn =>
    btn.addEventListener("click", () => switchTab(btn.dataset.tab))
  );
  fetchState();
  setInterval(fetchState, 2000);
  setInterval(tickProgress, 300);
});

// ── Tab switching ──────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".tab-panel").forEach(p => p.classList.toggle("active", p.id === "tab-" + tab));
  if (tab === "lyrics") renderLyricsTab();
}

// ── State polling ──────────────────────────────────────────────────────────
async function fetchState() {
  try {
    const res = await fetch("/state");
    if (!res.ok) return;
    const data = await res.json();

    // track uses .name (not .title) — matches bridge.js field names
    const newId = data.track ? `${data.track.name}||${data.track.artist}` : "";
    const songChanged = newId !== A.trackId;

    A.track          = data.track;
    A.trackId        = newId;
    A.isPaused       = data.isPaused || false;
    A.config         = data.config || {};
    A.gatewayUser    = data.gatewayUser || "";
    A.lyricsFetching = data.lyricsFetching || false;
    A.hasLyrics      = data.hasLyrics || false;
    A.lyricsSource   = data.lyricsSource || null;

    if (data.track) {
      A.posBase     = (data.track.position || 0) * 1000;
      A.posBaseTime = Date.now();
      A.durationMs  = (data.track.duration || 0) * 1000;
    }

    // Lyric lines (current / prev / next)
    if (data.currentLyricLine !== A.lyricLine) {
      A.lyricLine = data.currentLyricLine || "";
      animateLyric(A.lyricLine);
    }
    A.prevLyricLine = data.prevLyricLine || "";
    A.nextLyricLine = data.nextLyricLine || "";

    // Fetch full lyric list when needed
    if (songChanged) {
      A.lyricsLines = [];
      if (data.hasLyrics) fetchLyricsLines();
    } else if (data.hasLyrics && !A.lyricsLines.length) {
      fetchLyricsLines();
    }

    updateNowPlayingUI();
    updateSidebarStatus(data);
    syncSettingsToggles(data.config);
  } catch {}
}

async function apiFetch(url, opts) {
  try {
    const res = await fetch(url, opts);
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function fetchLyricsLines() {
  const data = await apiFetch("/lyrics");
  if (!data) return;
  // bridge.js uses .time (not .ms)
  A.lyricsLines = data.lines || [];
  if (document.getElementById("tab-lyrics").classList.contains("active")) renderLyricsTab();
}

// ── Now Playing UI ─────────────────────────────────────────────────────────
function updateNowPlayingUI() {
  const track = A.track;

  document.getElementById("no-track-notice").style.display = track ? "none" : "flex";
  const nowCard = document.getElementById("now-card");
  nowCard.style.opacity = track ? "1" : "0.35";
  nowCard.classList.toggle("playing", !!track && !A.isPaused);
  document.getElementById("now-eq").classList.toggle("playing", !!track && !A.isPaused);

  if (!track) {
    document.getElementById("now-track").textContent  = "Nothing playing";
    document.getElementById("now-artist").textContent = "—";
    document.getElementById("now-album").textContent  = "";
    document.getElementById("dc-preview-text").textContent = "—";
    document.getElementById("lyric-line").innerHTML = '<span class="lyric-empty">Waiting for track…</span>';
    document.getElementById("lyric-sub").textContent = "";
    return;
  }

  // .name not .title — bridge.js field names
  document.getElementById("now-track").textContent  = track.name   || "—";
  document.getElementById("now-artist").textContent = track.artist || "—";
  document.getElementById("now-album").textContent  = track.album  || "";

  // Album art
  const artImg = document.getElementById("now-art");
  if (track.artPath && artImg.dataset.track !== A.trackId) {
    artImg.dataset.track = A.trackId;
    artImg.src = "/art?" + Date.now();
    document.getElementById("now-placeholder").style.display = "none";
  } else if (!track.artPath) {
    artImg.src = "";
    artImg.style.opacity = "0";
    document.getElementById("now-placeholder").style.display = "flex";
  }

  // Discord preview
  let preview = A.lyricLine || "—";
  if (A.config.titlePrefix && A.lyricLine) preview = `♪ ${track.name} — ${A.lyricLine}`;
  document.getElementById("dc-preview-text").textContent = preview;

  // Sub-label
  const sub = document.getElementById("lyric-sub");
  if (A.lyricsFetching) {
    sub.textContent = "Searching for lyrics…";
  } else if (!A.hasLyrics) {
    sub.textContent = "No lyrics found — try the Lyrics tab";
  } else if (A.lyricLine) {
    sub.textContent = A.config.lyricStatus ? "Pushing to Discord" : "Sync active (push off)";
  } else {
    sub.textContent = "Lyrics ready";
  }
}

function animateLyric(line) {
  const el = document.getElementById("lyric-line");
  el.classList.add("fade");
  setTimeout(() => {
    el.textContent = line || "";
    if (!line) el.innerHTML = '<span class="lyric-empty">No lyrics for this track…</span>';
    el.classList.remove("fade");
  }, 200);
}

// ── Progress ticker ────────────────────────────────────────────────────────
function tickProgress() {
  if (!A.track || A.isPaused || !A.durationMs) return;
  const pos = Math.min(A.posBase + (Date.now() - A.posBaseTime), A.durationMs);
  document.getElementById("prog-fill").style.width = ((pos / A.durationMs) * 100).toFixed(1) + "%";
  document.getElementById("prog-cur").textContent  = fmt(pos);
  document.getElementById("prog-end").textContent  = fmt(A.durationMs);
}

function fmt(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── Sidebar status ─────────────────────────────────────────────────────────
function updateSidebarStatus(data) {
  const dcDot  = document.getElementById("discord-dot");
  const dcText = document.getElementById("discord-status-text");
  if (data.gatewayUser) {
    dcDot.className    = "pill-dot ok";
    dcText.textContent = data.gatewayUser;
  } else if (data.config?.discordToken) {
    dcDot.className    = "pill-dot warn";
    dcText.textContent = "Connecting…";
  } else {
    dcDot.className    = "pill-dot";
    dcText.textContent = "No token";
  }

  const trDot  = document.getElementById("track-dot");
  const trText = document.getElementById("track-status-text");
  if (!data.helperExists) {
    trDot.className    = "pill-dot err";
    trText.textContent = "Helper missing";
  } else if (!data.track) {
    trDot.className    = "pill-dot";
    trText.textContent = "No track";
  } else if (data.isPaused) {
    trDot.className    = "pill-dot warn";
    trText.textContent = "Paused";
  } else {
    trDot.className    = "pill-dot ok";
    const t = data.track.name || "";
    trText.textContent = t.length > 18 ? t.slice(0, 16) + "…" : t;
  }
}

// ── Lyrics tab ─────────────────────────────────────────────────────────────
function renderLyricsTab() {
  const track = A.track;
  document.getElementById("lth-title").textContent  = track?.name   || "No track playing";
  document.getElementById("lth-artist").textContent = track?.artist || "—";

  const src = document.getElementById("lth-source");
  if (A.lyricsSource) {
    src.textContent   = A.lyricsSource === "manual" ? "Manual" : "LRCLib";
    src.style.display = "";
  } else {
    src.textContent   = A.lyricsFetching ? "Searching…" : (A.hasLyrics ? "Loaded" : "No lyrics");
    src.style.display = "";
  }

  renderLinesPreview();
}

function renderLinesPreview() {
  const lines = A.lyricsLines;
  const cont  = document.getElementById("lines-preview");
  const label = document.getElementById("lines-label");
  if (!lines.length) { cont.innerHTML = ""; label.hidden = true; return; }
  label.hidden   = false;
  // bridge.js uses .time not .ms
  cont.innerHTML = lines.map((l, i) => `
    <div class="lp-line" data-idx="${i}">
      <span class="lp-ts">${fmtMs(l.time)}</span>
      <span class="lp-text">${escHtml(l.text)}</span>
    </div>`).join("");
}

function fmtMs(ms) {
  const s = ms / 1000;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.round((s % 1) * 100)).padStart(2, "0")}`;
}

function escHtml(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── LRCLib search ──────────────────────────────────────────────────────────
async function doLyricSearch() {
  const q = document.getElementById("lyric-search-q").value.trim();
  if (!q) return;
  const btn  = document.getElementById("btn-lyric-search");
  const cont = document.getElementById("search-results");
  btn.disabled   = true;
  btn.innerHTML  = '<span class="spin"></span>';
  cont.innerHTML = "";

  // Pass current track info to get better scoring
  let url = "/lyrics/search?q=" + encodeURIComponent(q);
  if (A.track) {
    url += "&track="    + encodeURIComponent(A.track.name);
    url += "&artist="   + encodeURIComponent(A.track.artist);
    url += "&duration=" + (A.track.duration || 0);
  }

  const results = await apiFetch(url);
  btn.disabled   = false;
  btn.textContent = "Search";

  if (!results?.length) {
    cont.innerHTML = '<div class="no-results">No results found. Try a different query.</div>';
    return;
  }

  window._searchResults = results;
  cont.innerHTML = results.map((r, i) => `
    <div class="result-card" id="rc-${i}">
      <div class="rc-info">
        <div class="rc-title">${escHtml(r.title || "")}</div>
        <div class="rc-artist">${escHtml(r.artist || "")}${r.album ? " · " + escHtml(r.album) : ""}</div>
        <div class="rc-meta">${r.duration ? fmt(r.duration * 1000) : "—"} · ID ${r.id}</div>
      </div>
      <span class="rc-badge${r.hasSynced ? "" : " no-sync"}">${r.hasSynced ? "Synced" : "Plain"}</span>
      <button class="rc-apply" onclick="applySearchResult(${i})">Use this</button>
    </div>
  `).join("");
}

async function applySearchResult(idx) {
  const r = window._searchResults?.[idx];
  if (!r) return;

  if (!r.syncedLyrics && !r.plainLyrics) {
    toast("This result has no usable lyrics.", "err");
    return;
  }

  // Save against the currently playing track — use .name (bridge.js field)
  const name   = A.track?.name   || r.title;
  const artist = A.track?.artist || r.artist;

  const payload = {
    name,
    artist,
    source:       "lrclib",
    syncedLyrics: r.syncedLyrics || null,
    lines:        !r.syncedLyrics && r.plainLyrics
      ? r.plainLyrics.split("\n").filter(l => l.trim()).map((t, i) => ({ time: i * 3000, text: t.trim() }))
      : null,
  };

  const data = await apiFetch("/lyrics/save", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (data?.ok) {
    toast(`Applied ${data.lines} lines to "${name}".`, "ok");
    document.querySelectorAll(".result-card").forEach((c, i) => c.classList.toggle("selected", i === idx));
    A.hasLyrics = true;
    await fetchLyricsLines();
    renderLyricsTab();
  } else {
    toast(data?.error || "Failed to apply.", "err");
  }
}

// ── Manual lyrics editor ───────────────────────────────────────────────────
function toggleManual() {
  const wrap = document.getElementById("manual-wrap");
  const open = !wrap.classList.contains("open");
  wrap.classList.toggle("open", open);

  if (open && A.track) {
    // Always sync title/artist from current track
    document.getElementById("manual-title").value  = A.track.name;
    document.getElementById("manual-artist").value = A.track.artist;
    // Only pre-fill textarea if it's empty
    const ta = document.getElementById("manual-lyrics");
    if (!ta.value.trim() && A.lyricsLines.length) {
      // Render with .time field (bridge.js format)
      ta.value = A.lyricsLines.map(l => `[${fmtMs(l.time)}] ${l.text}`).join("\n");
    }
  }
}

async function saveManualLyrics() {
  const name   = document.getElementById("manual-title").value.trim();
  const artist = document.getElementById("manual-artist").value.trim();
  const raw    = document.getElementById("manual-lyrics").value.trim();

  if (!name)   { toast("Enter track title.",  "err"); return; }
  if (!artist) { toast("Enter artist name.",  "err"); return; }
  if (!raw)    { toast("Paste lyrics first.", "err"); return; }

  const payload = { name, artist, source: "manual" };

  if (/\[\d+:\d+(?:\.\d+)?\]/.test(raw)) {
    payload.syncedLyrics = raw;
  } else {
    // Plain text — 3s spacing
    payload.lines = raw.split("\n").filter(l => l.trim()).map((text, i) => ({
      time: i * 3000, text: text.trim(),
    }));
  }

  const data = await apiFetch("/lyrics/save", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });

  if (data?.ok) {
    toast(`Saved ${data.lines} lines for "${name}".`, "ok");
    A.hasLyrics = true;
    await fetchLyricsLines();
    renderLyricsTab();
  } else {
    toast(data?.error || "Save failed.", "err");
  }
}

async function deleteCurrentLyrics() {
  const name   = document.getElementById("manual-title").value.trim()  || A.track?.name;
  const artist = document.getElementById("manual-artist").value.trim() || A.track?.artist;
  if (!name || !artist) { toast("No track selected.", "err"); return; }

  const data = await apiFetch("/lyrics/delete", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ name, artist }),
  });

  if (data?.ok) {
    toast("Lyrics deleted.", "ok");
    document.getElementById("manual-lyrics").value = "";
    A.lyricsLines = [];
    A.hasLyrics   = false;
    renderLyricsTab();
    animateLyric("");
  }
}

// ── Settings ───────────────────────────────────────────────────────────────
function syncSettingsToggles(cfg) {
  if (!cfg) return;
  setChk("tog-lyric",  cfg.lyricStatus);
  setChk("tog-pause",  cfg.clearOnPause);
  setChk("tog-prefix", cfg.titlePrefix);
  if (cfg.discordToken === "SET")
    document.getElementById("dc-token-input").placeholder = "••••••••• (saved)";
  document.getElementById("gateway-user-val").textContent = A.gatewayUser || "—";
}

function setChk(id, val) {
  const el = document.getElementById(id);
  if (el && el.checked !== !!val) el.checked = !!val;
}

async function saveSetting(key, val) {
  await apiFetch("/config", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ [key]: val }),
  });
}

async function saveToken() {
  const token = document.getElementById("dc-token-input").value.trim();
  if (!token) { toast("Paste your Discord token.", "err"); return; }
  const data = await apiFetch("/config", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ discordToken: token }),
  });
  if (data?.ok) {
    toast("Token saved. Connecting…", "ok");
    document.getElementById("dc-token-input").value       = "";
    document.getElementById("dc-token-input").placeholder = "••••••••• (saved)";
  } else {
    toast("Failed to save token.", "err");
  }
}

function toggleEye() {
  const inp = document.getElementById("dc-token-input");
  inp.type  = inp.type === "password" ? "text" : "password";
}

async function clearDiscordNow() {
  await apiFetch("/discord/clear", { method: "POST" });
  toast("Discord status cleared.", "ok");
}

// ── Toast ──────────────────────────────────────────────────────────────────
let toastTimer;
function toast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className   = "toast show" + (type ? " " + type : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, 3500);
}
