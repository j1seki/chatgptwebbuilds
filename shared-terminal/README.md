# Shared Terminal

Browser-only shared command workspace. The host creates a cloud sandbox and shares a room link. Guests request access; only the host can approve them.

## Deploy

Use Render Blueprint path `shared-terminal/render.yaml`. Set `RENDER_API_KEY` on the web service. Render Sandboxes must be enabled for the workspace. The backend serves the static UI and WebSocket API from one service for this first deployment.

## Known MVP limitation

Render's Sandbox SDK currently exposes streamed one-shot command execution rather than a persistent interactive PTY. Each command runs in a fresh shell. Interactive terminal applications, persistent shell state, terminal resize, stdin streaming, and interrupting a running command are not supported by this MVP. A PTY-capable execution host/transport is required for a true shared terminal.

Rooms are stored in process memory and are lost on service restart. Use persistent storage, rate limiting, room expiry, audit logs, and a durable session coordinator before public production use. The host's disconnect ends the sandbox. Sandboxes are configured with deny-all outbound networking by default.
