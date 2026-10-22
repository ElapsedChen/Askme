import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { openCredentialStore } from './credential-store.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);

test('Windows DPAPI 加密文件跨存储实例恢复，互斥阻止并发，退出可清除', { skip: process.platform !== 'win32' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'askme-persistence-test-'));
  let first, second;
  try {
    first = await openCredentialStore(root);
    await assert.rejects(openCredentialStore(root), /CREDENTIAL_STORE_LOCKED/);
    const fixture = { version: 1, credentials: { accessToken: 'synthetic-access-marker', refreshToken: 'synthetic-refresh-marker' }, selectedModel: 'fixture-model' };
    await first.save(fixture);
    const file = await readFile(join(root, 'credentials/chatgpt.dpapi.json'), 'utf8');
    assert.doesNotMatch(file, /synthetic-access-marker|synthetic-refresh-marker|fixture-model/);
    assert.equal(JSON.parse(file).protection, 'windows-dpapi-current-user');
    await first.close(); first = undefined;
    second = await openCredentialStore(root);
    assert.deepEqual(await second.load(), fixture);
    await second.clear(); assert.equal(await second.load(), null);
    await second.close(); second = undefined;
    // 两个真实 Node 进程分别保存和恢复，只用合成标记，不接触实际账号凭据。
    const moduleUrl = new URL('./credential-store.mjs', import.meta.url).href;
    const child = `import { openCredentialStore } from ${JSON.stringify(moduleUrl)}; const s = await openCredentialStore(process.argv[1]); try { if (process.argv[2] === 'save') await s.save({marker:'restart-fixture'}); else if ((await s.load())?.marker !== 'restart-fixture') process.exitCode=2; } finally { await s.close(); }`;
    await execFileAsync(process.execPath, ['--input-type=module', '-e', child, root, 'save'], { windowsHide: true });
    await execFileAsync(process.execPath, ['--input-type=module', '-e', child, root, 'restore'], { windowsHide: true });
  } finally {
    await first?.close(); await second?.close();
    // 仅删除本次 mkdtemp 创建、经绝对路径确认的测试目录。
    if (resolve(root).startsWith(resolve(tmpdir()) + '\\') && basename(root).startsWith('askme-persistence-test-')) await rm(root, { recursive: true, force: true });
  }
});
