import crypto from "node:crypto";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const endpoint = process.env.RUNNER_WS_URL;
const token = process.env.RUNNER_TOKEN;
const image = process.env.RUNNER_IMAGE || "node:22-bookworm-slim";
const prefix = "shared-terminal-";
const containers = new Map();

if (!endpoint || !token) {
  console.error("Set RUNNER_WS_URL and RUNNER_TOKEN before starting the worker.");
  process.exit(1);
}

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function docker(args, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `docker exited with code ${code}`));
    });
  });
}

async function removeOrphans() {
  const ids = await docker(["ps", "-aq", "--filter", `name=^/${prefix}`]).catch(() => "");
  if (ids) await docker(["rm", "-f", ...ids.split(/\s+/)]).catch(() => {});
}

async function createRoom(ws, roomId) {
  const name = prefix + roomId.toLowerCase();
  try {
    await docker([
      "run", "-d", "--rm", "--name", name,
      "--network", "none",
      "--memory", "512m", "--cpus", "1", "--pids-limit", "128",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--user", "node", "--workdir", "/home/node",
      image, "sleep", "infinity"
    ]);
    containers.set(roomId, name);
    send(ws, { type: "room_created", roomId });
  } catch (error) {
    send(ws, { type: "room_error", roomId, message: error.message.slice(0, 500) });
  }
}

async function execute(ws, roomId, command, requestId) {
  const name = containers.get(roomId);
  if (!name) return send(ws, { type: "exec_error", roomId, requestId, message: "Room container is unavailable." });
  const child = spawn("docker", ["exec", "-i", name, "sh", "-lc", command], { stdio: ["ignore", "pipe", "pipe"] });
  const timeout = setTimeout(() => child.kill("SIGKILL"), 120000);
  for (const [stream, source] of [["stdout", child.stdout], ["stderr", child.stderr]]) {
    source.on("data", chunk => send(ws, { type: "output", roomId, requestId, stream, data: chunk.toString("utf8") }));
  }
  child.on("error", error => {
    clearTimeout(timeout);
    send(ws, { type: "exec_error", roomId, requestId, message: error.message });
  });
  child.on("close", code => {
    clearTimeout(timeout);
    send(ws, { type: "exit", roomId, requestId, code: code ?? 1 });
  });
}

async function main() {
  await removeOrphans();
  const ws = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } });
  ws.on("open", () => console.log("Shared Terminal runner connected."));
  ws.on("message", raw => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return; }
    if (message.type === "create") void createRoom(ws, message.roomId);
    if (message.type === "exec") void execute(ws, message.roomId, message.command, message.requestId);
    if (message.type === "destroy") {
      const name = containers.get(message.roomId);
      containers.delete(message.roomId);
      if (name) void docker(["rm", "-f", name]).catch(error => console.error("Container cleanup failed:", error.message));
    }
  });
  ws.on("close", () => { console.error("Runner connection closed; reconnecting in 3 seconds."); setTimeout(main, 3000); });
  ws.on("error", error => console.error("Runner websocket error:", error.message));
}

main().catch(error => { console.error(error); process.exit(1); });
