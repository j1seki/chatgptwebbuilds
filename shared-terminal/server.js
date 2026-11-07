import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
const rooms = new Map();
const pendingCreates = new Map();
const port = Number(process.env.PORT || 3001);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "";
const runnerToken = process.env.RUNNER_TOKEN || "";
let runner = null;

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && origin === frontendOrigin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  }
  if (req.method === "OPTIONS") return res.sendStatus(origin === frontendOrigin ? 204 : 403);
  next();
});
app.use(express.json({ limit: "8kb" }));
app.get("/health", (_req, res) => res.json({ ok: true, runnerConnected: Boolean(runner && runner.readyState === WebSocket.OPEN) }));

app.post("/api/rooms", async (_req, res) => {
  if (!runner || runner.readyState !== WebSocket.OPEN) {
    return res.status(503).json({ error: "The free execution host is offline. Start the shared-terminal worker on the host machine and try again." });
  }
  const id = crypto.randomBytes(5).toString("hex").toUpperCase();
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const room = { id, ownerToken, clients: new Map(), busy: false };
  rooms.set(id, room);
  const timeout = setTimeout(() => {
    pendingCreates.delete(id);
    rooms.delete(id);
    res.status(504).json({ error: "The execution host did not create the room in time." });
  }, 30000);
  pendingCreates.set(id, {
    resolve: () => { clearTimeout(timeout); res.status(201).json({ roomId: id, ownerToken }); },
    reject: message => { clearTimeout(timeout); rooms.delete(id); res.status(502).json({ error: message }); }
  });
  runner.send(JSON.stringify({ type: "create", roomId: id }));
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/worker") {
    const auth = req.headers.authorization || "";
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!runnerToken || !sameSecret(supplied, runnerToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req, true));
    return;
  }
  const origin = req.headers.origin;
  if (frontendOrigin && origin && origin !== frontendOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req, false));
});

function sameSecret(a, b) {
  const x = Buffer.from(a || ""), y = Buffer.from(b || "");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function send(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function broadcast(room, payload) { for (const ws of room.clients.keys()) send(ws, payload); }

wss.on("connection", (ws, req, isWorker) => {
  if (isWorker) {
    if (runner && runner.readyState === WebSocket.OPEN) runner.close();
    runner = ws;
    console.log("Execution worker connected.");
    ws.on("message", raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      if (message.type === "room_created" || message.type === "room_error") {
        const pending = pendingCreates.get(message.roomId);
        if (pending) {
          pendingCreates.delete(message.roomId);
          if (message.type === "room_created") pending.resolve();
          else pending.reject("Could not create the isolated Docker container: " + String(message.message || "unknown error").slice(0, 300));
        }
        return;
      }
      const room = rooms.get(message.roomId);
      if (!room) return;
      if (message.type === "output") broadcast(room, { type: "output", stream: message.stream, data: message.data });
      if (message.type === "exit") {
        broadcast(room, { type: "exit", code: message.code });
        room.busy = false;
        broadcast(room, { type: "ready" });
      }
      if (message.type === "exec_error") {
        broadcast(room, { type: "error", message: message.message || "Execution failed." });
        room.busy = false;
        broadcast(room, { type: "ready" });
      }
    });
    ws.on("close", () => {
      if (runner === ws) runner = null;
      console.warn("Execution worker disconnected.");
      for (const room of rooms.values()) { room.busy = false; broadcast(room, { type: "error", message: "Execution host disconnected. Existing sessions are unavailable until it reconnects." }); broadcast(room, { type: "ready" }); }
    });
    return;
  }

  const url = new URL(req.url, "http://localhost");
  const room = rooms.get((url.searchParams.get("room") || "").toUpperCase());
  if (!room) { send(ws, { type: "error", message: "Room not found; the host may have disconnected or the server restarted." }); ws.close(); return; }
  const owner = sameSecret(url.searchParams.get("token"), room.ownerToken);
  const client = { id: crypto.randomUUID(), owner, approved: owner };
  room.clients.set(ws, client);
  send(ws, { type: "connected", role: owner ? "host" : "guest", clientId: client.id });
  if (!owner) {
    send(ws, { type: "waiting" });
    for (const [peer, info] of room.clients) if (info.owner) send(peer, { type: "request", clientId: client.id });
  }

  ws.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === "approve" && client.owner) {
      for (const [peer, info] of room.clients) if (info.id === message.clientId && !info.owner) {
        info.approved = true; send(peer, { type: "approved" }); send(ws, { type: "approved_guest", clientId: info.id });
      }
      return;
    }
    if (message.type === "revoke" && client.owner) {
      for (const [peer, info] of room.clients) if (info.id === message.clientId && !info.owner) {
        info.approved = false; send(peer, { type: "revoked" });
      }
      return;
    }
    if (message.type !== "command") return;
    if (!client.owner && !client.approved) return send(ws, { type: "error", message: "The host has not approved your access." });
    const command = String(message.command || "").trim();
    if (!command || command.length > 2000) return;
    if (!runner || runner.readyState !== WebSocket.OPEN) return send(ws, { type: "error", message: "Execution host is offline." });
    if (room.busy) return send(ws, { type: "error", message: "A command is already running." });
    room.busy = true;
    broadcast(room, { type: "command", command, by: client.id });
    runner.send(JSON.stringify({ type: "exec", roomId: room.id, requestId: crypto.randomUUID(), command }));
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    if (client.owner) {
      broadcast(room, { type: "host_left" });
      rooms.delete(room.id);
      if (runner?.readyState === WebSocket.OPEN) send(runner, { type: "destroy", roomId: room.id });
    }
  });
});

server.listen(port, () => console.log(`Shared terminal API listening on ${port}`));
