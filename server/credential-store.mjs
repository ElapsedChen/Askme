import { spawn } from 'node:child_process';
import { readFile, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const helper = fileURLToPath(new URL('./credential-protection.ps1', import.meta.url));
const error = code => Object.assign(new Error(code), { code });
const executable = process.env.ASKME_POWERSHELL || 'pwsh.exe';
function protect(operation, input = '', directory = '') {
  if (process.platform !== 'win32') return Promise.reject(error('WINDOWS_CREDENTIAL_STORE_REQUIRED'));
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', helper, '-Operation', operation, '-Directory', directory], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    const output = []; let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(error('CREDENTIAL_PROTECTION_FAILED')); }, 15000);
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 300000) { child.kill(); } else output.push(chunk); });
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(error('CREDENTIAL_PROTECTION_FAILED')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && size <= 300000 ? resolve(Buffer.concat(output).toString('utf8').trim()) : reject(error('CREDENTIAL_PROTECTION_FAILED')); });
    child.stdin.end(input);
  });
}
function lockDirectory(directory) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['-NoProfile','-NonInteractive','-File',helper,'-Operation','lock','-Directory',directory], { windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let acquired = false, output = '';
    const timer = setTimeout(() => { child.kill(); reject(error('CREDENTIAL_STORE_LOCKED')); }, 15000);
    const done = new Promise(finish => child.once('close', finish));
    child.stdout.on('data', bytes => {
      output += bytes.toString();
      if (!acquired && output.includes('LOCKED')) {
        acquired = true; clearTimeout(timer);
        resolve({ alive: () => child.exitCode === null && !child.killed, async release() { child.stdin.end(); await done; } });
      }
    });
    child.stderr.on('data', () => {}); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(error('CREDENTIAL_STORE_LOCKED')); });
    child.on('close', () => { clearTimeout(timer); if (!acquired) reject(error('CREDENTIAL_STORE_LOCKED')); });
  });
}

// 一个服务进程独占此加密库，避免两个进程竞争一次性的刷新令牌。
export async function openCredentialStore(identityDirectory) {
  const directory = resolve(identityDirectory, 'credentials');
  await protect('initialize', '', directory);
  const path = join(directory, 'chatgpt.dpapi.json');
  const lock = await lockDirectory(directory);
  let closed = false, queue = Promise.resolve();
  const serial = job => {
    if (closed) return Promise.reject(error('CREDENTIAL_STORE_CLOSED'));
    const next = queue.then(() => { if (!lock.alive()) throw error('CREDENTIAL_STORE_LOCK_LOST'); return job(); }); queue = next.catch(() => {}); return next;
  };
  return {
    persistent: true,
    load: () => serial(async () => {
      let text;
      try { text = await readFile(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw error('CREDENTIAL_STORE_READ_FAILED'); }
      try {
        if (text.length > 300000) throw error('CREDENTIAL_STORE_INVALID');
        const saved = JSON.parse(text);
        if (saved.version !== 1 || saved.protection !== 'windows-dpapi-current-user' || typeof saved.blob !== 'string') throw error('CREDENTIAL_STORE_INVALID');
        const plain = await protect('unprotect', saved.blob);
        return JSON.parse(Buffer.from(plain, 'base64').toString('utf8'));
      } catch { throw error('CREDENTIAL_STORE_UNREADABLE'); }
    }),
    save: record => serial(async () => {
      const blob = await protect('protect', Buffer.from(JSON.stringify(record), 'utf8').toString('base64'));
      const temporary = join(directory, `credentials-${randomUUID()}.tmp`);
      let file;
      try {
        file = await open(temporary, 'wx');
        await file.writeFile(JSON.stringify({ version: 1, protection: 'windows-dpapi-current-user', blob }));
        await file.sync(); await file.close(); file = null;
        await rename(temporary, path);
      } catch { throw error('CREDENTIAL_STORE_WRITE_FAILED'); }
      finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    }),
    clear: () => serial(async () => { try { await unlink(path); } catch (e) { if (e.code !== 'ENOENT') throw error('CREDENTIAL_STORE_CLEAR_FAILED'); } }),
    async close() { if (closed) return; closed = true; await queue; await lock.release(); }
  };
}
