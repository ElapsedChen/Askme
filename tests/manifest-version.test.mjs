import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const manifest = JSON.parse(fs.readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));

test('Chrome 产品版本与当前 Askme 构建一致并使用原始品牌图标', () => {
  assert.equal(manifest.name, 'Askme');
  assert.equal(manifest.version, '1.6.0');
  assert.match(manifest.version_name, /^1\.6\.0 · 2026\.10\.02\.1$/u);
  assert.equal(manifest.action.default_icon['48'], 'assets/askme-48.png');
  assert.equal(manifest.icons['48'], 'assets/askme-48.png');
  assert.equal(manifest.web_accessible_resources[0].resources.includes('assets/askme-open-panel-128.png'), true);
});
