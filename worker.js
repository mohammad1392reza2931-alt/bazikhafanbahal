// worker.js — Strike Zone backend
//   * Durable Object "Relay": 2-player co-op/PvP relay over WebSocket (host / join / data / pvpQueue)
//   * D1 API:  POST /api/login   POST /api/save   GET /api/leaderboard   GET /api/check-ban
//              POST /api/admin-grant (creator only)   POST /api/admin-ban (creator only)
//   * Admin key: the ADMIN_KEY constant below (must match ADMIN_KEY in index-dev.html). If a Cloudflare secret named ADMIN_KEY exists it takes priority.
//
// The D1 database and the Durable Object namespace are found automatically among the
// bindings, so their names in wrangler.jsonc don't matter.  The exported class name
// must stay "Relay" (that's the class_name declared in wrangler.jsonc).

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// ---------- binding discovery ----------
function findBinding(env, test) {
  for (const k of Object.keys(env || {})) {
    const v = env[k];
    if (v && typeof v === "object" && test(v)) return v;
  }
  return null;
}
function getDB(env) {
  return env.DB || findBinding(env, (v) => typeof v.prepare === "function" && typeof v.batch === "function");
}
function getRelayNamespace(env) {
  return env.RELAY || env.ARENA || findBinding(env, (v) => typeof v.idFromName === "function");
}

