import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const url = 'https://ollama.com/download/OllamaSetup.exe';
const target = process.argv[2];
if (!target) throw new Error('需要指定输出路径');
const response = await fetch(url);
if (!response.ok || !response.body) throw new Error(`下载失败：HTTP ${response.status}`);
console.log(`下载官方安装包，大小约 ${Math.round(Number(response.headers.get('content-length')) / 1e6)} MB`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
console.log(`已下载到 ${target}`);
