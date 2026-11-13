import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCdpTarget, isLanguageServerRunning } from './cdp-helpers.mjs';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const INJECT_SCRIPT = join(HERE, 'inject-statusbar.mjs');

async function checkAndInject() {
  try {
    if (!(await isLanguageServerRunning())) {
      return;
    }

    const { pageTarget } = await findCdpTarget();
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: 'Boolean(document.getElementById("antigravity-live-statusbar"))',
          },
        })
      );
    };

    ws.onmessage = async (msg) => {
      try {
        const res = JSON.parse(msg.data);
        const exists = res?.result?.result?.value;
        if (!exists) {
          await execFileAsync(process.execPath, [INJECT_SCRIPT], { timeout: 8000 });
        }
      } catch {
        /* ignore */
      }
      ws.close();
    };

    ws.onerror = () => ws.close();
  } catch {
    // Wait silently for next poll
  }
}

setInterval(checkAndInject, 6000);
checkAndInject();
