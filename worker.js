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

export default {
  async fetch(request, env) {
    const id = env.RELAY.idFromName("global-room-manager");
    const stub = env.RELAY.get(id);
    return stub.fetch(request);
  }
};
