// Restart only the desktop window. Never send quit/restart to the recorder.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function recoverInterface({pid, target, data, attempt}, {
  platform = process.platform,
  isAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } },
  pause = ms => new Promise(resolve => setTimeout(resolve, ms)),
  launch = (file, args, env) => new Promise((resolve, reject) => {
    // The restarted Windows GUI must be visible. The native host already
    // starts this Node helper without a console window.
    const child = spawn(file, args, {env, detached: true, stdio: 'ignore', windowsHide: false});
    child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
  }),
  fetcher = fetch, timeoutMs = 30000, keepAliveMs = 10000,
} = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(attempt) || attempt < 1 || attempt > 3 ||
      !path.isAbsolute(target) || !path.isAbsolute(data) ||
      !['darwin', 'win32'].includes(platform) ||
      !(platform === 'darwin' ? target.endsWith('.app') : target.toLowerCase().endsWith('.exe'))) throw new Error('界面恢复请求无效。');
  const client = randomUUID();
  async function heartbeat() {
    try {
      const endpoint = JSON.parse(await fs.readFile(path.join(data, 'desktop-service.json'), 'utf8'));
      const address = new URL(endpoint.origin);
      if (endpoint.protocol !== 1 || path.resolve(endpoint.dataPath) !== path.resolve(data) ||
          address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port ||
          address.username || address.password || address.search || address.hash || !['', '/'].includes(address.pathname) ||
          !/^[a-f0-9]{64}$/.test(endpoint.token)) return;
      await fetcher(new URL('/internal/desktop', address), {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json', 'X-Caibo-Instance': endpoint.token},
        body: JSON.stringify({action: 'heartbeat', client, pid: process.pid}), signal: AbortSignal.timeout(1000)});
    } catch { /* The new window will also reconnect if the backend was lost. */ }
  }
  await heartbeat();
  const interval = setInterval(() => void heartbeat(), 1000);
  try {
    const deadline = Date.now() + timeoutMs;
    while (isAlive(pid)) {
      if (Date.now() >= deadline) throw new Error('旧界面尚未退出，已停止自动恢复。');
      await pause(100);
    }
    const env = {...process.env, CAIBO_UI_RECOVERY_ATTEMPT: String(attempt)};
    if (platform === 'darwin') {
      const args = ['-n', '--env', `CAIBO_UI_RECOVERY_ATTEMPT=${attempt}`, '--env', `CAIBO_DATA_ROOT=${data}`];
      if (env.CAIBO_EXPORT_ROOT) args.push('--env', `CAIBO_EXPORT_ROOT=${env.CAIBO_EXPORT_ROOT}`);
      args.push(target); await launch('/usr/bin/open', args, env);
    } else await launch(target, [], env);
    await pause(keepAliveMs);
  } finally { clearInterval(interval); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [pid, target, data, attempt] = process.argv.slice(2);
  recoverInterface({pid: Number(pid), target, data, attempt: Number(attempt)}).catch(error => { console.error(error.message); process.exitCode = 1; });
}
