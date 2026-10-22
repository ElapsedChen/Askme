import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { inspectBuild } from '../tools/build-manifest.mjs';

test('构建清单锁定扩展、内容脚本、本机服务、端口和模型版本', async () => {
  const inspected = await inspectBuild();
  const saved = JSON.parse(await readFile(new URL('../extension/build-manifest.json', import.meta.url), 'utf8'));
  assert.equal(saved.extension.version, inspected.extension.version);
  assert.equal(saved.extension.build, inspected.extension.build);
  assert.equal(saved.service.version, inspected.service.version);
  assert.equal(saved.service.port, 4317);
  assert.equal(saved.service.answerModel, 'qwen3.5:9b');
  assert.equal(saved.service.embeddingModel, 'qwen3-embedding:0.6b');
  assert.equal(typeof saved.files['extension/panel.css'], 'string');
  assert.equal(typeof saved.files['extension/panel-bootstrap.js'], 'string');
  assert.equal(typeof saved.files['extension/unit-progress.js'], 'string');
  assert.equal(typeof saved.files['server/practice-core.mjs'], 'string');
  assert.equal(typeof saved.files['extension/assets/askme-open-panel-128.png'], 'string');
  assert.equal(saved.sourceFingerprint, inspected.sourceFingerprint);
  assert.deepEqual(saved.files, inspected.files);
});
