import { WebContainer } from '@webcontainer/api';

const $ = (selector) => document.querySelector(selector);
const bootButton = $('#boot');
const runButton = $('#run');
const stopButton = $('#stop');
const resetButton = $('#reset');
const statusNode = $('#status');
const led = $('#led');
const terminal = $('#terminal');
const commandInput = $('#command');
const sendButton = $('#send');
const editor = $('#editor');
const editorTitle = $('#editor-title');
const previewFrame = $('#preview-frame');
const previewEmpty = $('#preview-empty');

const starterFiles = {
  'package.json': JSON.stringify({
    name: 'hello-webcontainer',
    private: true,
    version: '1.0.0',
    type: 'module',
    scripts: { dev: 'node server.js' },
    dependencies: { express: '^4.21.2' }
  }, null, 2),
  'server.js': "import express from 'express';\n\nconst app = express();\nconst port = 3000;\n\napp.use(express.static('public'));\napp.get('/api/hello', (_req, res) => {\n  res.json({ message: 'Hello from a real Node.js server!' });\n});\n\napp.listen(port, () => {\n  console.log('Server listening on http://localhost:' + port);\n});\n",
  'public/index.html': '<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>Hello from Node.js</title>\n  <style>body{font:16px system-ui;max-width:680px;margin:12vh auto;padding:24px;color:#18243a}code{background:#edf2fa;padding:4px 7px;border-radius:5px}</style>\n</head>\n<body>\n  <h1>Hello from Node.js!</h1>\n  <p>This page is being served by an Express server running inside your browser.</p>\n  <p>Try the API: <code>/api/hello</code></p>\n  <button id="check">Call the API</button>\n  <pre id="result">Click the button to make a request.</pre>\n  <script>document.querySelector("#check").addEventListener("click",async()=>{const response=await fetch("/api/hello");document.querySelector("#result").textContent=JSON.stringify(await response.json(),null,2)});</script>\n</body>\n</html>'
};

let webcontainer;
let serverProcess;
let serverReady = false;
let activeFile = 'server.js';
let files = { ...starterFiles };
let commandBusy = false;

