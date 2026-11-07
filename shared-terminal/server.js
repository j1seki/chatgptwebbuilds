import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const rooms = new Map();
const port = Number(process.env.PORT || 3001);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "";

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
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size }));

app.post("/api/rooms", (_req, res) => {
  const id = crypto.randomBytes(5).toString("hex").toUpperCase();
  const ownerToken = crypto.randomBytes(32).toString("hex");
  rooms.set(id, {
    id,
    ownerToken,
    host: null,
    clients: new Map(),
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 60 * 1000
  });
  res.status(201).json({ roomId: id, ownerToken });
});

function sameSecret(a, b) {
  const x = Buffer.from(a || ""), y = Buffer.from(b || "");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function send(ws, payload) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function broadcast(room, payload) {
  for (const ws of room.clients.keys()) send(ws, payload);
}
function isAllowed(room, client) {
  return client?.role === "host" || client?.approved === true;
}

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (frontendOrigin && origin && origin !== frontendOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url, "http://localhost");
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const room = rooms.get((url.searchParams.get("room") || "").toUpperCase());
  if (!room || room.expiresAt < Date.now()) {
    send(ws, { type: "error", message: "Room not found or expired." });
    ws.close();
    return;
  }
  const client = { id: crypto.randomUUID(), role: "guest", approved: false };
  room.clients.set(ws, client);
  send(ws, { type: "connected", clientId: client.id, role: "guest" });
  send(ws, { type: room.host ? "waiting" : "host_offline" });
  if (room.host) send(room.host, { type: "guest_request", clientId: client.id });

  ws.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }

    if (message.type === "host_auth" && client.role === "guest") {
      if (!sameSecret(message.token, room.ownerToken)) {
        send(ws, { type: "error", message: "Host authentication failed." });
        ws.close();
        return;
      }
      if (room.host && room.host !== ws) {
        send(ws, { type: "error", message: "This room already has an active host." });
        ws.close();
        return;
      }
      client.role = "host";
      client.approved = true;
      room.host = ws;
      send(ws, { type: "host_ready" });
      broadcast(room, { type: "host_online" });
      for (const [peer, info] of room.clients) {
        if (peer !== ws && info.role === "guest") send(ws, { type: "guest_request", clientId: info.id });
      }
      return;
    }

    if (message.type === "approve" && client.role === "host") {
      for (const [peer, info] of room.clients) {
        if (info.id === message.clientId && info.role === "guest") {
          info.approved = true;
          send(peer, { type: "approved" });
          send(ws, { type: "guest_approved", clientId: info.id });
        }
      }
      return;
    }
    if (message.type === "revoke" && client.role === "host") {
      for (const [peer, info] of room.clients) {
        if (info.id === message.clientId && info.role === "guest") {
          info.approved = false;
          send(peer, { type: "revoked" });
        }
      }
      return;
    }

    if (message.type === "input" || message.type === "resize") {
      if (!isAllowed(room, client)) {
        send(ws, { type: "error", message: "The host has not approved your access." });
        return;
      }
      if (!room.host || room.host.readyState !== WebSocket.OPEN) {
        send(ws, { type: "error", message: "The host browser is offline." });
        return;
      }
      if (message.type === "input") {
        const data = String(message.data || "");
        if (data.length > 4096) return;
        send(room.host, { type: "input", data, from: client.id });
      } else {
        send(room.host, {
          type: "resize",
          cols: Math.max(20, Math.min(300, Number(message.cols) || 80)),
          rows: Math.max(5, Math.min(100, Number(message.rows) || 24))
        });
      }
      return;
    }

    if (message.type === "output" && client.role === "host") {
      const data = String(message.data || "");
      if (data.length <= 16 * 1024) broadcast(room, { type: "output", data });
    }
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    if (client.role === "host" && room.host === ws) {
      room.host = null;
      broadcast(room, { type: "host_offline" });
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (room.expiresAt <= now || (room.clients.size === 0 && now - room.createdAt > 10 * 60 * 1000)) {
      for (const ws of room.clients.keys()) ws.close();
      rooms.delete(id);
    }
  }
}, 60_000).unref();

server.listen(port, () => console.log(`Shared Terminal signaling API listening on ${port}`));
