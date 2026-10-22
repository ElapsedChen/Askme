import { fileURLToPath } from 'node:url';
import { createServer } from './index.mjs';
import { createPlanSession } from './chatgpt/plan-session.mjs';
import { openIdentityStore } from './identity-store.mjs';
import { openCredentialStore } from './credential-store.mjs';

let credentialStore;
try {
  const port = Number(process.env.STUDY_PORT || 4317), extensionId = process.env.STUDY_EXTENSION_ID;
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !/^[a-p]{32}$/.test(extensionId || '')) throw new Error('START_CONFIGURATION_INVALID');
  if (process.env.STUDY_AI_PROVIDER && process.env.STUDY_AI_PROVIDER !== 'chatgpt-plan') throw new Error('CHATGPT_PLAN_ONLY');
  const identityDirectory = process.env.ASKME_IDENTITY_DIR || fileURLToPath(new URL('../.runtime/', import.meta.url));
  const identity = await openIdentityStore(identityDirectory);
  credentialStore = await openCredentialStore(identityDirectory);
  const session = createPlanSession({ ...identity, credentialStore, redirectUri: `http://127.0.0.1:${port}/auth/callback` });
  await session.restore();
  if (session.status().authenticated) {
    // 网络短暂不可用不丢失登录；实际请求仍会续期并接受服务端权限检查。
    try { await session.listModels(); } catch {}
  }
  const server = createServer({ session, allowedExtensionId: extensionId, selectedModel: session.getSelectedModel() });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '端口被占用，请正常退出旧 Askme 服务后再启动。' : 'Askme 服务启动失败。'); void credentialStore.close(); process.exitCode = 1; });
  server.on('close', () => { void credentialStore.close(); });
  server.listen(port, '127.0.0.1', () => console.log(`Askme ChatGPT 套餐服务：http://127.0.0.1:${port}；请在扩展内登录。`));
} catch (error) {
  await credentialStore?.close().catch(() => {});
  const messages = { START_CONFIGURATION_INVALID: '请设置合法的 STUDY_PORT 和 STUDY_EXTENSION_ID。', CHATGPT_PLAN_ONLY: '此版本仅支持 STUDY_AI_PROVIDER=chatgpt-plan。', IDENTITY_FILE_INVALID: 'Askme 注册文件无效，请保留原文件并检查配置路径。', HOST_ID_INVALID: 'Askme 主机 ID 无效。', REGISTRATION_INVALID: 'Askme 注册映射无效。' };
  console.error(messages[error.message] || 'Askme 启动失败；未输出任何凭据。'); process.exitCode = 1;
}
