/**
 * Lyric Status — server.js
 */
"use strict";

const net    = require("net");
const http   = require("http");
const https  = require("https");
const fs     = require("fs");
const path   = require("path");
const { execFileSync } = require("child_process");
const WebSocket = require("ws");

// ─── Paths ────────────────────────────────────────────────────────────────────

const ROOT        = path.join(__dirname, "..");
const HELPER_PATH = path.join(ROOT, "track-helper", "get-track.exe");
const CONFIG_FILE = path.join(ROOT, ".config.json");
const LYRICS_FILE = path.join(ROOT, ".lyrics.json");
const PUBLIC_DIR  = path.join(ROOT, "public");

// ─── Config ───────────────────────────────────────────────────────────────────

let config = {
  discordToken: "",
  lyricStatus:  true,
  clearOnPause: true,
  titlePrefix:  false,
};
try { Object.assign(config, JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"))); } catch {}
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); }

// ─── Lyrics store ─────────────────────────────────────────────────────────────
// { "Title||Artist": { lines: [{time, text}], source: "lrclib"|"manual" } }

let lyricsStore = {};
try { lyricsStore = JSON.parse(fs.readFileSync(LYRICS_FILE, "utf8")); } catch {}
function saveLyricsStore() { fs.writeFileSync(LYRICS_FILE, JSON.stringify(lyricsStore, null, 2)); }
function lyricsKey(name, artist) { return `${name}||${artist}`; }

// ─── Runtime state ────────────────────────────────────────────────────────────

let lastTrack        = null;
let isPaused         = false;
let gatewayUsername  = null;

// Lyrics state — matches bridge.js exactly
let currentLyrics    = [];
let currentLyricLine = "";
let lyricsTrackKey   = "";
let lyricTimer       = null;
let lyricsFetching   = false;

// Stable position baseline for the lyric timer.
// Updated by every poll but only ever moves FORWARD — prevents the
// integer-second snap-back that caused re-firing of previous lines.
let tickBaseMs   = 0;   // track position in ms at last accepted poll
let tickBaseTime = 0;   // wall-clock ms when that snapshot was taken
let tickHwMs     = 0;   // high-water mark — posMs never goes below this

// ─── HTTPS helpers (from bridge.js) ──────────────────────────────────────────

function httpsGet(url, extraHeaders = {}, redirects = 5) {
  return new Promise((resolve, reject) => {
    const opts = new URL(url);
    const req = https.get({
      hostname: opts.hostname,
      path:     opts.pathname + opts.search,
      headers:  { ...extraHeaders, "Accept-Encoding": "identity" },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(httpsGet(res.headers.location, extraHeaders, redirects - 1));
      }
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => resolve(data));
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
  });
}

