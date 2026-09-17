const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Game relay server is running.");
});

const wss = new WebSocket.Server({ server });

// code -> { host: ws|null, guest: ws|null }
const rooms = new Map();

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // بدون حروف/اعداد شبیه‌به‌هم

function genCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function safeSend(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on("connection", (ws) => {
  ws.roomCode = null;
  ws.role = null; // "host" | "guest"
  ws.isAlive = true;

  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (e) {
      return;
    }

    if (msg.type === "host") {
      const code = genCode();
      rooms.set(code, { host: ws, guest: null });
      ws.roomCode = code;
      ws.role = "host";
      safeSend(ws, { type: "hosted", code });
      return;
    }

    if (msg.type === "join") {
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room || !room.host || room.guest) {
        safeSend(ws, { type: "join-error", reason: "not-found" });
        return;
      }
      room.guest = ws;
      ws.roomCode = code;
      ws.role = "guest";
      safeSend(ws, { type: "joined" });
      safeSend(room.host, { type: "peer-connected" });
      return;
    }

    if (msg.type === "data") {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const target = ws.role === "host" ? room.guest : room.host;
      safeSend(target, { type: "data", payload: msg.payload });
      return;
    }
  });

  ws.on("close", () => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const other = ws.role === "host" ? room.guest : room.host;
    safeSend(other, { type: "peer-disconnected" });
    if (ws.role === "host") {
      rooms.delete(ws.roomCode); // اگه هاست بره، کل اتاق بسته میشه
    } else if (room) {
      room.guest = null; // اگه مهمون بره، اتاق برای یه مهمون جدید باز می‌مونه
    }
  });
});

// پینگ دوره‌ای برای بستن کانکشن‌های مرده (و جلوگیری از خواب رفتن رندر روی پلن پولی)
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => clearInterval(interval));

server.listen(PORT, () => {
  console.log("Relay server listening on port " + PORT);
});

