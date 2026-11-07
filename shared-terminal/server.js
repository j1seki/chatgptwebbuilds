import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import { Render } from "@renderinc/sdk";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
const rooms = new Map();
const port = Number(process.env.PORT || 3001);
const frontendOrigin = process.env.FRONTEND_ORIGIN || "*";
const render = process.env.RENDER_API_KEY
  ? new Render({ token: process.env.RENDER_API_KEY })
  : null;

app.use(express.json());
app.get("/health", (_req, res) => res.json({ ok: true, sandboxEnabled: Boolean(render) }));
app.get("/", (_req, res) => res.sendFile(new URL("./index.html", import.meta.url).pathname));

app.post("/api/rooms", async (_req, res) => {
  if (!render) return res.status(503).json({ error: "Render Sandboxes are not configured. Set RENDER_API_KEY on the API service." });
  const id = crypto.randomBytes(5).toString("hex").toUpperCase();
  const ownerToken = crypto.randomBytes(32).toString("hex");
  const room = { id, ownerToken, sandboxId: null, clients: new Map(), busy: false, createdAt: Date.now() };
  rooms.set(id, room);
  try {
    const sandbox = await render.sandboxes.create({
      timeoutSeconds: 3600,
      networkPolicy: { type: "deny-all" }
    });
    room.sandboxId = sandbox.id;
    await render.sandboxes.waitUntilRunning(sandbox.id, { timeoutMs: 120000 });
    res.status(201).json({ roomId: id, ownerToken });
  } catch (error) {
    rooms.delete(id);
    console.error("Sandbox provisioning failed", error);
    res.status(502).json({ error: "Could not provision the isolated terminal sandbox. Confirm Sandboxes are enabled and the API key is valid." });
  }
});

server.on("upgrade", (req, socket, head) => {
  const origin = req.headers.origin;
  if (frontendOrigin !== "*" && origin && origin !== frontendOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
});

function send(ws, payload) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload)); }
function broadcast(room, payload) { for (const ws of room.clients.keys()) send(ws, payload); }
function sameSecret(a, b) {
  const x = Buffer.from(a || ""), y = Buffer.from(b || "");
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, "http://localhost");
  const room = rooms.get((url.searchParams.get("room") || "").toUpperCase());
  if (!room) { send(ws, { type: "error", message: "Room not found (the host may have disconnected or the server restarted)." }); ws.close(); return; }
  const owner = sameSecret(url.searchParams.get("token"), room.ownerToken);
  const client = { id: crypto.randomUUID(), owner, approved: owner };
  room.clients.set(ws, client);
  send(ws, { type: "connected", role: owner ? "host" : "guest", clientId: client.id });
  if (!owner) {
    send(ws, { type: "waiting" });
    for (const [peer, info] of room.clients) if (info.owner) send(peer, { type: "request", clientId: client.id });
  }

  ws.on("message", async raw => {
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
    if (room.busy) return send(ws, { type: "error", message: "A command is already running." });
    room.busy = true;
    broadcast(room, { type: "command", command, by: client.id });
    try {
      const stream = await render.sandboxes.exec(room.sandboxId, command);
      let exitSeen = false;
      for await (const event of stream) {
        if (event.type === "output") broadcast(room, { type: "output", stream: event.stream, data: event.data });
        if (event.type === "exit") { exitSeen = true; broadcast(room, { type: "exit", code: event.exit_code }); }
      }
      if (!exitSeen) broadcast(room, { type: "error", message: "Command stream ended without a confirmed exit status." });
    } catch (error) {
      console.error("Sandbox execution failed", error);
      broadcast(room, { type: "error", message: "Command execution failed in the sandbox." });
    } finally { room.busy = false; broadcast(room, { type: "ready" }); }
  });

  ws.on("close", () => {
    room.clients.delete(ws);
    if (client.owner) {
      broadcast(room, { type: "host_left" });
      rooms.delete(room.id);
      if (room.sandboxId) render.sandboxes.terminate(room.sandboxId).catch(err => console.error("Sandbox cleanup failed", room.sandboxId, err));
    }
  });
});

server.listen(port, () => console.log(`Shared terminal listening on ${port}`));