function httpsRequest(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const u   = new URL(url);
    const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method, headers }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    req.setTimeout(10000, () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// ─── LRCLib — ported exactly from bridge.js ──────────────────────────────────

function parseLrc(lrcText) {
  return lrcText.split("\n").map(l => {
    const m = l.match(/\[(\d+):(\d+\.\d+)\](.*)/);
    if (!m) return null;
    return { time: Math.round((parseInt(m[1]) * 60 + parseFloat(m[2])) * 1000), text: m[3].trim() || "♪" };
  }).filter(Boolean);
}

async function searchLrcLib(query, trackName, artistName, duration) {
  const results = [];
  const headers = { "User-Agent": "DiscordMusicWidget/2.0" };

  // Strategy 1: specific track+artist search
  if (trackName && artistName) {
    try {
      const url = `https://lrclib.net/api/search?track_name=${encodeURIComponent(trackName)}&artist_name=${encodeURIComponent(artistName)}`;
      const raw = await httpsGet(url, headers);
      const r   = JSON.parse(raw);
      if (r?.length) results.push(...r);
    } catch {}
  }

  // Strategy 2: general query search (catches more variants)
  if (query) {
    try {
      const url = `https://lrclib.net/api/search?q=${encodeURIComponent(query)}`;
      const raw = await httpsGet(url, headers);
      const r   = JSON.parse(raw);
      if (r?.length) {
        for (const item of r) {
          if (!results.find(x => x.id === item.id)) results.push(item);
        }
      }
    } catch {}
  }

  // Score and sort — same logic as bridge.js
  const scored = results.map(r => {
    let score = 0;
    const rTrack  = (r.trackName  || "").toLowerCase();
    const rArtist = (r.artistName || "").toLowerCase();
    const qTrack  = (trackName    || "").toLowerCase();
    const qArtist = (artistName   || "").toLowerCase().split(/[,&]/)[0].trim();

    if (rTrack  === qTrack)             score += 20;
    else if (rTrack.includes(qTrack))   score += 8;
    else if (qTrack.includes(rTrack))   score += 5;

    if (rArtist === qArtist)            score += 15;
    else if (rArtist.includes(qArtist)) score += 7;
    else if (qArtist.includes(rArtist)) score += 4;

    if (r.syncedLyrics)                 score += 10;

    if (duration && r.duration) {
      const diff = Math.abs(r.duration - duration);
      if (diff < 2)       score += 8;
      else if (diff < 5)  score += 4;
      else if (diff < 10) score += 1;
      else                score -= 5;
    }

    return { r, score };
  });

  scored.sort((a, b) => b.score - a.score);

  return scored.map(({ r }) => ({
    id:           r.id,
    title:        r.trackName,
    artist:       r.artistName,
    album:        r.albumName,
    duration:     r.duration,
    hasSynced:    !!r.syncedLyrics,
    syncedLyrics: r.syncedLyrics || null,
    plainLyrics:  r.plainLyrics  || null,
  }));
}

// Strip noise from artist strings: "Artist feat. X", "Artist & Y", "(something)"
function cleanArtist(artist) {
  return artist
    .split(/[,&]|feat\.|ft\.|featuring/i)[0]
    .replace(/\(.*?\)/g, "")
    .trim();
}

// Strip noise from track names: "(feat. X)", "[Remix]", "- Official Video", etc.
function cleanTrackName(name) {
  return name
    .replace(/\s*\(feat\..*?\)/gi, "")
    .replace(/\s*\[.*?\]/gi, "")
    .replace(/\s*-\s*(official|lyric|music|video|audio|hd|4k|remaster|remastered|live|acoustic).*$/gi, "")
    .trim();
}

async function autoFetchLyrics(name, artist, duration) {
  const key = lyricsKey(name, artist);
  if (lyricsStore[key]) return lyricsStore[key].lines || [];

  const mainArtist = cleanArtist(artist);
  const cleanName  = cleanTrackName(name);

  console.log(`  ♪ Auto-fetching: "${name}" — "${mainArtist}"`);

  try {
    // Run all searches in parallel for speed, then merge + score
    const headers = { "User-Agent": "DiscordMusicWidget/2.0" };
    const fetches = [];

    // 1. Exact: track_name + artist_name (most targeted)
    fetches.push(
      httpsGet(`https://lrclib.net/api/search?track_name=${encodeURIComponent(name)}&artist_name=${encodeURIComponent(mainArtist)}`, headers)
        .then(r => JSON.parse(r)).catch(() => [])
    );

    // 2. Cleaned name + artist (handles "(feat. X)" in title)
    if (cleanName !== name) {
      fetches.push(
        httpsGet(`https://lrclib.net/api/search?track_name=${encodeURIComponent(cleanName)}&artist_name=${encodeURIComponent(mainArtist)}`, headers)
          .then(r => JSON.parse(r)).catch(() => [])
      );
    }

    // 3. General q= search with "artist name" — catches transliterations, aliases
    fetches.push(
      httpsGet(`https://lrclib.net/api/search?q=${encodeURIComponent(mainArtist + " " + name)}`, headers)
        .then(r => JSON.parse(r)).catch(() => [])
    );

    const arrays = await Promise.all(fetches);

    // Merge, deduplicate by id
    const seen = new Set();
    const all  = [];
    for (const arr of arrays) {
      if (!Array.isArray(arr)) continue;
      for (const item of arr) {
        if (!seen.has(item.id)) { seen.add(item.id); all.push(item); }
      }
    }

    if (!all.length) {
      console.log(`  ♪ No LRCLib results for "${name}"`);
      return [];
    }

    // Score every result — artist + track name match are the only criteria
    const qTrack  = name.toLowerCase();
    const qClean  = cleanName.toLowerCase();
    const qArtist = mainArtist.toLowerCase();

    const scored = all.map(r => {
      const rTrack  = (r.trackName  || "").toLowerCase();
      const rArtist = (r.artistName || "").toLowerCase();
      let score = 0;

      // ── Track name scoring ──────────────────────────────────────────────
      if (rTrack === qTrack)              score += 30;  // exact original
      else if (rTrack === qClean)         score += 28;  // exact cleaned
      else if (rTrack.includes(qTrack))   score += 12;
      else if (rTrack.includes(qClean))   score += 10;
      else if (qTrack.includes(rTrack))   score += 6;
      else if (qClean.includes(rTrack))   score += 5;

      // ── Artist name scoring ─────────────────────────────────────────────
      const rArtistMain = cleanArtist(rArtist);
      if (rArtistMain === qArtist)        score += 25;  // exact main artist
      else if (rArtist === qArtist)       score += 22;
      else if (rArtist.includes(qArtist)) score += 10;
      else if (qArtist.includes(rArtistMain)) score += 8;

      // ── Synced bonus ────────────────────────────────────────────────────
      if (r.syncedLyrics)                 score += 15;

      // ── Duration proximity bonus ────────────────────────────────────────
      if (duration && r.duration) {
        const diff = Math.abs(r.duration - duration);
        if (diff < 2)       score += 10;
        else if (diff < 5)  score += 5;
        else if (diff < 15) score += 1;
        else                score -= 8;   // penalise very different durations
      }

      return { r, score };
    });

    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    console.log(`  ♪ Best match: "${best.r.trackName}" — "${best.r.artistName}" (score ${best.score})`);

    // Require a minimum confidence score to avoid totally wrong matches
    if (best.score < 20) {
      console.log(`  ♪ Score too low (${best.score}), skipping auto-apply`);
      return [];
    }

    if (!best.r.syncedLyrics) {
      console.log(`  ♪ Best match has no synced lyrics`);
      return [];
    }

    const lines = parseLrc(best.r.syncedLyrics);
    if (!lines.length) return [];

    lyricsStore[key] = { lines, source: "lrclib", title: best.r.trackName, artist: best.r.artistName };
    saveLyricsStore();
    console.log(`  ♪ Auto-fetched ${lines.length} lines`);
    return lines;
  } catch (e) {
    console.warn("  LRCLib auto-fetch failed:", e.message);
    return [];
  }
}

// ─── Lyric sync — ported exactly from bridge.js ───────────────────────────────

function startLyricSync(track) {
  const key = lyricsKey(track.name, track.artist);
  if (lyricsTrackKey === key) return;
  lyricsTrackKey   = key;
  currentLyrics    = [];
  currentLyricLine = "";
  if (lyricTimer) { clearInterval(lyricTimer); lyricTimer = null; }

  lyricsFetching = true;
  autoFetchLyrics(track.name, track.artist, track.duration).then(lines => {
    lyricsFetching = false;
    if (lyricsTrackKey !== key) return;
    currentLyrics = lines;
    console.log(`  ♪ ${lines.length} lyric lines loaded`);
    if (lines.length) scheduleLyricTick();
  });
}

function loadStoredLyrics(name, artist) {
  const key    = lyricsKey(name, artist);
  const stored = lyricsStore[key];
  if (!stored?.lines?.length) return;
  currentLyrics    = stored.lines;
  currentLyricLine = "";
  lyricsTrackKey   = key;
  lyricsFetching   = false;
  if (lyricTimer) clearInterval(lyricTimer);
  if (currentLyrics.length) scheduleLyricTick();
  console.log(`  ♪ Loaded ${currentLyrics.length} stored lines`);
}

function setTickBaseline(positionSec) {
  const newMs = positionSec * 1000;
  // Only accept if it's at or ahead of the high-water mark.
  // This silently ignores integer-second rounding regressions.
  if (newMs >= tickHwMs) {
    tickBaseMs   = newMs;
    tickBaseTime = Date.now();
  }
}

function scheduleLyricTick() {
  if (lyricTimer) clearInterval(lyricTimer);
  lyricTimer = setInterval(() => {
    if (isPaused || !lastTrack) return;

    // Compute raw position from our stable baseline (not lastTrack.readAt
    // which resets every poll and causes snap-back to the previous line).
    const raw   = tickBaseMs + (Date.now() - tickBaseTime);
    // Enforce forward-only movement via high-water mark
    const posMs = Math.max(raw, tickHwMs);
    tickHwMs    = posMs;

    if (!currentLyrics.length) return;

    let line = "";
    for (const l of currentLyrics) {
      if (l.time <= posMs) line = l.text;
      else break;
    }
    if (line !== currentLyricLine) {
      currentLyricLine = line;
      if (config.lyricStatus && line) pushToDiscord(line);
    }
  }, 100);
}

// ─── Discord custom status ────────────────────────────────────────────────────
// Uses fire-and-forget exactly like bridge.js — no queue, no async complexity.
// The lyric timer already handles dedup by only firing when line changes.

function setDiscordCustomStatus(text) {
  if (!config.discordToken) return;
  const body = JSON.stringify({ custom_status: text ? { text, emoji_name: null } : null });
  const req = https.request({
    hostname: "discord.com",
    path:     "/api/v9/users/@me/settings",
    method:   "PATCH",
    headers: {
      "Authorization":  config.discordToken,
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
      "User-Agent":     "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  }, (res) => {
    if (res.statusCode !== 200) {
      let d = ""; res.on("data", c => d += c);
      res.on("end", () => console.warn(`  Status update failed: ${res.statusCode}`, d.slice(0, 80)));
    } else res.resume();
  });
  req.on("error", e => console.warn("  Status update error:", e.message));
  req.write(body);
  req.end();
}

function pushToDiscord(line) {
  let text = line;
  if (config.titlePrefix && lastTrack) text = `♪ ${lastTrack.name} — ${line}`;
  if (text.length > 128) text = text.substring(0, 125) + "…";
  setDiscordCustomStatus(text);
}

// ─── Discord gateway (heartbeat + identity) ───────────────────────────────────

let gatewayWs = null;
let gatewayHb = null;

function connectGateway() {
  if (!config.discordToken) return;
  if (gatewayWs?.readyState === WebSocket.OPEN) return;
  const ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");
  gatewayWs = ws;
  ws.on("message", raw => {
    const msg = JSON.parse(raw);
    if (msg.op === 10) {
      if (gatewayHb) clearInterval(gatewayHb);
      gatewayHb = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op: 1, d: null }));
      }, msg.d.heartbeat_interval);
      ws.send(JSON.stringify({ op: 2, d: { token: config.discordToken, properties: { os: "Windows", browser: "Discord", device: "" }, intents: 0 } }));
    }
    if (msg.op === 0 && msg.t === "READY") {
      gatewayUsername = msg.d?.user?.username || "";
      console.log(`  ✓ Gateway connected as ${gatewayUsername}`);
    }
    if (msg.op === 9) console.error("  ✗ Gateway: invalid session");
  });
  ws.on("close", () => {
    clearInterval(gatewayHb);
    if (gatewayWs === ws) setTimeout(connectGateway, 5000);
  });
  ws.on("error", e => console.error("  Gateway error:", e.message));
}

