import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const json = text => JSON.parse(text.replace(/^\uFEFF/u, ''));
async function filesBelow(relative) {
  const result = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    if (['node_modules', '.runtime', '__pycache__'].includes(entry.name)) continue;
    const name = `${relative}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await filesBelow(name));
    else if (!entry.name.includes('.test.') && entry.name !== 'build-manifest.json' && !entry.name.endsWith('.log')) result.push(name);
  }
  return result;
}
export async function inspectBuild() {
  const names = [...await filesBelow('extension'), ...await filesBelow('server'), 'start-askme.ps1', 'tools/register-autostart.ps1'].sort();
  const contents = Object.fromEntries(await Promise.all(names.map(async name => [name, await readFile(path.join(root, name))])));
  const manifest = json(contents['extension/manifest.json'].toString('utf8'));
  const match = (file, regex) => { const value = contents[file].toString('utf8').match(regex)?.[1]; if (!value) throw new Error(`构建字段缺失：${file}`); return value; };
  const build = match('extension/content.js', /const CONTENT_VERSION = '([^']+)'/u);
  const service = match('server/index.mjs', /export const SERVICE_VERSION = '([^']+)'/u);
  const expected = match('start-askme.ps1', /\$expectedVersion = '([^']+)'/u);
  const extensionId = match('start-askme.ps1', /\$extensionId = '([a-p]{32})'/u);
  if (!manifest.version_name.endsWith(build) || service !== expected) throw new Error('构建版本不一致');
  for (const script of manifest.content_scripts.flatMap(item => item.js)) if (!contents[`extension/${script}`]) throw new Error(`缺少内容脚本：${script}`);
  for (const resource of manifest.web_accessible_resources.flatMap(item => item.resources)) if (!contents[`extension/${resource}`]) throw new Error(`缺少资源：${resource}`);
  const files = Object.fromEntries(names.map(name => [name, { sha256: hash(contents[name]), sizeBytes: contents[name].length }]));
  return { schemaVersion: 2, generatedAt: new Date().toISOString(), extension: { name: manifest.name, version: manifest.version, build, id: extensionId },
    service: { version: service, port: 4317, provider: 'chatgpt-plan', retrieval: 'lexical', embedding: false,
      capabilities: ['answer', 'translate', 'vision', 'practice', 'practice-v2', 'choice-v1'] },
    sourceFingerprint: hash(names.map(name => `${name}:${files[name].sha256}`).join('\n')), files };
}
export async function writeBuildManifest() {
  const value = await inspectBuild();
  await writeFile(path.join(root, 'extension/build-manifest.json'), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return value;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const build = await writeBuildManifest();
  console.log(`Askme ${build.extension.version} · ${build.extension.build}\nService ${build.service.version} · ${build.sourceFingerprint}`);
}