// ---------- password hashing (SHA-256 + per-account salt) ----------
async function hashPassword(password, salt) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(salt + ":" + password));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomSalt() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- D1 helpers (tables are created automatically) ----------
let schemaReady = false;
async function ensureSchema(DB) {
  if (schemaReady) return;
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS scores (
       username TEXT PRIMARY KEY,
       best_score INTEGER NOT NULL DEFAULT 0,
       updated_at INTEGER
     )`
  ).run();
  await DB.prepare(
    `CREATE TABLE IF NOT EXISTS player_saves (
       username TEXT PRIMARY KEY COLLATE NOCASE,
       save_data TEXT NOT NULL,
       password_hash TEXT,
       password_salt TEXT,
       updated_at INTEGER NOT NULL
     )`
  ).run();
  // migrate a table created before password columns existed (errors if columns already exist -> ignored)
  try { await DB.prepare(`ALTER TABLE player_saves ADD COLUMN password_hash TEXT`).run(); } catch (e) {}
  try { await DB.prepare(`ALTER TABLE player_saves ADD COLUMN password_salt TEXT`).run(); } catch (e) {}
  try { await DB.prepare(`ALTER TABLE player_saves ADD COLUMN banned INTEGER NOT NULL DEFAULT 0`).run(); } catch (e) {}
  schemaReady = true;
}

async function upsertScore(DB, username, score) {
  await DB.prepare(
    `INSERT INTO scores (username, best_score, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       best_score = MAX(scores.best_score, excluded.best_score),
       updated_at = excluded.updated_at`
  ).bind(username, score, Date.now()).run();
}

// POST /api/save  { username, password, saveData, bestScore }
// First save for a username registers it with that password; later saves must match it.
// A legacy account with no password yet (saved before this feature existed) gets secured
// by whatever password is sent on its next save.
async function handleSave(request, DB) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "invalid json" }, 400); }
  const username = String(body.username || "").trim().slice(0, 20);
  const password = String(body.password || "");
  if (!username) return jsonResponse({ error: "username required" }, 400);
  if (!password) return jsonResponse({ error: "password required" }, 400);
  if (!body.saveData || typeof body.saveData !== "object") return jsonResponse({ error: "saveData required" }, 400);
  const json = JSON.stringify(body.saveData);
  if (json.length > 100000) return jsonResponse({ error: "saveData too large" }, 413);

  await ensureSchema(DB);
  const existing = await DB.prepare("SELECT password_hash, password_salt FROM player_saves WHERE username = ?").bind(username).first();

  let salt, hash;
  if (existing && existing.password_hash) {
    salt = existing.password_salt;
    hash = await hashPassword(password, salt);
    if (hash !== existing.password_hash) return jsonResponse({ error: "wrong-password" }, 401);
  } else {
    salt = randomSalt();
    hash = await hashPassword(password, salt);
  }

  await DB.prepare(
    `INSERT INTO player_saves (username, save_data, password_hash, password_salt, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       save_data = excluded.save_data,
       password_hash = excluded.password_hash,
       password_salt = excluded.password_salt,
       updated_at = excluded.updated_at`
  ).bind(username, json, hash, salt, Date.now()).run();

  const score = Number.isFinite(body.bestScore) ? Math.max(0, Math.floor(body.bestScore)) : 0;
  if (score > 0) {
    try { await upsertScore(DB, username, score); } catch (e) { /* leaderboard problems must never block saving */ }
  }
  return jsonResponse({ ok: true });
}

// POST /api/login  { username, password }  -> { found, saveData } or { error:"wrong-password" }
async function handleLogin(request, DB) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "invalid json" }, 400); }
  const username = String(body.username || "").trim().slice(0, 20);
  const password = String(body.password || "");
  if (!username) return jsonResponse({ found: false });
  await ensureSchema(DB);
  const row = await DB.prepare("SELECT save_data, password_hash, password_salt FROM player_saves WHERE username = ?").bind(username).first();
  if (!row) return jsonResponse({ found: false });
  if (row.password_hash) {
    const hash = await hashPassword(password, row.password_salt);
    if (hash !== row.password_hash) return jsonResponse({ error: "wrong-password" }, 401);
  }
  let saveData;
  try { saveData = JSON.parse(row.save_data); } catch (e) { return jsonResponse({ found: false }); }
  return jsonResponse({ found: true, saveData });
}

// GET /api/leaderboard
async function handleLeaderboard(DB) {
  await ensureSchema(DB);
  const { results } = await DB.prepare(
    "SELECT username, best_score FROM scores ORDER BY best_score DESC LIMIT 10"
  ).all();
  // The game inserts usernames into the page as HTML, so neutralise any HTML characters here (a name like <img onerror=...> can't run code).
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safe = (results || []).map((r) => ({ username: esc(r.username), best_score: Number(r.best_score) || 0 }));
  return jsonResponse({ leaderboard: safe });
}

// GET /api/check-ban?u=username  -> { banned: true|false }
async function handleCheckBan(url, DB) {
  const username = String(url.searchParams.get("u") || "").trim().slice(0, 20);
  if (!username) return jsonResponse({ banned: false });
  await ensureSchema(DB);
  const row = await DB.prepare("SELECT banned FROM player_saves WHERE username = ?").bind(username).first();
  return jsonResponse({ banned: !!(row && Number(row.banned) === 1) });
}

// ---------- admin (creator-only) tools ----------
// Must match ADMIN_KEY in your private index-dev.html. Anyone who sees this file can use the endpoint, so keep the repo private
// (or paste this file straight into Cloudflare without uploading it to a public GitHub repo).
const ADMIN_KEY = "sz-creator-9f3ak2m7";

// POST /api/admin-grant  { adminKey, username, diamonds }
async function handleAdminGrant(request, DB, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "invalid json" }, 400); }
  const adminKey = String((env && env.ADMIN_KEY) || ADMIN_KEY);
  if (!adminKey || String(body.adminKey || "") !== adminKey) return jsonResponse({ error: "forbidden" }, 403);
  const username = String(body.username || "").trim().slice(0, 20);
  const amount = Math.floor(Number(body.diamonds) || 0);
  if (!username) return jsonResponse({ error: "username required" }, 400);
  if (!amount) return jsonResponse({ error: "diamonds amount required" }, 400);

  await ensureSchema(DB);
  const row = await DB.prepare("SELECT save_data FROM player_saves WHERE username = ?").bind(username).first();
  if (!row) return jsonResponse({ error: "player-not-found" }, 404);

  let saveData;
  try { saveData = JSON.parse(row.save_data); } catch (e) { return jsonResponse({ error: "corrupt-save" }, 500); }
  saveData.diamonds = Math.max(0, Math.floor(saveData.diamonds || 0) + amount);
  await DB.prepare(
    `UPDATE player_saves SET save_data = ?, updated_at = ? WHERE username = ?`
  ).bind(JSON.stringify(saveData), Date.now(), username).run();

  return jsonResponse({ ok: true, newDiamondTotal: saveData.diamonds });
}

// POST /api/admin-ban  { adminKey, username, banned }
// A banned player can still log in and play solo, but is refused co-op/PvP relay access.
async function handleAdminBan(request, DB, env) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "invalid json" }, 400); }
  const adminKey = String((env && env.ADMIN_KEY) || ADMIN_KEY);
  if (!adminKey || String(body.adminKey || "") !== adminKey) return jsonResponse({ error: "forbidden" }, 403);
  const username = String(body.username || "").trim().slice(0, 20);
  if (!username) return jsonResponse({ error: "username required" }, 400);
  const banned = body.banned ? 1 : 0;

  await ensureSchema(DB);
  const row = await DB.prepare("SELECT username FROM player_saves WHERE username = ?").bind(username).first();
  if (!row) return jsonResponse({ error: "player-not-found" }, 404);

  await DB.prepare(`UPDATE player_saves SET banned = ? WHERE username = ?`).bind(banned, username).run();
  return jsonResponse({ ok: true, username, banned: !!banned });
}

const NO_DB = () => jsonResponse({ error: "D1 database binding not found in this Worker" }, 500);

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const isApi = url.pathname.startsWith("/api/");

      if (request.method === "OPTIONS" && isApi) return new Response(null, { headers: CORS });

      if (isApi) {
        const DB = getDB(env);
        if (url.pathname === "/api/save" && request.method === "POST") return DB ? await handleSave(request, DB) : NO_DB();
        if (url.pathname === "/api/login" && request.method === "POST") return DB ? await handleLogin(request, DB) : NO_DB();
        if (url.pathname === "/api/admin-grant" && request.method === "POST") return DB ? await handleAdminGrant(request, DB, env) : NO_DB();
        if (url.pathname === "/api/admin-ban" && request.method === "POST") return DB ? await handleAdminBan(request, DB, env) : NO_DB();
        if (url.pathname === "/api/check-ban" && request.method === "GET") return DB ? await handleCheckBan(url, DB) : NO_DB();
        if (url.pathname === "/api/leaderboard" && request.method === "GET") return DB ? await handleLeaderboard(DB) : NO_DB();
        return jsonResponse({ error: "not found" }, 404);
      }

      // WebSocket connections from the game (co-op / PvP) go to the Relay Durable Object.
      // The client appends ?u=<username> to the socket URL so a banned account can be refused here,
      // before it ever reaches the Durable Object.
      if (request.headers.get("Upgrade") === "websocket") {
        const DB = getDB(env);
        const uname = String(url.searchParams.get("u") || "").trim().slice(0, 20);
        if (DB && uname) {
          try {
            await ensureSchema(DB);
            const row = await DB.prepare("SELECT banned FROM player_saves WHERE username = ?").bind(uname).first();
            if (row && Number(row.banned) === 1) return jsonResponse({ error: "banned" }, 403);
          } catch (e) { /* if the ban lookup itself fails, don't block legitimate play */ }
        }
        const ns = getRelayNamespace(env);
        if (!ns) return jsonResponse({ error: "Durable Object binding not found in this Worker" }, 500);
        const stub = ns.get(ns.idFromName("global-relay"));
        return await stub.fetch(request);
      }

      // Plain visit (e.g. opening the address in a browser): tiny health check.
      return jsonResponse({ ok: true, service: "strike-zone" });
    } catch (e) {
      // Always answer WITH CORS headers so the game can read the real error.
      return jsonResponse({ error: String((e && e.message) || e) }, 500);
    }
  },
};

// ---------- Durable Object: 2-player co-op / PvP relay ----------
// Client protocol (see the game):
//   -> {type:'host', kind}           <- {type:'hosted', code}            (kind: 'coop' | 'pvp', defaults to 'coop')
//   -> {type:'join', code, kind}     <- {type:'joined'} (to joiner) + {type:'peer-connected'} (to host)  |  {type:'join-error'}
//   -> {type:'data', payload}        <- {type:'data', payload}   (forwarded to the other player)
//   -> {type:'pvpQueue'}             <- {type:'pvp-matched', role:'host'|'client'}  (sent to BOTH once 2 players are queued)
//   -> {type:'pvpQueueCancel'}       (leaves the random-matchmaking queue)
//   peer leaves                      <- {type:'peer-disconnected'}
export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map(); // code -> { host: ws, guest: ws|null, kind: 'coop'|'pvp' }
    this.pvpQueue = [];     // ws[] waiting for random PvP matchmaking ("پی‌وی‌پی شانسی")
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener("message", (ev) => this.onMessage(server, ev.data));
    server.addEventListener("close", () => { this.leaveQueue(server); this.leaveRoom(server); });
    server.addEventListener("error", () => { this.leaveQueue(server); this.leaveRoom(server); });
    return new Response(null, { status: 101, webSocket: client });
  }

  genCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do {
      code = "";
      for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
    } while (this.rooms.has(code));
    return code;
  }

  send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) {}
  }

  onMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "host") {
      this.leaveQueue(ws);
      this.leaveRoom(ws);
      const kind = msg.kind === "pvp" ? "pvp" : "coop";
      const code = this.genCode();
      this.rooms.set(code, { host: ws, guest: null, kind });
      ws._code = code;
      ws._role = "host";
      this.send(ws, { type: "hosted", code });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase().trim();
      const kind = msg.kind === "pvp" ? "pvp" : "coop";
      const room = this.rooms.get(code);
      if (!room || !room.host || room.guest || room.kind !== kind) { this.send(ws, { type: "join-error" }); return; }
      this.leaveQueue(ws);
      this.leaveRoom(ws);
      room.guest = ws;
      ws._code = code;
      ws._role = "guest";
      this.send(ws, { type: "joined" });
      this.send(room.host, { type: "peer-connected" });
      return;
    }

    // ---- "پی‌وی‌پی شانسی" (random PvP): first player to queue up after you gets matched with you ----
    if (msg.type === "pvpQueue") {
      this.leaveRoom(ws);
      this.leaveQueue(ws); // avoid double-queueing the same socket
      this.pvpQueue.push(ws);
      if (this.pvpQueue.length >= 2) {
        const hostWs = this.pvpQueue.shift();
        const guestWs = this.pvpQueue.shift();
        const code = this.genCode();
        this.rooms.set(code, { host: hostWs, guest: guestWs, kind: "pvp" });
        hostWs._code = code; hostWs._role = "host";
        guestWs._code = code; guestWs._role = "guest";
        this.send(hostWs, { type: "pvp-matched", role: "host" });
        this.send(guestWs, { type: "pvp-matched", role: "client" });
      }
      return;
    }

    if (msg.type === "pvpQueueCancel") {
      this.leaveQueue(ws);
      return;
    }

    if (msg.type === "data") {
      const room = this.rooms.get(ws._code);
      if (!room) return;
      const other = ws._role === "host" ? room.guest : room.host;
      if (other) this.send(other, { type: "data", payload: msg.payload });
    }
  }

  leaveQueue(ws) {
    const i = this.pvpQueue.indexOf(ws);
    if (i >= 0) this.pvpQueue.splice(i, 1);
  }

  leaveRoom(ws) {
    const code = ws._code;
    if (!code) return;
    ws._code = null;
    const room = this.rooms.get(code);
    if (!room) return;
    const other = ws._role === "host" ? room.guest : room.host;
    this.rooms.delete(code);
    if (other) {
      other._code = null;
      this.send(other, { type: "peer-disconnected" });
    }
  }
}
