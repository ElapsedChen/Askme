import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const script = readFileSync(new URL('../extension/panel-bootstrap.js', import.meta.url), 'utf8');

function setup(result = { ok: true, bindingId: 'b'.repeat(48), tabId: 7, hostDocumentId: 'host-document', generation: 1 }) {
  const messages = [];
  const listeners = {};
  const parent = { postMessage(message, origin) { messages.push({ message, origin }); } };
  const window = {
    parent,
    addEventListener(name, callback) { (listeners[name] ||= []).push(callback); }
  };
  const runtimeMessages = [];
  const context = vm.createContext({
    window,
    location: { search: '?embedded=1&v=2026.10.02.1&g=1' },
    chrome: { runtime: { async sendMessage(message) { runtimeMessages.push(message); return result; } } },
    console
  });
  vm.runInContext(script, context);
  return { context, messages, listeners, parent, runtimeMessages };
}

test('内嵌引导脚本在业务依赖之前发出启动信号并兑换 capability', async () => {
  const fixture = setup();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.messages[0])), {
    message: { type: 'ASKME_EMBEDDED_BOOT', generation: 1 }, origin: 'https://moodle.telt.unsw.edu.au'
  });
  await Promise.all(fixture.listeners.message.map(listener => listener({
    origin: 'https://moodle.telt.unsw.edu.au', source: fixture.parent,
    data: { type: 'ASKME_EMBEDDED_INIT', capability: 'a'.repeat(48), hostDocumentId: 'host-document', generation: 1 }
  })));
  const binding = await vm.runInContext('AskmeEmbeddedBootstrap.promise', fixture.context);
  assert.equal(binding.bindingId, 'b'.repeat(48));
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.runtimeMessages)), [{
    type: 'REDEEM_EMBEDDED_CAPABILITY', capability: 'a'.repeat(48), hostDocumentId: 'host-document', generation: 1
  }]);
});

test('内嵌引导脚本把后续脚本异常回报给 Moodle 宿主', () => {
  const fixture = setup();
  fixture.listeners.error[0]({ message: 'LEARNING_CORE_NOT_LOADED' });
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.messages.at(-1))), {
    message: { type: 'ASKME_EMBEDDED_BOOT_ERROR', error: 'LEARNING_CORE_NOT_LOADED', generation: 1 },
    origin: 'https://moodle.telt.unsw.edu.au'
  });
});

test('后台冷启动期间重复 INIT 只兑换一次且不会用后续失败覆盖成功', async () => {
  let resolveRedeem;
  const pending = new Promise(resolve => { resolveRedeem = resolve; });
  const fixture = setup(pending);
  const init = {
    origin: 'https://moodle.telt.unsw.edu.au', source: fixture.parent,
    data: { type: 'ASKME_EMBEDDED_INIT', capability: 'a'.repeat(48), hostDocumentId: 'host-document', generation: 1 }
  };
  const first = fixture.listeners.message[0](init);
  const second = fixture.listeners.message[0](init);
  assert.equal(fixture.runtimeMessages.length, 1);
  resolveRedeem({ ok: true, bindingId: 'b'.repeat(48), tabId: 7, hostDocumentId: 'host-document', generation: 1 });
  await Promise.all([first, second]);
  const binding = await vm.runInContext('AskmeEmbeddedBootstrap.promise', fixture.context);
  assert.equal(binding.bindingId, 'b'.repeat(48));
  assert.equal(fixture.messages.some(item => item.message?.type === 'ASKME_EMBEDDED_AUTH_ERROR'), false);
});
