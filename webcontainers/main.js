import { WebContainer } from '@webcontainer/api';

const $ = (selector) => document.querySelector(selector);
const drawer = $('#drawer');
const shade = $('#shade');
const menuButton = $('#menuButton');
const closeButton = $('#closeDrawer');
const terminal = $('#terminal');
const commandInput = $('#command');
const runButton = $('#runCommand');
const stateText = $('#stateText');
const stateDot = $('#stateDot');
const stopButton = $('#stopContainer');
const preview = $('#preview');
const empty = $('#empty');

let container = null;
let activeProcess = null;
let booting = false;
let serverReady = false;
let firstVisitTimer;

function print(message, kind = '') {
  const line = document.createElement('div');
  if (kind) line.className = kind;
  line.textContent = message;
  terminal.append(line);
  terminal.scrollTop = terminal.scrollHeight;
}
function setState(message, ready = false) {
  stateText.textContent = message;
  stateDot.classList.toggle('ready', ready);
}
function openDrawer() {
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  shade.classList.add('show');
  menuButton.classList.remove('force-visible');
  if (!container && !booting) boot();
  setTimeout(() => commandInput.focus(), 80);
}
function closeDrawer() {
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  shade.classList.remove('show');
  menuButton.classList.remove('force-visible');
}
menuButton.addEventListener('click', openDrawer);
closeButton.addEventListener('click', closeDrawer);
shade.addEventListener('click', closeDrawer);
window.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'j') {
    event.preventDefault();
    drawer.classList.contains('open') ? closeDrawer() : openDrawer();
  }
  if (event.key === 'Escape' && drawer.classList.contains('open')) closeDrawer();
});

async function boot() {
  if (container || booting) return;
  booting = true;
  setState('Starting Node.js runtime…');
  print('Starting the WebContainer runtime…', 'muted');
  try {
    if (!window.isSecureContext) throw new Error('WebContainers require HTTPS or localhost.');
    if (!window.crossOriginIsolated || !window.SharedArrayBuffer) {
      throw new Error('Cross-origin isolation is not active. Reload the page once, then open the terminal again.');
    }
    container = await WebContainer.boot();
    container.on('server-ready', (port, url) => {
      serverReady = true;
      preview.src = url;
      preview.hidden = false;
      empty.hidden = true;
      setState('App running · port ' + port, true);
      print('App detected on port ' + port + '. Showing it on the canvas.', 'muted');
      closeDrawer();
    });
    container.on('error', (error) => print('Runtime error: ' + error.message, 'err'));
    commandInput.disabled = false;
    runButton.disabled = false;
    stopButton.disabled = false;
    setState('Node.js ready', true);
    print('Node.js is ready. Try: node --version, npm --version, or create a Vite app.', 'muted');
    commandInput.focus();
  } catch (error) {
    container = null;
    setState('Could not start');
    print('ERROR: ' + (error?.message || error), 'err');
  } finally {
    booting = false;
  }
}

async function runCommand(command) {
  if (!container || !command.trim()) return;
  if (activeProcess) {
    print('A process is already running. Stop it before starting another command.', 'err');
    return;
  }
  print('$ ' + command, 'cmd');
  runButton.disabled = true;
  commandInput.disabled = true;
  try {
    const process = await container.spawn('jsh', ['-c', command]);
    activeProcess = process;
    const reader = process.output.getReader();
    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          print(value);
        }
      } catch (error) {
        if (!String(error).toLowerCase().includes('cancel')) print('Output: ' + error.message, 'err');
      }
    })();
    process.exit.then((code) => {
      if (activeProcess === process) activeProcess = null;
      runButton.disabled = false;
      commandInput.disabled = false;
      stopButton.disabled = !container;
      if (code !== 0) print('Process exited with code ' + code, 'muted');
      if (!serverReady) commandInput.focus();
    }).catch((error) => {
      if (activeProcess === process) activeProcess = null;
      runButton.disabled = false;
      commandInput.disabled = false;
      print('Process error: ' + error.message, 'err');
    });
  } catch (error) {
    activeProcess = null;
    runButton.disabled = false;
    commandInput.disabled = false;
    print('ERROR: ' + error.message, 'err');
  }
}

$('#commandForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const command = commandInput.value.trim();
  if (!command || !container) return;
  commandInput.value = '';
  runCommand(command);
});
$('#exampleList').addEventListener('click', (event) => {
  const button = event.target.closest('[data-command]');
  if (!button) return;
  commandInput.value = button.dataset.command;
  if (!container) boot().then(() => runCommand(button.dataset.command));
  else runCommand(button.dataset.command);
});
async function stopContainer() {
  if (!container) return;
  if (activeProcess) {
    try { activeProcess.kill(); } catch {}
    activeProcess = null;
  }
  const current = container;
  container = null;
  serverReady = false;
  preview.removeAttribute('src');
  preview.hidden = true;
  empty.hidden = false;
  try { await current.teardown(); } catch (error) { print('Container stopped: ' + error.message, 'muted'); }
  commandInput.value = '';
  commandInput.disabled = true;
  runButton.disabled = true;
  stopButton.disabled = true;
  setState('Runtime stopped');
  print('Container stopped. Open the terminal to start a fresh runtime.', 'muted');
  closeDrawer();
  menuButton.classList.add('force-visible');
}
stopButton.addEventListener('click', stopContainer);

document.querySelectorAll('.example').forEach((button) => {
  button.title = 'Run: ' + button.dataset.command;
});
menuButton.classList.add('force-visible');
firstVisitTimer = window.setTimeout(() => menuButton.classList.remove('force-visible'), 10000);
