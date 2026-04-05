// BannerHub Game Configs Worker
// Handles upload, list, download, games browse, voting, comments, reports, descriptions
// Config files stored in The412Banner/bannerhub-game-configs GitHub repo
// KV binding: CONFIG_KV

const GITHUB_OWNER = "The412Banner";
const GITHUB_REPO  = "bannerhub-game-configs";

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: CORS });
      }

      let response;
      const p = url.pathname;
      const m = request.method;

      if      (m === "GET"  && p === "/games")    response = await handleGames(url, env);
      else if (m === "GET"  && p === "/list")     response = await handleList(url, env);
      else if (m === "POST" && p === "/upload")   response = await handleUpload(request, env);
      else if (m === "GET"  && p === "/download") response = await handleDownload(url, env);
      else if (m === "POST" && p === "/vote")     response = await handleVote(request, env);
      else if (m === "POST" && p === "/report")   response = await handleReport(request, env);
      else if (m === "POST" && p === "/describe") response = await handleDescribe(request, env);
      else if (m === "GET"  && p === "/desc")     response = await handleGetDesc(url, env);
      else if (m === "GET"  && p === "/comments") response = await handleGetComments(url, env);
      else if (m === "POST" && p === "/comment")      response = await handlePostComment(request, env);
      else if (m === "POST" && p === "/delete")        response = await handleUserDelete(request, env);
      else if (m === "POST" && p === "/admin/delete") response = await handleAdminDelete(request, env);
      else if (m === "POST" && p === "/admin/edit")   response = await handleAdminEdit(request, env);
      else if (m === "GET"  && p === "/steam/search") response = await handleSteamSearch(url);
      else response = json({ error: "Not found" }, 404);

      const out = new Response(response.body, { status: response.status, headers: new Headers(response.headers) });
      Object.entries(CORS).forEach(([k, v]) => out.headers.set(k, v));
      return out;
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...CORS }
      });
    }
  }
};

// ── KV write helpers (fail silently on limit exceeded) ────────────────────────
async function kvPut(kv, key, value, opts) {
  try { await kv.put(key, value, opts); } catch (e) { /* quota exceeded — skip */ }
}
async function kvDelete(kv, key) {
  try { await kv.delete(key); } catch (e) { /* quota exceeded — skip */ }
}

