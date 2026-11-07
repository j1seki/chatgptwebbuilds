import { WebContainer } from "@webcontainer/api";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const $ = id => document.getElementById(id);
const apiBase = (import.meta.env.VITE_API_URL || window.location.origin).replace(/\/$/, "");
const terminal = new Terminal({
  cursorBlink: true,
  convertEol: true,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 13,
  theme: { background: "#080d18", foreground: "#dce7f5", cursor: "#a8d78b", green: "#a8d78b" }
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open($("terminal"));
fitAddon.fit();

let webcontainer = null;
let shell = null;
let shellInput = null;
let socket = null;
let roomId = "";
let ownerToken = "";
let role = "";
let clientId = "";
let approved = false;
const guests = new Map();

function status(text) { $("status").textContent = text; }
function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}
function showSession() {
  $("lobby").classList.add("hidden");
  $("session").classList.remove("hidden");
  $("room-code").textContent = roomId;
  $("role").textContent = role === "host" ? "HOST" : "GUEST";
}
function terminalMessage(text) {
  terminal.writeln("\r\n\x1b[90m" + text.replace(/[\r\n]/g, " ") + "\x1b[0m");
}
function renderGuests() {
  const panel = $("approval-panel");
  const list = $("requests");
  list.replaceChildren();
  for (const [id, guest] of guests) {
    const row = document.createElement("div");
    row.className = "guest-row";
    const label = document.createElement("span");
    label.textContent = guest.approved ? "Guest connected · access allowed" : "Guest requesting access";
    const button = document.createElement("button");
    button.className = guest.approved ? "secondary small" : "primary small";
    button.textContent = guest.approved ? "Revoke" : "Approve";
    button.onclick = () => {
      send({ type: guest.approved ? "revoke" : "approve", clientId: id });
      guest.approved = !guest.approved;
      renderGuests();
    };
    row.append(label, button);
    list.append(row);
  }
  panel.classList.toggle("hidden", role !== "host" || guests.size === 0);
}
async function bootRuntime() {
  if (webcontainer) return;
  if (!window.isSecureContext) throw new Error("This runtime requires HTTPS or localhost.");
  if (!window.crossOriginIsolated || !window.SharedArrayBuffer) {
    throw new Error("Browser isolation is not enabled. Reload the page and try again in Chrome or Edge.");
  }
  status("Starting browser runtime…");
  webcontainer = await WebContainer.boot();
}
async function startShell() {
  if (shell) return;
  shell = await webcontainer.spawn("jsh", {
    terminal: { cols: terminal.cols || 80, rows: terminal.rows || 24 }
  });
  shellInput = shell.input.getWriter();
  shell.output.pipeTo(new WritableStream({
    write(data) { send({ type: "output", data }); }
  })).catch(error => terminalMessage("Shell output stopped: " + error.message));
  send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
  terminalMessage("Browser Node.js shell ready. Type commands below.");
}
function connect(id, hostToken = "") {
  roomId = id.toUpperCase();
  ownerToken = hostToken;
  role = hostToken ? "host" : "guest";
  const endpoint = new URL(apiBase);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  endpoint.pathname = "/ws";
  endpoint.search = "?room=" + encodeURIComponent(roomId);
  socket = new WebSocket(endpoint);
  socket.addEventListener("open", () => {
    if (role === "host") send({ type: "host_auth", token: ownerToken });
    status("Connected");
  });
  socket.addEventListener("close", () => {
    status("Disconnected");
    $("access-state").textContent = "Disconnected";
  });
  socket.addEventListener("error", () => status("Connection error"));
  socket.addEventListener("message", async event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "connected") {
      clientId = message.clientId;
      showSession();
      terminalMessage("Connected to room " + roomId + ".");
      $("access-state").textContent = role === "host" ? "Host runtime" : "Waiting for approval";
      if (role === "guest") terminalMessage("The host must approve your access before you can type.");
    } else if (message.type === "host_ready") {
      approved = true;
      $("access-state").textContent = "Host runtime ready";
      await startShell();
      terminal.focus();
    } else if (message.type === "guest_request") {
      guests.set(message.clientId, { approved: false });
      renderGuests();
    } else if (message.type === "guest_approved") {
      const guest = guests.get(message.clientId);
      if (guest) guest.approved = true;
      renderGuests();
    } else if (message.type === "approved") {
      approved = true;
      $("access-state").textContent = "Access approved";
      terminalMessage("Host approved your access.");
      terminal.focus();
    } else if (message.type === "revoked") {
      approved = false;
      $("access-state").textContent = "Access revoked";
      terminalMessage("Host revoked your access.");
    } else if (message.type === "host_online") {
      $("access-state").textContent = "Host online";
    } else if (message.type === "host_offline") {
      $("access-state").textContent = "Host offline";
      terminalMessage("Host browser disconnected. The room will be unavailable until the host reconnects.");
    } else if (message.type === "waiting") {
      $("access-state").textContent = "Waiting for host";
    } else if (message.type === "input" && role === "host") {
      if (shellInput) await shellInput.write(message.data);
    } else if (message.type === "resize" && role === "host") {
      shell?.resize({ cols: message.cols, rows: message.rows });
    } else if (message.type === "output") {
      terminal.write(message.data);
    } else if (message.type === "error") {
      terminalMessage("Error: " + message.message);
    }
  });
}
terminal.onData(data => {
  if (approved) send({ type: "input", data });
});
terminal.onResize(({ cols, rows }) => {
  if (approved) send({ type: "resize", cols, rows });
});
window.addEventListener("resize", () => fitAddon.fit());

$("create").onclick = async () => {
  const button = $("create");
  button.disabled = true;
  try {
    await bootRuntime();
    status("Creating room…");
    const response = await fetch(apiBase + "/api/rooms", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create a room.");
    sessionStorage.setItem("shared-terminal-owner-" + data.roomId, data.ownerToken);
    history.replaceState({}, "", "?room=" + data.roomId + "&host=1");
    connect(data.roomId, data.ownerToken);
  } catch (error) {
    alert(error.message);
    status("Not connected");
    button.disabled = false;
  }
};
$("join").onclick = () => {
  const id = $("room-input").value.trim() || new URLSearchParams(location.search).get("room");
  if (!id) return alert("Enter a room code or open an invite link.");
  history.replaceState({}, "", "?room=" + id.toUpperCase());
  connect(id);
};
$("copy").onclick = async () => {
  await navigator.clipboard.writeText(location.origin + "/?room=" + roomId);
  $("copy").textContent = "Copied";
};
$("leave").onclick = () => {
  socket?.close();
  location.href = location.origin;
};

const params = new URLSearchParams(location.search);
const initialRoom = params.get("room");
if (initialRoom) {
  const host = params.get("host") === "1";
  const savedToken = host ? sessionStorage.getItem("shared-terminal-owner-" + initialRoom.toUpperCase()) || "" : "";
  if (host && savedToken) {
    bootRuntime().then(() => connect(initialRoom, savedToken)).catch(error => {
      terminalMessage(error.message);
      status("Runtime unavailable");
    });
  } else {
    connect(initialRoom);
  }
}
