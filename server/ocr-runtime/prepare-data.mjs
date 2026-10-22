// 部署时将固定语言包放到统一的本地 langPath；运行 OCR 时绝不下载。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const destination = path.join(root, 'tessdata');
fs.mkdirSync(destination, { recursive: true });
for (const code of ['eng', 'chi_sim']) {
  fs.copyFileSync(path.join(root, 'node_modules', '@tesseract.js-data', code, '4.0.0_best_int', `${code}.traineddata.gz`),
    path.join(destination, `${code}.traineddata.gz`));
}