function print(text, kind = '') {
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = text;
  terminal.append(line);
  terminal.scrollTop = terminal.scrollHeight;
}
function setStatus(text, ready = false) {
  statusNode.textContent = text;
  led.classList.toggle('ready', ready);
}
function setControls(ready) {
  runButton.disabled = !ready;
  stopButton.disabled = !ready || !serverProcess;
  resetButton.disabled = !ready;
  commandInput.disabled = !ready;
  sendButton.disabled = !ready;
  editor.disabled = !ready;
}
function writeEditor() {
  editor.value = files[activeFile] || '';
  editorTitle.textContent = activeFile;
  document.querySelectorAll('[data-file]').forEach((node) => {
    node.classList.toggle('active', node.dataset.file === activeFile);
  });
}
async function mountFiles() {
  await webcontainer.mount({
    'package.json': { file: { contents: files['package.json'] } },
    'server.js': { file: { contents: files['server.js'] } },
    public: {
      directory: {
        'index.html': { file: { contents: files['public/index.html'] } }
      }
    }
  });
}
async function pipeOutput(process, kind = '') {
  const reader = process.output.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      print(value, kind);
    }
  } catch (error) {
    if (!String(error).includes('cancel')) print('Output stream: ' + error.message, 'err');
  }
}
async function startServer() {
  if (!webcontainer || serverProcess) return;
  serverReady = false;
  setStatus('Starting Express…');
  print('$ npm run dev', 'cmd');
  try {
    serverProcess = await webcontainer.spawn('npm', ['run', 'dev']);
  } catch (error) {
    print('Unable to start server: ' + error.message, 'err');
    setStatus('Server failed to start');
    return;
  }
  pipeOutput(serverProcess);
  stopButton.disabled = false;
  const currentProcess = serverProcess;
  const exitCode = await currentProcess.exit;
  if (serverProcess !== currentProcess) return;
  serverProcess = null;
  serverReady = false;
  previewFrame.hidden = true;
  previewEmpty.hidden = false;
  previewEmpty.textContent = 'The server stopped (exit code ' + exitCode + '). Start it again from the terminal.';
  setControls(true);
  stopButton.disabled = true;
  setStatus('Server stopped');
}
async function saveFiles() {
  files[activeFile] = editor.value;
  await webcontainer.fs.writeFile(activeFile, editor.value);
}
async function boot() {
  if (webcontainer) return;
  bootButton.disabled = true;
  setStatus('Booting WebContainer…');
  print('Booting the in-browser Node.js runtime…', 'muted');
  try {
    if (!window.isSecureContext) throw new Error('WebContainers require HTTPS or localhost.');
    if (!window.crossOriginIsolated || !window.SharedArrayBuffer) {
      throw new Error('Cross-origin isolation is not active yet. Allow the service worker to reload this page, then try again. Check that third-party extensions are not blocking service workers.');
    }
    const coep = window.sessionStorage.getItem('coiCoepHasFailed') === 'true' ? 'require-corp' : 'credentialless';
    webcontainer = await WebContainer.boot({ coep });
    webcontainer.on('server-ready', (port, url) => {
      if (port !== 3000) return;
      serverReady = true;
      previewFrame.src = url;
      previewFrame.hidden = false;
      previewEmpty.hidden = true;
      setStatus('Node.js running · port ' + port, true);
      print('Preview available at ' + url, 'muted');
    });
    await mountFiles();
    setControls(true);
    print('Runtime ready. Installing the starter project…', 'muted');
    const install = await webcontainer.spawn('npm', ['install']);
    await pipeOutput(install);
    const installCode = await install.exit;
    if (installCode !== 0) throw new Error('npm install failed with exit code ' + installCode);
    print('Dependencies installed. Starting the Express server…', 'muted');
    startServer();
  } catch (error) {
    print('ERROR: ' + (error?.message || error), 'err');
    setStatus('Could not start');
    bootButton.disabled = false;
    setControls(Boolean(webcontainer));
  }
}
function tokenizeCommand(command) {
  const matches = command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  return matches.map((part) => {
    if (part.startsWith('"') && part.endsWith('"')) return part.slice(1, -1);
    if (part.startsWith("'") && part.endsWith("'")) return part.slice(1, -1);
    return part;
  });
}
async function runCommand(command) {
  if (!webcontainer || commandBusy || !command.trim()) return;
  commandBusy = true;
  sendButton.disabled = true;
  print('$ ' + command, 'cmd');
  try {
    const [binary, ...args] = tokenizeCommand(command);
    if (!binary) return;
    const process = await webcontainer.spawn(binary, args);
    await pipeOutput(process);
    const code = await process.exit;
    if (code !== 0) print('Process exited with code ' + code, 'muted');
  } catch (error) {
    print('ERROR: ' + error.message, 'err');
  } finally {
    commandBusy = false;
    sendButton.disabled = false;
    commandInput.focus();
  }
}
async function stopServerProcess() {
  const currentProcess = serverProcess;
  if (!currentProcess) return;
  currentProcess.kill();
  await currentProcess.exit;
  if (serverProcess === currentProcess) serverProcess = null;
}
async function restartServer() {
  if (!webcontainer) return;
  await saveFiles();
  await stopServerProcess();
  startServer();
}
bootButton.addEventListener('click', boot);
runButton.addEventListener('click', restartServer);
stopButton.addEventListener('click', () => {
  if (serverProcess) serverProcess.kill();
});
resetButton.addEventListener('click', async () => {
  if (!webcontainer) return;
  await stopServerProcess();
  files = { ...starterFiles };
  await mountFiles();
  writeEditor();
  print('Project files restored to the starter version.', 'muted');
  startServer();
});
document.querySelectorAll('[data-file]').forEach((node) => {
  node.addEventListener('click', async () => {
    if (webcontainer) await saveFiles();
    activeFile = node.dataset.file;
    writeEditor();
  });
});
$('#command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const command = commandInput.value.trim();
  if (!command) return;
  commandInput.value = '';
  if (command === 'clear') {
    terminal.replaceChildren();
    return;
  }
  await runCommand(command);
});
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.setRangeText('  ', start, end, 'end');
  }
});
writeEditor();
