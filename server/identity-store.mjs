import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';

// 只读写本应用的非令牌注册映射；绝不导入 Codex、Chrome 或旧进程的凭据。
export async function openIdentityStore(directory) {
  const root = resolve(directory);
  await mkdir(root, { recursive: true });
  const hostPath = join(root, 'host.json'), registrationPath = join(root, 'registration.json');
  async function readOptional(path) {
    try { const data = await readFile(path, 'utf8'); if (data.length > 16000) throw new Error('IDENTITY_FILE_INVALID'); return JSON.parse(data); }
    catch (e) { if (e.code !== 'ENOENT') throw new Error('IDENTITY_FILE_INVALID'); }
  }
  let host = await readOptional(hostPath);
  if (!host) { host = { id: `urn:uuid:${randomUUID()}` }; await writeFile(hostPath, JSON.stringify(host), { flag: 'wx' }); }
  if (typeof host.id !== 'string' || !/^urn:uuid:[0-9a-f-]{36}$/i.test(host.id)) throw new Error('HOST_ID_INVALID');
  const registration = await readOptional(registrationPath);
  if (registration && (typeof registration.clientId !== 'string' || !registration.clientId || registration.clientId === 'dynamic_agent_client' || typeof registration.subject !== 'string' || !registration.subject)) throw new Error('REGISTRATION_INVALID');
  return { hostId: host.id, registration,
    async saveRegistration(value) {
      const temp = join(root, `registration-${randomUUID()}.tmp`);
      await writeFile(temp, JSON.stringify({ clientId: value.clientId, subject: value.subject }), { flag: 'wx' });
      await rename(temp, registrationPath);
    }
  };
}
