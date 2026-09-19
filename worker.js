// worker.js — Strike Zone backend
//   * Durable Object "Relay": 2-player co-op relay over WebSocket (host / join / data)
//   * D1 API:  POST /api/save   GET /api/load   GET /api/leaderboard   POST /api/submit
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

// POST /api/submit  { username, score }
async function handleSubmit(request, DB) {
  let body;
  try { body = await request.json(); } catch (e) { return jsonResponse({ error: "invalid json" }, 400); }
  const username = String(body.username || "").trim().slice(0, 20);
  const score = Number.isFinite(body.score) ? Math.max(0, Math.floor(body.score)) : 0;
  if (!username) return jsonResponse({ error: "username required" }, 400);
  await ensureSchema(DB);
  await upsertScore(DB, username, score);
  return jsonResponse({ ok: true });
}

// GET /api/leaderboard
async function handleLeaderboard(DB) {
  await ensureSchema(DB);
  const { results } = await DB.prepare(
    "SELECT username, best_score FROM scores ORDER BY best_score DESC LIMIT 10"
  ).all();
  return jsonResponse({ leaderboard: results });
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
        if (url.pathname === "/api/submit" && request.method === "POST") return DB ? await handleSubmit(request, DB) : NO_DB();
        if (url.pathname === "/api/leaderboard" && request.method === "GET") return DB ? await handleLeaderboard(DB) : NO_DB();
        return jsonResponse({ error: "not found" }, 404);
      }

      // WebSocket connections from the game (co-op) go to the Relay Durable Object.
      if (request.headers.get("Upgrade") === "websocket") {
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

// ---------- Durable Object: 2-player co-op relay ----------
// Client protocol (see the game):
//   -> {type:'host'}                 <- {type:'hosted', code}
//   -> {type:'join', code}           <- {type:'joined'} (to joiner) + {type:'peer-connected'} (to host)  |  {type:'join-error'}
//   -> {type:'data', payload}        <- {type:'data', payload}   (forwarded to the other player)
//   peer leaves                      <- {type:'peer-disconnected'}
export class Relay {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.rooms = new Map(); // code -> { host: ws, guest: ws|null }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener("message", (ev) => this.onMessage(server, ev.data));
    server.addEventListener("close", () => this.leaveRoom(server));
    server.addEventListener("error", () => this.leaveRoom(server));
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
      this.leaveRoom(ws);
      const code = this.genCode();
      this.rooms.set(code, { host: ws, guest: null });
      ws._code = code;
      ws._role = "host";
      this.send(ws, { type: "hosted", code });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = this.rooms.get(code);
      if (!room || !room.host || room.guest) { this.send(ws, { type: "join-error" }); return; }
      this.leaveRoom(ws);
      room.guest = ws;
      ws._code = code;
      ws._role = "guest";
      this.send(ws, { type: "joined" });
      this.send(room.host, { type: "peer-connected" });
      return;
    }

    if (msg.type === "data") {
      const room = this.rooms.get(ws._code);
      if (!room) return;
      const other = ws._role === "host" ? room.guest : room.host;
      if (other) this.send(other, { type: "data", payload: msg.payload });
    }
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
