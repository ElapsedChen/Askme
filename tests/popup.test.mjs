import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/popup.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../extension/popup.html', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
const document = { addEventListener() {} };
const context = vm.createContext({ URL, document });
const api = vm.runInContext(`${source}\nglobalThis.__test = { validMoodleTab, pickMoodleTab, MOODLE_HOME }; __test`, context);

test('扩展按钮使用独立 Askme popup', () => {
  assert.equal(manifest.action.default_popup, 'popup.html');
  assert.match(html, /从 Moodle 课程开始/);
  assert.doesNotMatch(html, /AskSia|Upgrade to A\+/i);
});

test('后台每次启动取消旧侧栏入口，使工具栏点击交给 popup', async () => {
  const background = readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8');
  const behaviors = [];
  vm.runInNewContext(background, { chrome: {
    sidePanel: { setPanelBehavior: value => { behaviors.push(value); return Promise.resolve(); } },
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } }
  } });
  assert.deepEqual(JSON.parse(JSON.stringify(behaviors)), [{ openPanelOnActionClick: false }]);
});

test('popup 只复用精确的 UNSW Moodle 标签页', () => {
  assert.equal(api.validMoodleTab({ id: 1, url: 'https://moodle.telt.unsw.edu.au/my/' }), true);
  assert.equal(api.validMoodleTab({ id: 1, url: 'https://moodle.telt.unsw.edu.au.evil.example/my/' }), false);
  assert.equal(api.validMoodleTab({ id: 1, url: 'http://moodle.telt.unsw.edu.au/my/' }), false);
  assert.equal(api.MOODLE_HOME, 'https://moodle.telt.unsw.edu.au/my/courses.php');
});

test('popup 优先聚焦当前 Moodle 标签，其次选择最近标签', () => {
  const selected = api.pickMoodleTab([
    { id: 1, url: 'https://moodle.telt.unsw.edu.au/course/view.php?id=1', lastAccessed: 30 },
    { id: 2, url: 'https://moodle.telt.unsw.edu.au/my/', active: true, lastAccessed: 10 },
    { id: 3, url: 'https://example.com', active: true, lastAccessed: 40 }
  ]);
  assert.equal(selected.id, 2);
});
