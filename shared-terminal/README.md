# Shared Terminal

A two-person shared terminal where both participants only open a website. There is no local agent, Docker installation, browser extension, or Render Sandbox.

## How it works

- The host opens the website and creates a room.
- The host's browser starts a StackBlitz WebContainer, which runs a Node.js shell inside the browser.
- The host shares the room link with a guest.
- The host approves the guest.
- Terminal keystrokes and output are relayed through the small Render API WebSocket service.
- The host browser executes the shell; Render does not execute user commands.

The host must keep the browser tab open. If the host closes the tab or loses connectivity, the shared shell stops being available.

## Important runtime boundary

This is a browser-hosted Node.js environment, not the host computer's native terminal and not a general-purpose Linux VM. It cannot access arbitrary files, applications, or operating-system processes on the host computer. It is intended for Node.js tooling and projects supported by WebContainers.

WebContainers require HTTPS, cross-origin isolation (COOP/COEP headers), and a supported desktop browser. Current practical target: Chrome or Edge. Other browsers may have limitations. See [WebContainers browser support](https://webcontainers.io/guides/browser-support).

## Deploy on Render

Deploy the Blueprint at `shared-terminal/render.yaml`.

The Blueprint creates:
- A free Render web service for room creation and WebSocket signaling.
- A free Render static site for the browser application.

Set `FRONTEND_ORIGIN` and `VITE_API_URL` to the actual Render service URLs if Render assigns different names. The static site sets the required COOP/COEP headers for WebContainers.

No Render Sandbox, Render API key, execution worker, or payment method for sandbox execution is required. Free Render services have sleep and usage limits; room state is held in API memory and is lost when the API restarts.

## Local development

Install Node.js 20 or newer, then:

```sh
cd shared-terminal
npm install
```

Run the signaling API:

```sh
npm start
```

In another terminal, run the static app with the API URL:

```sh
VITE_API_URL=http://localhost:3001 npm run build
npm run dev
```

For local WebContainer use, serve the app over HTTPS or localhost and configure the dev server with:

- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

## Security and limitations

- A room code is a discovery identifier, not a password. Only share it with intended participants.
- The host token is kept in the host tab's session storage and is not included in the invite link.
- Approved guests can type commands into the shared WebContainer shell. Treat approval like granting shell access to that browser-based project environment.
- Do not enter secrets or sensitive data into a shared room.
- Room state is in memory. A Render API restart clears rooms.
- Free Render services may sleep when idle, so the first request can take time to wake the API.
- This is an MVP, not a hardened multi-tenant terminal service.
