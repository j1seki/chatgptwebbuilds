# Shared Terminal

Browser-only shared command workspace. The host creates a cloud sandbox and shares a room link. Guests request access; only the host can approve them.

## Deploy

Use Render Blueprint path `shared-terminal/render.yaml`. Set `RENDER_API_KEY` on the API service. The workspace ID is wired as a non-secret setting. Render Sandboxes must be enabled for the workspace.

## Known MVP limitation

Render's Sandboxes SDK currently exposes streamed one-shot command execution rather than a persistent interactive PTY. Each command runs in a fresh shell. Interactive editors/REPLs, persistent shell state between commands, stdin streaming, terminal resize, and interrupting a running command are not supported. A PTY-capable execution host/transport is required for the full original experience.

Rooms are stored in process memory and are lost on service restart. Use persistent storage, rate limiting, room expiry, audit logs, and durable session coordination before public production use. Sandboxes are configured with deny-all outbound networking by default.
