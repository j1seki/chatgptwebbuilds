import { WebContainer } from '@webcontainer/api';
import JSZip from 'jszip';

const $ = (selector) => document.querySelector(selector);
const bootButton = $('#boot');
const runButton = $('#run');
const stopButton = $('#stop');
const resetButton = $('#reset');
const exportButton = $('#export');
const templateSelect = $('#template');
const statusNode = $('#status');
const led = $('#led');
const terminal = $('#terminal');
const commandInput = $('#command');
const sendButton = $('#send');
const editor = $('#editor');
const editorTitle = $('#editor-title');
const previewFrame = $('#preview-frame');
const previewEmpty = $('#preview-empty');
const fileTree = $('#file-tree');
const saveState = $('#save-state');
const STORAGE_KEY = 'chatgpt-webbuilds-project-v2';

const templates = {
  express: {
    entry: 'server.js',
    files: {
      'package.json': JSON.stringify({ name: 'hello-webcontainer', private: true, version: '1.0.0', type: 'module', scripts: { dev: 'node server.js' }, dependencies: { express: '^4.21.2' } }, null, 2),
      'server.js': "import express from 'express';\n\nconst app = express();\nconst port = 3000;\napp.use(express.static('public'));\napp.get('/api/hello', (_req, res) => res.json({ message: 'Hello from a real Node.js server!' }));\napp.listen(port, () => console.log('Server listening on port ' + port));\n",
      'public/index.html': '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Express WebContainer</title><style>body{font:16px system-ui;max-width:680px;margin:12vh auto;padding:24px;color:#18243a}code{background:#edf2fa;padding:4px 7px;border-radius:5px}</style></head><body><h1>Hello from Node.js!</h1><p>This page is served by Express running inside your browser.</p><p>Try the API: <code>/api/hello</code></p><button id="check">Call the API</button><pre id="result">Click to make a request.</pre><script>document.querySelector("#check").addEventListener("click",async()=>{const r=await fetch("/api/hello");document.querySelector("#result").textContent=JSON.stringify(await r.json(),null,2)});</script></body></html>'
    }
  },
  vite: {
    entry: 'server.js',
    files: {
      'package.json': JSON.stringify({ name: 'vite-webcontainer-starter', private: true, version: '1.0.0', type: 'module', scripts: { dev: 'vite --host 0.0.0.0' }, dependencies: { vite: '^6.0.0' } }, null, 2),
      'index.html': '<!doctype html>\n<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vite Starter</title></head><body><main><h1>Edit me ⚡</h1><p>Your Vite app is running in a browser WebContainer.</p><button id="hello">Click me</button><p id="output"></p></main><script type="module" src="/src.js"></script></body></html>',
      'src.js': "document.querySelector('#hello').addEventListener('click', () => {\n  document.querySelector('#output').textContent = 'Your changes are live!';\n});\n",
      'server.js': '// Vite serves this project using the npm dev script.\n'
    }
  },
  cli: {
    entry: 'index.js',
    files: {
      'package.json': JSON.stringify({ name: 'node-cli-starter', private: true, version: '1.0.0', type: 'module', scripts: { dev: 'node index.js' } }, null, 2),
      'index.js': "const name = process.argv[2] ?? 'developer';\nconsole.log('Hello, ' + name + '!');\nconsole.log('Node.js version:', process.version);\nconsole.log('Try: npm run dev -- Ada');\n"
    }
  }
};