// ── GET /games[?refresh=1] ────────────────────────────────────────────────────
// Returns [{name, count}] from the pre-built games.json in the repo (updated every 30 min by CI).
// Falls back to GitHub directory listing if games.json is unavailable.
async function handleGames(url, env) {
  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/games.json`;
  const res = await fetch(rawUrl);
  if (res.ok) {
    const text = await res.text();
    return new Response(text, { headers: { "Content-Type": "application/json" } });
  }

  // Fallback: directory listing
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/configs`;
  const r2 = await ghFetch(apiUrl, env);
  if (r2.status === 404) return json([], 200);
  if (!r2.ok) return json({ error: "GitHub error: " + r2.status }, 502);
  const items = await r2.json();
  const SYSTEM_FOLDERS = new Set(["BootstrapPackagedGame"]);
  const games = items
    .filter(i => i.type === "dir" && !SYSTEM_FOLDERS.has(i.name))
    .map(i => ({ name: i.name, count: 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return json(games);
}

// ── GET /list?game=<GameName>[&refresh=1] ─────────────────────────────────────
// Returns config entries with votes + downloads attached. KV-cached 3 min.
async function handleList(url, env) {
  const game = url.searchParams.get("game");
  if (!game) return json({ error: "game parameter required" }, 400);
  const bust = url.searchParams.get("refresh") === "1";
  const cacheKey = "cache:list:" + game;

  if (!bust && env.CONFIG_KV) {
    try {
      const cached = await env.CONFIG_KV.get(cacheKey);
      if (cached) return json(JSON.parse(cached));
    } catch (e) { /* re-fetch */ }
  }

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/configs/${encodeURIComponent(game)}`;
  const res = await ghFetch(apiUrl, env);
  if (res.status === 404) return json([], 200);
  if (!res.ok) return json({ error: "GitHub error: " + res.status }, 502);

  const files = await res.json();
  const entries = files.filter(f => f.name.endsWith(".json")).map(f => {
    const base  = f.name.replace(".json", "");
    const parts = base.split("-");
    const ts    = parseInt(parts[parts.length - 1]) || 0;
    const secondLast = parseInt(parts[parts.length - 2]);
    const hasSOC = isNaN(secondLast) || secondLast < 1000000000;
    const soc   = hasSOC ? parts[parts.length - 2] : "";
    const deviceParts = hasSOC ? parts.slice(0, parts.length - 2) : parts.slice(0, parts.length - 1);
    const gameParts = game.split("-");
    const device = deviceParts.slice(gameParts.length).join("-");
    return {
      filename:    f.name,
      size:        f.size,
      sha:         f.sha,
      timestamp:   ts,
      device:      device || deviceParts.join("-"),
      soc:         soc,
      date:        ts > 0 ? new Date(ts * 1000).toISOString().split("T")[0] : "",
      game_folder: game
    };
  });

  // Attach votes + downloads in parallel
  if (env.CONFIG_KV) {
    await Promise.all(entries.map(async e => {
      try {
        const [voteVal, dlVal] = await Promise.all([
          env.CONFIG_KV.get("votes:" + e.sha),
          env.CONFIG_KV.get("downloads:" + e.sha)
        ]);
        e.votes     = voteVal ? parseInt(voteVal) : 0;
        e.downloads = dlVal  ? parseInt(dlVal)   : 0;
      } catch (e2) { e.votes = 0; e.downloads = 0; }
    }));
  } else {
    entries.forEach(e => { e.votes = 0; e.downloads = 0; });
  }

  entries.sort((a, b) => b.votes !== a.votes ? b.votes - a.votes : b.timestamp - a.timestamp);

  if (env.CONFIG_KV) {
    await kvPut(env.CONFIG_KV, cacheKey, JSON.stringify(entries), { expirationTtl: 180 });
  }
  return json(entries);
}

// ── POST /upload ──────────────────────────────────────────────────────────────
// Body: { game, filename, content (base64), upload_token (optional) }
// Returns: { success, path, sha }
async function handleUpload(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const { game, filename, content, upload_token } = body;
  if (!game || !filename || !content) {
    return json({ error: "game, filename, and content are required" }, 400);
  }

  const safegame = game.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
  const safefile = filename.replace(/[^a-zA-Z0-9_\-\.]/g, "_");
  const path     = `configs/${safegame}/${safefile}`;

  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
  const res = await ghFetch(apiUrl, env, {
    method: "PUT",
    body: JSON.stringify({
      message:   `Add config: ${safegame}/${safefile}`,
      content:   content,
      committer: { name: "BannerHub", email: "bannerhub@users.noreply.github.com" }
    })
  });

  if (!res.ok) {
    const err = await res.text();
    return json({ error: "GitHub error: " + err }, 502);
  }

  const apiData = await res.json();
  const sha = apiData.content ? apiData.content.sha : "";

  if (env.CONFIG_KV) {
    if (sha && upload_token) await kvPut(env.CONFIG_KV, "token:" + sha, String(upload_token).slice(0, 64));
    try {
      const cur = parseInt(await env.CONFIG_KV.get("counts:" + safegame) || "0");
      await kvPut(env.CONFIG_KV, "counts:" + safegame, String(cur + 1));
    } catch (e) { /* skip */ }
    await kvDelete(env.CONFIG_KV, "cache:games");
  }

  // Update recent.json + devices.json in repo (non-fatal if they fail)
  await Promise.all([
    updateRecentJson(env, safegame, safefile),
    updateDevicesJson(env, safegame, safefile, content)
  ]);

  return json({ success: true, path, sha });
}

// ── Update devices.json ───────────────────────────────────────────────────────
// Adds new device entry for the game, commits back.
async function updateDevicesJson(env, game, filename, contentBase64) {
  try {
    const base = filename.replace(/\.json$/, "");
    const parts = base.split("-");
    if (parts.length < 3) return;
    const manufacturer = parts[parts.length - 3];
    const device       = parts[parts.length - 2];

    // Try to extract SOC from uploaded config content
    let soc = null;
    try {
      const decoded = JSON.parse(atob(contentBase64));
      if (decoded.meta && decoded.meta.soc) soc = decoded.meta.soc;
    } catch { /* ignore */ }

    const devUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/devices.json`;
    const getRes = await ghFetch(devUrl, env);

    let currentSha = null;
    let devMap = {};
    if (getRes.ok) {
      const data = await getRes.json();
      currentSha = data.sha;
      try { devMap = JSON.parse(atob(data.content.replace(/\n/g, ""))); } catch { devMap = {}; }
    }

    if (!devMap[game]) devMap[game] = [];
    // Avoid duplicate entries for same filename
    devMap[game] = devMap[game].filter(e => !(e.m === manufacturer && e.d === device && e.s === soc));
    devMap[game].push({ m: manufacturer, d: device, s: soc });

    const putBody = {
      message:   `Update devices.json: ${game}/${filename}`,
      content:   btoa(JSON.stringify(devMap)),
      committer: { name: "BannerHub", email: "bannerhub@users.noreply.github.com" }
    };
    if (currentSha) putBody.sha = currentSha;
    await ghFetch(devUrl, env, { method: "PUT", body: JSON.stringify(putBody) });
  } catch (e) { /* non-fatal */ }
}

// ── Update recent.json ────────────────────────────────────────────────────────
// Prepends new entry, deduplicates, trims to 20, commits back to repo.
async function updateRecentJson(env, game, filename) {
  try {
    // Parse manufacturer, device, timestamp from filename
    // Format: GameName-...-Manufacturer-Model-timestamp.json
    const base = filename.replace(/\.json$/, "");
    const parts = base.split("-");
    if (parts.length < 3) return;
    const ts = parts[parts.length - 1];
    if (isNaN(ts) || ts.length < 8) return;
    const manufacturer = parts[parts.length - 3];
    const device       = parts[parts.length - 2];
    const timestamp    = parseInt(ts);

    // Fetch current recent.json to get its SHA for the update commit
    const recentUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/recent.json`;
    const getRes = await ghFetch(recentUrl, env);

    let currentSha = null;
    let recent = [];
    if (getRes.ok) {
      const data = await getRes.json();
      currentSha = data.sha;
      try { recent = JSON.parse(atob(data.content.replace(/\n/g, ""))); }
      catch { recent = []; }
    }

    // Prepend, deduplicate same file, trim to 20
    recent = recent.filter(r => !(r.filename === filename && r.game === game));
    recent.unshift({ game, manufacturer, device, timestamp, filename });
    recent = recent.slice(0, 20);

    const putBody = {
      message:   `Update recent.json: ${game}/${filename}`,
      content:   btoa(JSON.stringify(recent, null, 2)),
      committer: { name: "BannerHub", email: "bannerhub@users.noreply.github.com" }
    };
    if (currentSha) putBody.sha = currentSha;

    await ghFetch(recentUrl, env, { method: "PUT", body: JSON.stringify(putBody) });
  } catch (e) {
    // Non-fatal — upload already succeeded
  }
}

// ── GET /download?game=X&file=Y[&sha=Z] ──────────────────────────────────────
// Serves the raw config JSON. Increments downloads:<sha> if sha provided.
async function handleDownload(url, env) {
  const game = url.searchParams.get("game");
  const file = url.searchParams.get("file");
  const sha  = url.searchParams.get("sha");
  if (!game || !file) return json({ error: "game and file required" }, 400);

  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/main/configs/${encodeURIComponent(game)}/${encodeURIComponent(file)}`;
  const res = await fetch(rawUrl);
  if (!res.ok) return json({ error: "Config not found" }, 404);
  const text = await res.text();

  if (sha && env.CONFIG_KV) {
    try {
      const cur = parseInt(await env.CONFIG_KV.get("downloads:" + sha) || "0");
      await kvPut(env.CONFIG_KV, "downloads:" + sha, String(cur + 1));
      await kvDelete(env.CONFIG_KV, "cache:list:" + game);
    } catch (e) { /* skip */ }
  }

  return new Response(text, { headers: { "Content-Type": "application/json" } });
}

// ── POST /vote ────────────────────────────────────────────────────────────────
// Body: { sha, game, filename }. Rate limit: 1 vote per IP per config per 24h.
async function handleVote(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { sha } = body;
  if (!sha) return json({ error: "sha required" }, 400);
  if (!env.CONFIG_KV) return json({ error: "KV not configured" }, 503);

  const ip    = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = `voted:${ip}:${sha}`;
  const already = await env.CONFIG_KV.get(ipKey);
  if (already) {
    const cur = parseInt(await env.CONFIG_KV.get("votes:" + sha) || "0");
    return json({ error: "already_voted", votes: cur }, 409);
  }

  const { game } = body;
  const current  = parseInt(await env.CONFIG_KV.get("votes:" + sha) || "0");
  const newCount = current + 1;
  await kvPut(env.CONFIG_KV, "votes:" + sha, String(newCount));
  await kvPut(env.CONFIG_KV, ipKey, "1", { expirationTtl: 86400 });
  if (game) await kvDelete(env.CONFIG_KV, "cache:list:" + game);

  return json({ success: true, votes: newCount });
}

// ── POST /report ──────────────────────────────────────────────────────────────
// Body: { sha }. Rate limit: 1 report per IP per config per 7 days.
async function handleReport(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { sha } = body;
  if (!sha) return json({ error: "sha required" }, 400);
  if (!env.CONFIG_KV) return json({ error: "KV not configured" }, 503);

  const ip    = request.headers.get("CF-Connecting-IP") || "unknown";
  const ipKey = `reported:${ip}:${sha}`;
  const already = await env.CONFIG_KV.get(ipKey);
  if (already) {
    const cur = parseInt(await env.CONFIG_KV.get("reports:" + sha) || "0");
    return json({ error: "already_reported", reports: cur }, 409);
  }

  const current  = parseInt(await env.CONFIG_KV.get("reports:" + sha) || "0");
  const newCount = current + 1;
  await kvPut(env.CONFIG_KV, "reports:" + sha, String(newCount));
  await kvPut(env.CONFIG_KV, ipKey, "1", { expirationTtl: 604800 });

  return json({ success: true, reports: newCount });
}

// ── POST /describe ────────────────────────────────────────────────────────────
// Body: { sha, token, text }. Sets the uploader's description for a config.
// Validates that token matches what was stored at upload time.
async function handleDescribe(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { sha, token, text } = body;
  if (!sha || !token || text === undefined) {
    return json({ error: "sha, token, text required" }, 400);
  }
  if (!env.CONFIG_KV) return json({ error: "KV not configured" }, 503);

  const stored = await env.CONFIG_KV.get("token:" + sha);
  if (!stored || stored !== String(token)) {
    return json({ error: "unauthorized" }, 403);
  }

  const safeText = String(text).slice(0, 500).replace(/[<>]/g, "");
  await kvPut(env.CONFIG_KV, "desc:" + sha, safeText);
  return json({ success: true });
}

// ── GET /desc?sha=X ───────────────────────────────────────────────────────────
// Returns the uploader's description for a config, or empty string if none set.
async function handleGetDesc(url, env) {
  const sha = url.searchParams.get("sha");
  if (!sha) return json({ error: "sha required" }, 400);
  if (!env.CONFIG_KV) return json({ text: "" });
  const text = await env.CONFIG_KV.get("desc:" + sha);
  return json({ text: text || "" });
}

// ── GET /comments?game=X&file=Y ───────────────────────────────────────────────
async function handleGetComments(url, env) {
  const game = url.searchParams.get("game");
  const file = url.searchParams.get("file");
  if (!game || !file) return json({ error: "game and file required" }, 400);
  if (!env.CONFIG_KV) return json([], 200);
  const key = `comments:${game}/${file}`;
  try {
    const raw = await env.CONFIG_KV.get(key);
    return json(raw ? JSON.parse(raw) : []);
  } catch (e) { return json([]); }
}

// ── POST /comment ─────────────────────────────────────────────────────────────
// Body: { game, filename, text, device }. Max 500 chars, 200 comments per config.
async function handlePostComment(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const { game, filename, text, device } = body;
  if (!game || !filename || !text) return json({ error: "game, filename, text required" }, 400);
  if (!env.CONFIG_KV) return json({ error: "KV not configured" }, 503);

  const safeText = String(text).slice(0, 500).replace(/[<>]/g, "");
  const key = `comments:${game}/${filename}`;
  try {
    const raw = await env.CONFIG_KV.get(key);
    const arr = raw ? JSON.parse(raw) : [];
    if (arr.length >= 200) arr.shift();
    arr.push({
      text:   safeText,
      device: String(device || "Anonymous").slice(0, 60).replace(/[<>]/g, ""),
      date:   new Date().toISOString().split("T")[0],
      ts:     Math.floor(Date.now() / 1000)
    });
    await kvPut(env.CONFIG_KV, key, JSON.stringify(arr));
  } catch (e) { /* skip */ }
  return json({ success: true });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── GET /steam/search?name=X ──────────────────────────────────────────────────
// Proxies Steam store search to avoid CORS. Returns { appid, name, cover }.
async function handleSteamSearch(url) {
  const name = url.searchParams.get("name");
  if (!name) return json({ error: "name required" }, 400);

  const searchUrl = `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=US`;
  try {
    const res = await fetch(searchUrl, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    if (!res.ok) return json({ error: "Steam API error" }, 502);
    const data = await res.json();
    const items = data.items || [];
    if (items.length === 0) return json({ appid: null });

    // Pick best match — prefer exact name match, otherwise first result
    const lower = name.toLowerCase();
    const exact = items.find(i => i.name.toLowerCase() === lower);
    const best  = exact || items[0];

    return json({
      appid: best.id,
      name:  best.name,
      cover: `https://cdn.akamai.steamstatic.com/steam/apps/${best.id}/header.jpg`
    });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

// ── Admin brute-force protection ──────────────────────────────────────────────
// 5 failed attempts per IP locks out for 15 minutes.
const MAX_ATTEMPTS = 5;
const LOCKOUT_TTL  = 900; // 15 min in seconds

async function checkAdminAuth(request, env, password) {
  if (!env.CONFIG_KV) return { ok: false, error: "KV not configured" };
  const ip       = request.headers.get("CF-Connecting-IP") || "unknown";
  const lockKey  = `admin:lock:${ip}`;
  const failKey  = `admin:fail:${ip}`;

  const locked = await env.CONFIG_KV.get(lockKey);
  if (locked) return { ok: false, error: "Too many failed attempts — try again in 15 minutes." };

  if (!password || password !== env.ADMIN_SECRET) {
    const fails = parseInt(await env.CONFIG_KV.get(failKey) || "0") + 1;
    if (fails >= MAX_ATTEMPTS) {
      await env.CONFIG_KV.put(lockKey, "1", { expirationTtl: LOCKOUT_TTL });
      await env.CONFIG_KV.delete(failKey);
      return { ok: false, error: "Too many failed attempts — locked out for 15 minutes." };
    }
    await env.CONFIG_KV.put(failKey, String(fails), { expirationTtl: LOCKOUT_TTL });
    return { ok: false, error: "Unauthorized" };
  }

  // Success — clear any fail counter
  await env.CONFIG_KV.delete(failKey);
  return { ok: true };
}

// ── POST /delete ──────────────────────────────────────────────────────────────
// Body: { sha, game, filename, upload_token }
// Verifies upload_token matches stored token, then deletes file + cleans up KV.
async function handleUserDelete(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { sha, game, filename, upload_token } = body;
  if (!sha || !game || !filename || !upload_token) {
    return json({ error: "sha, game, filename, upload_token required" }, 400);
  }
  if (!env.CONFIG_KV) return json({ error: "KV not configured" }, 503);

  const stored = await env.CONFIG_KV.get("token:" + sha);
  if (!stored || stored !== String(upload_token).slice(0, 64)) {
    return json({ error: "unauthorized" }, 403);
  }

  const path = `configs/${game}/${filename}`;
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;

  const getRes = await ghFetch(apiUrl, env);
  if (!getRes.ok) return json({ error: "File not found on server" }, 404);
  const fileData = await getRes.json();

  const delRes = await ghFetch(apiUrl, env, {
    method: "DELETE",
    body: JSON.stringify({
      message: `User delete: ${path}`,
      sha: fileData.sha,
      committer: { name: "BannerHub User", email: "bannerhub@users.noreply.github.com" }
    })
  });

  if (!delRes.ok) {
    const err = await delRes.text();
    return json({ error: "GitHub error: " + err }, 502);
  }

  // Clean up all KV keys for this sha/game
  if (env.CONFIG_KV) {
    await kvDelete(env.CONFIG_KV, "token:"    + sha);
    await kvDelete(env.CONFIG_KV, "votes:"    + sha);
    await kvDelete(env.CONFIG_KV, "downloads:" + sha);
    await kvDelete(env.CONFIG_KV, "reports:"  + sha);
    await kvDelete(env.CONFIG_KV, "desc:"     + sha);
    await kvDelete(env.CONFIG_KV, `comments:${game}/${filename}`);
    await kvDelete(env.CONFIG_KV, "cache:list:" + game);
    await kvDelete(env.CONFIG_KV, "cache:games");
    // Decrement game count
    const cur = parseInt(await env.CONFIG_KV.get("counts:" + game) || "0");
    if (cur > 1) await kvPut(env.CONFIG_KV, "counts:" + game, String(cur - 1));
    else         await kvDelete(env.CONFIG_KV, "counts:" + game);
  }

  return json({ success: true });
}

// ── POST /admin/delete ────────────────────────────────────────────────────────
// Body: { game, filename, password }
async function handleAdminDelete(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { game, filename, password } = body;
  const auth = await checkAdminAuth(request, env, password);
  if (!auth.ok) return json({ error: auth.error }, 401);
  if (!game || !filename) return json({ error: "game and filename required" }, 400);

  const path = `configs/${game}/${filename}`;
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;

  const getRes = await ghFetch(apiUrl, env);
  if (!getRes.ok) return json({ error: "File not found" }, 404);
  const fileData = await getRes.json();

  const delRes = await ghFetch(apiUrl, env, {
    method: "DELETE",
    body: JSON.stringify({
      message: `Admin delete: ${path}`,
      sha: fileData.sha,
      committer: { name: "BannerHub Admin", email: "bannerhub@users.noreply.github.com" }
    })
  });

  if (!delRes.ok) {
    const err = await delRes.text();
    return json({ error: "GitHub error: " + err }, 502);
  }

  if (env.CONFIG_KV) {
    await kvDelete(env.CONFIG_KV, "cache:games");
    await kvDelete(env.CONFIG_KV, "cache:list:" + game);
  }

  return json({ success: true });
}

// ── POST /admin/edit ──────────────────────────────────────────────────────────
// Body: { game, filename, content (JSON string), password }
async function handleAdminEdit(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const { game, filename, content, password } = body;
  const auth = await checkAdminAuth(request, env, password);
  if (!auth.ok) return json({ error: auth.error }, 401);
  if (!game || !filename || !content) return json({ error: "game, filename, and content required" }, 400);

  try { JSON.parse(content); } catch { return json({ error: "Content is not valid JSON" }, 400); }

  const path = `configs/${game}/${filename}`;
  const apiUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${encodeURIComponent(path)}`;

  const getRes = await ghFetch(apiUrl, env);
  if (!getRes.ok) return json({ error: "File not found" }, 404);
  const fileData = await getRes.json();

  const putRes = await ghFetch(apiUrl, env, {
    method: "PUT",
    body: JSON.stringify({
      message: `Admin edit: ${path}`,
      content: btoa(content),
      sha: fileData.sha,
      committer: { name: "BannerHub Admin", email: "bannerhub@users.noreply.github.com" }
    })
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    return json({ error: "GitHub error: " + err }, 502);
  }

  if (env.CONFIG_KV) await kvDelete(env.CONFIG_KV, "cache:list:" + game);

  return json({ success: true });
}

function ghFetch(url, env, options = {}) {
  return fetch(url, {
    method:  options.method || "GET",
    headers: {
      Authorization:  `Bearer ${env.GITHUB_TOKEN}`,
      Accept:         "application/vnd.github+json",
      "User-Agent":   "BannerHub-Configs-Worker",
      "Content-Type": "application/json"
    },
    body: options.body || undefined
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
