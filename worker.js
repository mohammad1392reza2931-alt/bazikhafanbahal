// ---------------- سرور رله برای Cloudflare Workers (Durable Object) ----------------

export class Relay {
  constructor(state, env) {
    this.state = state;
    this.rooms = new Map(); // code -> { host: ws|null, guest: ws|null }
  }

  async fetch(request) {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Game relay server is running.", { status: 200 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.roomCode = null;
    server.role = null;

    server.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      this.handleMessage(server, msg);
    });

    server.addEventListener("close", () => {
      this.handleClose(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  send(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {}
  }

  genCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code;
    do {
      code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    } while (this.rooms.has(code));
    return code;
  }

  handleMessage(ws, msg) {
    if (msg.type === "host") {
      const code = this.genCode();
      this.rooms.set(code, { host: ws, guest: null });
      ws.roomCode = code;
      ws.role = "host";
      this.send(ws, { type: "hosted", code });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = this.rooms.get(code);
      if (!room || !room.host || room.guest) {
        this.send(ws, { type: "join-error", reason: "not-found" });
        return;
      }
      room.guest = ws;
      ws.roomCode = code;
      ws.role = "guest";
      this.send(ws, { type: "joined" });
      this.send(room.host, { type: "peer-connected" });
      return;
    }

    if (msg.type === "data") {
      const room = this.rooms.get(ws.roomCode);
      if (!room) return;
      const target = ws.role === "host" ? room.guest : room.host;
      if (target) this.send(target, { type: "data", payload: msg.payload });
      return;
    }
  }

  handleClose(ws) {
    const room = this.rooms.get(ws.roomCode);
    if (!room) return;
    const other = ws.role === "host" ? room.guest : room.host;
    if (other) this.send(other, { type: "peer-disconnected" });
    if (ws.role === "host") {
      this.rooms.delete(ws.roomCode);
    } else {
      room.guest = null;
    }
  }
}

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

function cleanUsername(raw) {
  return String(raw || "").trim().slice(0, 20);
}

async function handleSave(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return jsonResponse({ error: "invalid json" }, 400);
  }
  const username = cleanUsername(body.username);
  if (!username) return jsonResponse({ error: "username required" }, 400);

  const saveData = JSON.stringify(body.saveData || {});
  const bestScore = Number.isFinite(body.bestScore) ? body.bestScore : 0;
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO players (username, save_data, best_score, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(username) DO UPDATE SET
       save_data = excluded.save_data,
       best_score = MAX(players.best_score, excluded.best_score),
       updated_at = excluded.updated_at`
  ).bind(username, saveData, bestScore, now).run();

  return jsonResponse({ ok: true });
}

async function handleLoad(request, env) {
  const url = new URL(request.url);
  const username = cleanUsername(url.searchParams.get("username"));
  if (!username) return jsonResponse({ error: "username required" }, 400);

  const row = await env.DB.prepare(
    "SELECT save_data, best_score FROM players WHERE username = ?"
  ).bind(username).first();

  if (!row) return jsonResponse({ found: false });

  let saveData = {};
  try { saveData = JSON.parse(row.save_data); } catch (e) {}
  return jsonResponse({ found: true, saveData, bestScore: row.best_score });
}

async function handleLeaderboard(env) {
  const { results } = await env.DB.prepare(
    "SELECT username, best_score FROM players ORDER BY best_score DESC LIMIT 10"
  ).all();
  return jsonResponse({ leaderboard: results });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { headers: CORS });
    }
    if (url.pathname === "/api/save" && request.method === "POST") {
      return handleSave(request, env);
    }
    if (url.pathname === "/api/load" && request.method === "GET") {
      return handleLoad(request, env);
    }
    if (url.pathname === "/api/leaderboard" && request.method === "GET") {
      return handleLeaderboard(env);
    }

    // fallback: existing WebSocket relay for co-op
    const id = env.RELAY.idFromName("global-room-manager");
    const stub = env.RELAY.get(id);
    return stub.fetch(request);
  }
};