// ─── Track reader (SMTC) ─────────────────────────────────────────────────────

function readTrack() {
  if (!fs.existsSync(HELPER_PATH)) return null;
  try {
    const readAt = Date.now();
    const result = execFileSync(HELPER_PATH, { timeout: 5000, windowsHide: true, encoding: "utf8" }).trim();
    if (!result || result === "stopped") return null;
    const parts = result.split("|");
    if (parts.length < 7 || !parts[0]) return null;
    return {
      name:     parts[0].trim(),
      artist:   parts[1]?.trim() || "",
      album:    parts[2]?.trim() || "",
      position: parseInt(parts[3]) || 0,
      duration: parseInt(parts[4]) || 0,
      artPath:  parts[5]?.trim() || "",
      paused:   parts[6]?.trim() === "paused",
      readAt,
    };
  } catch { return null; }
}

// ─── Poll loop — ported from bridge.js ───────────────────────────────────────

let pollTimer = null;

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  poll();
  pollTimer = setInterval(poll, 3000);
}

async function poll() {
  const track = readTrack();

  if (!track) {
    if (lastTrack) {
      console.log("⏹  Stopped");
      if (lyricTimer) { clearInterval(lyricTimer); lyricTimer = null; }
      if (config.clearOnPause) setDiscordCustomStatus(null);
      lastTrack        = null;
      isPaused         = false;
      currentLyrics    = [];
      currentLyricLine = "";
      lyricsTrackKey   = "";
      lyricsFetching   = false;
    }
    return;
  }

  const songChanged = !lastTrack || lastTrack.name !== track.name || lastTrack.artist !== track.artist;

  // Pause/resume transitions
  if (track.paused && !isPaused) {
    isPaused = true;
    if (config.clearOnPause) setDiscordCustomStatus(null);
  } else if (!track.paused && isPaused) {
    isPaused         = false;
    currentLyricLine = "";
    // On resume, reset high-water mark to current position so we
    // don't hold a stale pre-pause value.
    tickHwMs = track.position * 1000;
  }

  if (songChanged) {
    console.log(`▶  "${track.name}" — ${track.artist}`);
    lyricsTrackKey   = "";
    currentLyricLine = "";
    currentLyrics    = [];
    // New song — full baseline reset
    tickBaseMs   = track.position * 1000;
    tickBaseTime = Date.now();
    tickHwMs     = tickBaseMs;
    const key = lyricsKey(track.name, track.artist);
    if (lyricsStore[key]?.lines?.length) {
      loadStoredLyrics(track.name, track.artist);
    } else {
      startLyricSync(track);
    }
  } else {
    // Every poll: try to advance the baseline (only accepted if >= hwm)
    setTickBaseline(track.position);
  }

  lastTrack = track;
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise(resolve => {
    let b = "";
    req.on("data", d => b += d);
    req.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve({}); } });
  });
}