let webcontainer;
let serverProcess;
let activeFile = '';
let files = {};
let commandBusy = false;
let selectedTemplate = 'express';

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
  exportButton.disabled = !ready;
  commandInput.disabled = !ready;
  sendButton.disabled = !ready;
  editor.disabled = !ready;
}
function persistProject() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ template: selectedTemplate, files }));
    saveState.textContent = 'Saved locally in this browser.';
  } catch {
    saveState.textContent = 'Could not save locally (browser storage may be full or disabled).';
  }
}
function renderTree() {
  fileTree.replaceChildren();
  Object.keys(files).sort().forEach((path) => {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = 'file' + (path === activeFile ? ' active' : '');
    node.textContent = '▤　' + path;
    node.dataset.file = path;
    node.addEventListener('click', () => selectFile(path));
    fileTree.append(node);
  });
}
function writeEditor() {
  editor.value = files[activeFile] ?? '';
  editorTitle.textContent = activeFile || 'Select a file';
  renderTree();
}
function saveActiveFile() {
  if (!activeFile) return;
  files[activeFile] = editor.value;
  persistProject();
}
async function selectFile(path) {
  saveActiveFile();
  activeFile = path;
  if (webcontainer) await webcontainer.fs.writeFile(path, files[path]);
  writeEditor();
}
function directoryTree(sourceFiles) {
  const root = {};
  for (const [path, contents] of Object.entries(sourceFiles)) {
    const parts = path.split('/');
    let cursor = root;
    for (const part of parts.slice(0, -1)) {
      cursor[part] ??= { directory: {} };
      cursor = cursor[part].directory;
    }
    cursor[parts.at(-1)] = { file: { contents } };
  }
  return root;
}
async function mountFiles() {
  await webcontainer.mount(directoryTree(files));
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
async function stopServerProcess() {
  const current = serverProcess;
  if (!current) return;
  current.kill();
  await current.exit;
  if (serverProcess === current) serverProcess = null;
  setControls(Boolean(webcontainer));
}
async function startProject() {
  if (!webcontainer || serverProcess) return;
  setStatus('Running project…');
  const script = selectedTemplate === 'cli' ? 'dev' : 'dev';
  print('$ npm run ' + script, 'cmd');
  try {
    serverProcess = await webcontainer.spawn('npm', ['run', script]);
  } catch (error) {
    serverProcess = null;
    print('Could not run project: ' + error.message, 'err');
    setStatus('Run failed');
    setControls(true);
    return;
  }
  const current = serverProcess;
  pipeOutput(current);
  setControls(true);
  const exitCode = await current.exit;
  if (serverProcess !== current) return;
  serverProcess = null;
  setControls(true);
  stopButton.disabled = true;
  if (selectedTemplate === 'cli') {
    setStatus('CLI finished · exit ' + exitCode, exitCode === 0);
    print('CLI process finished. Run it again or try a command below.', 'muted');
  } else {
    setStatus('Server stopped · exit ' + exitCode);
    previewFrame.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = 'The development server stopped. Run the project again to restore the preview.';
  }
}
async function boot() {
  if (webcontainer) return;
  bootButton.disabled = true;
  setStatus('Booting WebContainer…');
  print('Booting the in-browser Node.js runtime…', 'muted');
  try {
    if (!window.isSecureContext) throw new Error('WebContainers require HTTPS or localhost.');
    if (!window.crossOriginIsolated || !window.SharedArrayBuffer) {
      throw new Error('Cross-origin isolation is not active. Allow the service worker to reload this page, then try again.');
    }
    const coep = window.sessionStorage.getItem('coiCoepHasFailed') === 'true' ? 'require-corp' : 'credentialless';
    webcontainer = await WebContainer.boot({ coep });
    webcontainer.on('server-ready', (port, url) => {
      if (selectedTemplate === 'cli') return;
      previewFrame.src = url;
      previewFrame.hidden = false;
      previewEmpty.hidden = true;
      setStatus('Node.js running · port ' + port, true);
      print('Preview available at ' + url, 'muted');
    });
    await mountFiles();
    setControls(true);
    print('Runtime ready. Installing project dependencies…', 'muted');
    const install = await webcontainer.spawn('npm', ['install']);
    await pipeOutput(install);
    const code = await install.exit;
    if (code !== 0) throw new Error('npm install failed with exit code ' + code);
    print('Dependencies installed.', 'muted');
    await startProject();
  } catch (error) {
    print('ERROR: ' + (error?.message || error), 'err');
    setStatus('Could not start');
    bootButton.disabled = false;
    setControls(Boolean(webcontainer));
  }
}
function tokenizeCommand(command) {
  return (command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []).map((part) =>
    (part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'")) ? part.slice(1, -1) : part
  );
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
async function saveFilesToRuntime() {
  saveActiveFile();
  for (const [path, contents] of Object.entries(files)) {
    await webcontainer.fs.writeFile(path, contents);
  }
}
async function restartProject() {
  if (!webcontainer) return;
  await saveFilesToRuntime();
  await stopServerProcess();
  if (selectedTemplate !== 'cli') {
    previewFrame.hidden = true;
    previewEmpty.hidden = false;
    previewEmpty.textContent = 'Restarting the development server…';
  }
  await startProject();
}
async function changeTemplate(name) {
  if (!templates[name]) return;
  saveActiveFile();
  await stopServerProcess();
  selectedTemplate = name;
  files = { ...templates[name].files };
  activeFile = Object.keys(files).find((path) => path === templates[name].entry) || Object.keys(files)[0];
  templateSelect.value = name;
  persistProject();
  writeEditor();
  previewFrame.hidden = true;
  previewEmpty.hidden = false;
  previewEmpty.textContent = name === 'cli' ? 'This starter is a command-line app. Run it and inspect output in the terminal.' : 'Start the project to see its live preview.';
  if (webcontainer) {
    await mountFiles();
    print('Switched to ' + name + ' starter. Installing its dependencies…', 'muted');
    const install = await webcontainer.spawn('npm', ['install']);
    await pipeOutput(install);
    const code = await install.exit;
    if (code !== 0) {
      print('npm install failed with exit code ' + code, 'err');
      return;
    }
    await startProject();
  }
}
async function exportProject() {
  saveActiveFile();
  persistProject();
  const zip = new JSZip();
  for (const [path, contents] of Object.entries(files)) zip.file(path, contents);
  if (webcontainer) {
    try {
      const lock = await webcontainer.fs.readFile('package-lock.json', 'utf8');
      zip.file('package-lock.json', lock);
    } catch { /* The project may not have an npm lockfile yet. */ }
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = selectedTemplate + '-webcontainer-project.zip';
  anchor.click();
  URL.revokeObjectURL(url);
  print('Exported project ZIP.', 'muted');
}
function loadProject() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && templates[saved.template] && saved.files && typeof saved.files === 'object') {
      selectedTemplate = saved.template;
      files = Object.fromEntries(Object.entries(saved.files).filter(([path, value]) => typeof path === 'string' && typeof value === 'string'));
    }
  } catch { /* Ignore malformed or unavailable local storage and use a clean starter. */ }
  if (!Object.keys(files).length) files = { ...templates[selectedTemplate].files };
  activeFile = Object.keys(files).includes(templates[selectedTemplate].entry) ? templates[selectedTemplate].entry : Object.keys(files)[0];
  templateSelect.value = selectedTemplate;
  writeEditor();
}

bootButton.addEventListener('click', boot);
runButton.addEventListener('click', restartProject);
stopButton.addEventListener('click', () => { if (serverProcess) serverProcess.kill(); });
resetButton.addEventListener('click', async () => {
  if (!confirm('Reset this project to the selected starter template? Your saved edits will be replaced.')) return;
  await changeTemplate(selectedTemplate);
  print('Starter project restored.', 'muted');
});
exportButton.addEventListener('click', exportProject);
templateSelect.addEventListener('change', () => changeTemplate(templateSelect.value));
$('#command-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const command = commandInput.value.trim();
  if (!command) return;
  commandInput.value = '';
  if (command === 'clear') terminal.replaceChildren();
  else await runCommand(command);
});
editor.addEventListener('input', () => {
  files[activeFile] = editor.value;
  persistProject();
});
editor.addEventListener('keydown', (event) => {
  if (event.key === 'Tab') {
    event.preventDefault();
    editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
  }
});
loadProject();
