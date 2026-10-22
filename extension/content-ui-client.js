// 在 ISOLATED world 内使用；实例和绑定只能留在宿主闭包里。
(() => {
  'use strict';
  const protocol = globalThis.AskmeUiProtocol;
  function createContentUiClient({ runtime, buildVersion, hostInstanceId, randomId = () => {
    const bytes = new Uint8Array(24); crypto.getRandomValues(bytes);
    return [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  } }) {
    let binding = null, epoch = 0, connecting = null, recovery = null, disposed = false;
    const error = code => Object.assign(new Error(code), { code });
    const safeCode = result => typeof result?.error === 'string' && /^[A-Z_]{1,60}$/u.test(result.error) ? result.error : 'UI_UNAVAILABLE';
    async function connect() {
      if (disposed) throw error('UI_DISPOSED');
      if (binding) return { accountId: binding.accountId };
      if (connecting) return connecting;
      const started = epoch;
      const pending = (async () => {
        const result = await runtime.sendMessage({ type: 'ASKME_UI_HELLO', payload: { protocolVersion: 1, buildVersion, hostInstanceId } });
        if (disposed || epoch !== started) {
          // 初始化途中宿主被销毁时，回收迟到的后台绑定。
          if (result?.ok && protocol.token(result.value?.bindingId) && Number.isSafeInteger(result.value?.generation)) {
            try { await runtime.sendMessage({ type: 'ASKME_UI_DISPOSE', payload: { bindingId: result.value.bindingId, generation: result.value.generation } }); } catch { /* 断线或导航后的后台清理由绑定失效处理。 */ }
          }
          throw error('UI_DISPOSED');
        }
        if (!result?.ok) throw error(safeCode(result));
        const value = result.value;
        if (!protocol.exact(value, ['protocolVersion', 'bindingId', 'generation', 'accountId', 'accountEpoch', 'expiresAt']) || value.protocolVersion !== 1 ||
            !Number.isSafeInteger(value.accountEpoch) || value.accountEpoch < 0 ||
            !protocol.token(value.bindingId) || !protocol.id(value.accountId) || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Number.isFinite(value.expiresAt)) throw error('INVALID_UI_BINDING');
        binding = Object.freeze({ ...value });
        return { accountId: binding.accountId };
      })();
      connecting = pending;
      try { return await pending; } finally { if (connecting === pending) connecting = null; }
    }
    async function recover(current, started) {
      if (disposed) throw error('UI_STALE_RESPONSE');
      let shared = recovery;
      if (!shared || shared.from !== current || shared.started !== started) {
        if (epoch !== started || binding !== current) throw error('UI_STALE_RESPONSE');
        binding = null; epoch++;
        shared = { from: current, started, nextEpoch: epoch, target: null, pending: null };
        recovery = shared;
        // 同一旧绑定的多个明确 MISMATCH 共用一次 hello；完成后保留记录供迟到的拒绝加入。
        shared.pending = Promise.resolve().then(async () => {
          const next = await connect();
          if (disposed || recovery !== shared || epoch !== shared.nextEpoch || !binding) throw error('UI_STALE_RESPONSE');
          if (next.accountId !== current.accountId) {
            binding = null; epoch++; recovery = null;
            throw error('UI_ACCOUNT_CHANGED');
          }
          shared.target = binding;
          return shared.target;
        });
      }
      const target = await shared.pending;
      if (disposed || recovery !== shared || epoch !== shared.nextEpoch || binding !== target) throw error('UI_STALE_RESPONSE');
      return { binding: target, epoch: shared.nextEpoch };
    }
    async function invoke(op, args, metadata, current, started, rebound) {
      if (!current || disposed) throw error('UI_DISPOSED');
      if (epoch !== started || binding !== current) throw error('UI_STALE_RESPONSE');
      const payload = { ...metadata, v: 1, requestId: randomId(), bindingId: current.bindingId, generation: current.generation, op, args: structuredClone(args) };
      if (!protocol.request(payload)) throw error('INVALID_UI_REQUEST');
      const result = await runtime.sendMessage({ type: 'ASKME_UI_REQUEST', payload });
      const code = result?.ok === false ? safeCode(result) : '';
      // 唯有可信 broker 明确表示操作未执行，才可在旧 epoch 检查前加入共享重连。
      // 成功、未知结果和 EXPIRED 均继续走下方旧响应拒绝，不重复执行写操作。
      if (code === 'UI_BINDING_MISMATCH' && !rebound) {
        if (disposed) throw error('UI_STALE_RESPONSE');
        if (result.requestId !== payload.requestId || result.generation !== current.generation) throw error('INVALID_UI_RESPONSE');
        const next = await recover(current, started);
        return invoke(op, args, metadata, next.binding, next.epoch, true);
      }
      if (disposed || epoch !== started || binding !== current) throw error('UI_STALE_RESPONSE');
      if (!result?.ok) {
        const failureCode = safeCode(result);
        if (['UI_BINDING_EXPIRED', 'UI_BINDING_MISMATCH', 'UI_ACCOUNT_CHANGED'].includes(failureCode)) { binding = null; epoch++; recovery = null; }
        throw error(failureCode);
      }
      if (result.requestId !== payload.requestId || result.generation !== current.generation || !protocol.bounded(result.value, 65536)) throw error('INVALID_UI_RESPONSE');
      return result.value;
    }
    async function call(op, args = {}, metadata = {}) {
      const originalArgs = structuredClone(args), originalMetadata = structuredClone(metadata);
      await connect();
      return invoke(op, originalArgs, originalMetadata, binding, epoch, false);
    }
    return Object.freeze({ connect, call, async dispose() {
      if (disposed) return;
      disposed = true; epoch++; recovery = null;
      const current = binding; binding = null;
      if (current) {
        try { await runtime.sendMessage({ type: 'ASKME_UI_DISPOSE', payload: { bindingId: current.bindingId, generation: current.generation } }); } catch { /* 后台失联时本地实例仍立即失效。 */ }
      }
    } });
  }
  globalThis.AskmeContentUiClient = Object.freeze({ createContentUiClient });
})();
