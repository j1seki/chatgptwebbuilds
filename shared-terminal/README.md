# Shared Terminal

A browser-based shared command workspace. The website and signaling API run on Render's free services. Actual command execution runs on a machine you control (for example, your always-on Linux host) through a small outbound-connected worker. No Render Sandbox, paid sandbox provider, or inbound port forwarding is required.

## Render deployment

Deploy with Blueprint path `shared-terminal/render.yaml`. On the API service, set `RUNNER_TOKEN` to a long random secret. Generate one with:

```sh
openssl rand -hex 32
```

Keep the same value private and configure it on the execution host. Do not commit it or paste it into chat.

## Self-hosted execution worker

Requirements on the execution host:
- Linux or macOS with Docker Engine/Desktop running.
- Node.js 20 or newer.
- Outbound HTTPS/WSS access to the Render API.

On the execution host, clone this repository and run:

```sh
cd shared-terminal
npm install
export RUNNER_WS_URL="wss://YOUR-API-HOST.onrender.com/worker"
export RUNNER_TOKEN="THE_SAME_RANDOM_SECRET_SET_ON_RENDER"
npm run worker
```

Replace `YOUR-API-HOST` with the deployed API hostname. Keep the worker running; it reconnects automatically. The first start removes leftover containers with the `shared-terminal-` prefix. Each room gets a separate `node:22-bookworm-slim` container, capped at 768 MB RAM, 1 CPU, and 128 processes. Containers run as the unprivileged `node` user. The Docker bridge network permits package downloads and other outbound internet access. Room containers are removed when the host leaves.

## Current limitations

- Commands are streamed one at a time and each command starts a new shell process. Files persist within the room container, but shell state such as `cd` does not persist between commands.
- No interactive PTY yet: editors, REPLs, stdin prompts, resize, and interrupt are not supported.
- Rooms are in API process memory and disappear if the free Render service restarts. Render free services may sleep while idle.
- The worker host must remain online. If it disconnects, new rooms cannot be created.
- This is an experiment, not a hardened multi-tenant service. Approved guests can run arbitrary commands in their room. Docker is a useful isolation boundary but not a substitute for a hardened VM sandbox. Do not expose it to strangers or use it for sensitive data.

## Cost

The app does not use Render Sandboxes or any paid execution API. Render's free-service limits still apply, and the execution host uses your own machine and electricity/network connection.
