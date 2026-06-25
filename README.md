<div align="center">

<img src="https://capsule-render.vercel.app/api?type=waving&color=1DB954&height=160&section=header&text=Lyric%20Status&fontSize=42&fontColor=ffffff&fontAlignY=38&desc=Live%20song%20lyrics%20→%20your%20Discord%20custom%20status&descAlignY=58&descSize=16&descColor=aaaaaa" width="100%"/>

<br/>

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-1DB954?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![.NET](https://img.shields.io/badge/.NET-8.0-512BD4?style=for-the-badge&logo=dotnet&logoColor=white)](https://dotnet.microsoft.com/download)
[![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D4?style=for-the-badge&logo=windows&logoColor=white)](https://www.microsoft.com/windows)
[![Discord](https://img.shields.io/badge/Discord-Status-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.com)

<br/>

**Lyric Status** reads what you're playing through Windows, fetches time-synced lyrics automatically, and pushes each line to your Discord custom status in real time — no Spotify API key, no third-party accounts, no setup beyond pasting your Discord token.

<br/>

</div>

---

## ✨ Features

- 🎵 **No API keys** — reads the current track directly from Windows Media Transport Controls (SMTC), so it works with Spotify, browsers, VLC, or any media player
- 🎤 **Auto lyrics** — searches [LRCLib](https://lrclib.net) automatically by artist name and song title, picks the best synced match
- ✏️ **Manual override** — search LRCLib yourself or paste your own LRC-format lyrics if auto-fetch gets it wrong
- 💬 **Real-time Discord status** — each lyric line is pushed to your Discord custom status as it plays, ~100ms accuracy
- 🖥️ **Local dashboard** — clean green & black web UI at `http://127.0.0.1:3030` showing the current track, live lyric, progress bar, and settings
- ⚙️ **Settings** — toggle lyric push on/off, clear status on pause, add a song title prefix

---

## 📸 Preview

> Dashboard running in browser while Spotify is playing

<img width="1914" height="939" alt="image" src="https://github.com/user-attachments/assets/65f3ec77-2987-49d1-91cf-214ab76c495a" />



---

## 🔧 Requirements

| Tool | Version | Link |
|---|---|---|
| Windows | 10 or 11 | — |
| Node.js | 18 or newer | [nodejs.org](https://nodejs.org) |
| .NET SDK | 8.0 | [dotnet.microsoft.com](https://dotnet.microsoft.com/download) |

---

## 🚀 Setup

### 1. Clone the repo

```bash
git clone https://github.com/YOUR_USERNAME/lyric-status.git
cd lyric-status
```

### 2. Double-click `start.bat`

That's it. The batch file will:
- Check that Node.js and .NET are installed
- Install npm dependencies automatically
- Build the C# track helper (`get-track.exe`)
- Start the server and open `http://127.0.0.1:3030` in your browser

### 3. Add your Discord token

Open the dashboard → **Settings** tab → paste your Discord user token → **Save token**.

<details>
<summary><b>How to find your Discord token</b></summary>

<br/>

1. Open Discord **(browser or desktop app)**
2. Press **F12** to open DevTools
3. Go to the **Network** tab
4. In the filter box type `science`
5. Click any request that appears
6. Go to **Headers** → scroll to **Request Headers**
7. Copy the value next to **`Authorization`** — that's your token

> ⚠️ **Your token is the password to your account. Never share it, never paste it anywhere except this app. The token is stored locally in `.config.json` and never leaves your machine.**

</details>

---

## 🎤 Lyrics

**Auto mode** — when a new song starts, Lyric Status automatically searches LRCLib using the artist name and track title, runs three parallel queries, scores all results, and applies the best synced match.

**If auto-fetch gets it wrong:**

Go to the **Lyrics** tab in the dashboard:

| Option | What it does |
|---|---|
| **Search** | Search LRCLib manually with any query, see scored results, click "Use this" |
| **Manual editor** | Paste LRC-format lyrics with timestamps (`[0:12.34] Line text`) or plain text (auto-spaced 3s apart) |

Lyrics are saved locally in `.lyrics.json` and reused instantly on repeat plays.

---

## ⚙️ Settings

| Setting | Default | Description |
|---|---|---|
| Lyric status | ✅ On | Push each lyric line to your Discord custom status |
| Clear on pause | ✅ On | Remove the Discord status when playback pauses |
| Title prefix | ❌ Off | Prefix each line with `♪ Song Title — ` |

---

## 📁 File Structure

```
lyric-status/
├── src/
│   └── server.js           ← Node.js backend (track polling, lyrics, Discord)
├── public/
│   ├── index.html          ← Dashboard UI
│   ├── app.css             ← Styles (green & black theme)
│   └── app.js              ← Frontend logic
├── track-helper/           ← Built .exe lives here after first run
├── get-track.cs            ← C# source — reads SMTC track info
├── get-track.csproj        ← .NET project file
├── start.bat               ← One-click launcher (run this)
├── package.json
├── .config.json            ← Auto-created — stores your token & settings
└── .lyrics.json            ← Auto-created — lyrics cache
```

---

## ❓ FAQ

**Does it work with Spotify Free?**
Yes. It reads the track from Windows, not from Spotify's API, so no account tier matters.

**Does it work with YouTube / browsers?**
Yes. Any media player that registers with Windows SMTC works — Spotify, Chrome, Edge, Firefox, VLC, foobar2000, etc.

**Will Discord ban me for using a user token?**
Using a user token for automation is against Discord's ToS. This tool only updates your custom status — a single PATCH request per lyric line — which is the same thing you'd do manually. Use at your own discretion.

**Lyrics are wrong / not loading?**
Go to the **Lyrics** tab and use the search box to find the correct LRCLib entry, or paste your own LRC file in the manual editor.

**How do I run it on startup?**
Press `Win + R`, type `shell:startup`, press Enter, then copy a shortcut to `start.bat` into that folder.

---

## 🛠️ Manual Build (if `start.bat` doesn't work)

```bat
:: Install dependencies
npm install

:: Build the track helper
dotnet build get-track.csproj -c Release -o track-helper

:: Start the server
node src/server.js
```

Then open `http://127.0.0.1:3030`.

---

<div align="center">

Made by **[kh8da](https://guns.lol/Pxrsa)**

</div>