function serveFile(res, filePath, ct) {
  try {
    res.setHeader("Content-Type", ct);
    res.end(fs.readFileSync(filePath));
  } catch { res.statusCode = 404; res.end("Not found"); }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.end(); return; }

  if (req.method === "GET" && url === "/")        return serveFile(res, path.join(PUBLIC_DIR, "index.html"), "text/html");
  if (req.method === "GET" && url === "/app.css") return serveFile(res, path.join(PUBLIC_DIR, "app.css"),   "text/css");
  if (req.method === "GET" && url === "/app.js")  return serveFile(res, path.join(PUBLIC_DIR, "app.js"),    "application/javascript");

  if (req.method === "GET" && url === "/art") {
    const p = lastTrack?.artPath;
    if (p && fs.existsSync(p)) {
      res.setHeader("Content-Type", "image/jpeg");
      res.setHeader("Cache-Control", "no-store");
      return fs.createReadStream(p).pipe(res);
    }
    res.statusCode = 404; res.end(); return;
  }

  res.setHeader("Content-Type", "application/json");

  if (req.method === "GET" && url === "/state") {
    // Compute prev/next lyric lines for display — same as bridge.js
    let prevLyricLine = "", nextLyricLine = "";
    if (currentLyrics.length && lastTrack) {
      const elapsed = (Date.now() - (lastTrack.readAt || Date.now())) / 1000;
      const posMs   = (lastTrack.position + elapsed) * 1000;
      let idx = -1;
      for (let i = 0; i < currentLyrics.length; i++) {
        if (currentLyrics[i].time <= posMs) idx = i;
        else break;
      }
      if (idx > 0)                                  prevLyricLine = currentLyrics[idx - 1].text;
      if (idx >= 0 && idx < currentLyrics.length - 1) nextLyricLine = currentLyrics[idx + 1].text;
    }

    return res.end(JSON.stringify({
      track:           lastTrack,
      isPaused,
      currentLyricLine,
      prevLyricLine,
      nextLyricLine,
      hasLyrics:       currentLyrics.length > 0,
      lyricsFetching,
      lyricsSource:    lastTrack ? lyricsStore[lyricsKey(lastTrack.name, lastTrack.artist)]?.source ?? null : null,
      gatewayUser:     gatewayUsername,
      helperExists:    fs.existsSync(HELPER_PATH),
      config: {
        discordToken: config.discordToken ? "SET" : "",
        lyricStatus:  config.lyricStatus,
        clearOnPause: config.clearOnPause,
        titlePrefix:  config.titlePrefix,
      },
    }));
  }

  if (req.method === "GET" && url === "/lyrics") {
    return res.end(JSON.stringify({ line: currentLyricLine, lines: currentLyrics }));
  }

  if (req.method === "GET" && url === "/lyrics/search") {
    const params   = new URL("http://x" + req.url).searchParams;
    const q        = params.get("q")        || "";
    const track    = params.get("track")    || "";
    const artist   = params.get("artist")   || "";
    const duration = parseFloat(params.get("duration")) || 0;
    if (!q && !track) return res.end(JSON.stringify([]));
    const results = await searchLrcLib(q, track, artist, duration);
    return res.end(JSON.stringify(results));
  }

  if (req.method === "POST" && url === "/lyrics/save") {
    const body = await readBody(req);
    const { name, artist, lines, source, syncedLyrics } = body;
    if (!name || !artist) { res.statusCode = 400; return res.end(JSON.stringify({ error: "name and artist required" })); }
    const key = lyricsKey(name, artist);
    let parsed = lines;
    if (!parsed && syncedLyrics) parsed = parseLrc(syncedLyrics);
    if (!parsed?.length) { res.statusCode = 400; return res.end(JSON.stringify({ error: "No lines parsed" })); }
    lyricsStore[key] = { lines: parsed, source: source || "manual" };
    saveLyricsStore();
    if (lastTrack && lastTrack.name === name) {
      currentLyrics    = parsed;
      currentLyricLine = "";
      lyricsTrackKey   = key;
      scheduleLyricTick();
      console.log(`  ♪ Applied ${parsed.length} manual lines for "${name}"`);
    }
    return res.end(JSON.stringify({ ok: true, lines: parsed.length }));
  }

  if (req.method === "POST" && url === "/lyrics/delete") {
    const body = await readBody(req);
    const key  = lyricsKey(body.name, body.artist);
    delete lyricsStore[key];
    saveLyricsStore();
    if (lastTrack?.name === body.name) {
      currentLyrics    = [];
      currentLyricLine = "";
      lyricsTrackKey   = "";
      if (lyricTimer) { clearInterval(lyricTimer); lyricTimer = null; }
    }
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === "POST" && url === "/config") {
    const body = await readBody(req);
    if ("discordToken" in body && body.discordToken !== "SET") {
      config.discordToken = body.discordToken;
      gatewayUsername = null;
      if (gatewayWs) { try { gatewayWs.close(); } catch {} gatewayWs = null; }
      if (config.discordToken) connectGateway();
    }
    if ("lyricStatus"  in body) config.lyricStatus  = !!body.lyricStatus;
    if ("clearOnPause" in body) config.clearOnPause = !!body.clearOnPause;
    if ("titlePrefix"  in body) config.titlePrefix  = !!body.titlePrefix;
    saveConfig();
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === "POST" && url === "/discord/clear") {
    setDiscordCustomStatus(null);
    return res.end(JSON.stringify({ ok: true }));
  }

  res.statusCode = 404; res.end("{}");

}).listen(3030, "127.0.0.1", () => {
  console.log("─────────────────────────────────────────");
  console.log("  Lyric Status  →  http://127.0.0.1:3030");
  console.log("─────────────────────────────────────────");
  if (!fs.existsSync(HELPER_PATH))
    console.warn("  ⚠  track-helper/get-track.exe not found.\n  Run: dotnet build get-track.csproj -c Release -o track-helper");
  if (config.discordToken) connectGateway();
  startPolling();
});

process.on("SIGINT", () => {
  setDiscordCustomStatus(null);
  if (lyricTimer) clearInterval(lyricTimer);
  setTimeout(() => process.exit(0), 400);
});
