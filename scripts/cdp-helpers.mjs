import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);
const IS_WIN = process.platform === 'win32';

export function getDevToolsPorts() {
  const candidatePaths = [
    join(os.homedir(), '.config', 'Antigravity', 'DevToolsActivePort'),
    ...(process.env.APPDATA ? [join(process.env.APPDATA, 'Antigravity', 'DevToolsActivePort')] : []),
    join(os.homedir(), 'AppData', 'Roaming', 'Antigravity', 'DevToolsActivePort'),
    join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort'),
  ];
  const ports = [];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const port = parseInt(fs.readFileSync(p, 'utf8').split('\n')[0].trim(), 10);
        if (!isNaN(port) && port > 0 && !ports.includes(port)) {
          ports.push(port);
        }
      }
    } catch { /* ignore */ }
  }
  return ports;
}

export function pickPageTarget(targets) {
  if (!Array.isArray(targets)) return null;
  return (
    targets.find(
      (t) =>
        t.type === 'page' &&
        t.webSocketDebuggerUrl &&
        (t.url?.startsWith('https://127.0.0.1') || t.url?.startsWith('http://127.0.0.1'))
    ) ||
    targets.find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url?.startsWith('data:')
    ) ||
    null
  );
}

export async function isLanguageServerRunning() {
  if (IS_WIN) {
    const psCmd =
      'Get-Process -Name "language_server*" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      timeout: 3000,
    });
    return Boolean(stdout.trim());
  }
  const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], { timeout: 3000 });
  return stdout.toLowerCase().includes('language_server');
}

export async function findCsrfToken() {
  let raw = '';
  if (IS_WIN) {
    const psCmd =
      'Get-CimInstance Win32_Process -Filter "Name like \'language_server%\'" | Select-Object -ExpandProperty CommandLine';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psCmd], {
      timeout: 5000,
    });
    raw = stdout;
  } else {
    const { stdout } = await execFileAsync('ps', ['-ax', '-o', 'pid=,command='], { timeout: 5000 });
    raw = stdout.split('\n').find((l) => l.toLowerCase().includes('language_server')) || '';
  }
  if (!raw) throw new Error('Language server process not found');
  const m = raw.match(/--csrf_token\s+([^\s,"]+)/);
  if (!m) throw new Error('CSRF token not found');
  return m[1];
}

async function probePortForPage(port, timeoutMs = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const page = pickPageTarget(await res.json());
    return page ? { port, pageTarget: page } : null;
  } catch {
    return null;
  }
}

export async function findCdpTarget() {
  for (const port of getDevToolsPorts()) {
    const hit = await probePortForPage(port, 800);
    if (hit) return hit;
  }

  if (IS_WIN) {
    const portCmd =
      'Get-NetTCPConnection -State Listen | Where-Object LocalAddress -eq "127.0.0.1" | Select-Object -ExpandProperty LocalPort';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', portCmd], {
      timeout: 5000,
    });
    const ports = stdout
      .split(/\r?\n/)
      .map((p) => parseInt(p.trim(), 10))
      .filter((p) => !isNaN(p) && p > 1024);
    for (const port of ports) {
      const hit = await probePortForPage(port, 500);
      if (hit) return hit;
    }
  } else {
    const hit = await probePortForPage(41787, 800);
    if (hit) return hit;
  }

  throw new Error('Antigravity CDP page target not found');
}
