// 本地 Tesseract CPU OCR：语言数据随服务部署，运行时无需联网。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.join(root, 'ocr-runtime');
const require = createRequire(path.join(runtime, 'package.json'));
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const pages = manifest.pages.slice(0, 8);
const pending = new Set(pages.map(page => page.number));
const emit = record => {
  pending.delete(record.number);
  // 同步写入，预算耗尽时 process.exit 不会丢失已经完成的页。
  fs.writeSync(1, `${JSON.stringify(record)}\n`);
};
let activeLanguages = ['eng'];
const metadata = status => ({ engine: 'tesseract.js', status, languages: [...activeLanguages] });
const stop = (status, code = 0) => {
  for (const number of pending) emit({ number, ocr: metadata(status) });
  process.exit(code);
};
const timeoutMs = Math.max(1, Math.min(17_500, manifest.timeoutMs));
const deadline = Date.now() + timeoutMs;
const totalTimer = setTimeout(() => stop('timeout'), timeoutMs);
let pageTimer;
let worker;

function classify(tsv) {
  const words = [];
  for (const row of String(tsv || '').split('\n').slice(1, 12001)) {
    const columns = row.split('\t');
    if (columns[0] !== '5' || columns.length < 12) continue;
    const text = columns.slice(11).join('\t').trim();
    const confidence = Number(columns[10]);
    if (text && Number.isFinite(confidence) && confidence >= 0) words.push({ text, confidence });
  }
  if (!words.length) return { text: '', ocr: metadata('no-text-detected') };
  // 低可信词不能靠猜测补全；只要有丢弃，整页标 partial 且残词不进入课程证据。
  const accepted = words.filter(word => word.confidence >= 80 && /[\p{L}\p{N}]/u.test(word.text));
  const text = accepted.map(word => word.text).join(' ');
  const count = [...text].filter(character => /[\p{L}\p{N}]/u.test(character)).length;
  const weight = accepted.reduce((sum, word) => sum + word.text.length, 0);
  const confidence = weight ? accepted.reduce((sum, word) => sum + word.confidence * word.text.length, 0) / weight : 0;
  // 校徽或极短残词不能证明整页标题已读到；保留页码缺口供原图回查。
  if (count < 12 || confidence < 85 || count / Math.max(1, text.length) < 0.45) {
    return { text: '', ocr: { ...metadata('low-confidence'), confidence: Math.round(confidence * 100) / 100,
      acceptedCharacters: count } };
  }
  const rejectedWords = words.length - accepted.length;
  return {
    text: rejectedWords ? '' : text.slice(0, 100_000), truncated: text.length > 100_000,
    ocr: { ...metadata(rejectedWords ? 'partial' : 'recognized'), confidence: Math.round(confidence * 100) / 100,
      acceptedWords: accepted.length, acceptedCharacters: count, rejectedWords, visualContentRead: false },
  };
}

try {
  const { createWorker } = require('tesseract.js');
  const langPath = path.join(runtime, 'tessdata');
  for (const code of ['eng', 'chi_sim']) fs.accessSync(path.join(langPath, `${code}.traineddata.gz`));
  // 7.0.0 在 initialize 中将语言对象的 data 拼成语言名；使用文档字符串接口和本地路径避开该缺陷。
  worker = await createWorker('eng', 1, { langPath, gzip: true, cacheMethod: 'none', logger: () => {},
    errorHandler: error => {
      fs.writeSync(2, `OCR initialization/worker failure: ${String(error).slice(0, 500)}\n`);
      stop('failed', 1);
    },
  });
  await worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '180' });
  for (const page of pages) {
    // 单页识别最多五秒；终止整个进程可防止挂起的 WASM 线程继续耗用 CPU。
    const pageDeadline = Date.now() + 5000;
    let classified;
    pageTimer = setTimeout(() => {
      if (classified) emit({ number: page.number, ...classified });
      stop('timeout');
    }, 5000);
    if (activeLanguages.length !== 1) {
      await worker.reinitialize('eng', 1);
      activeLanguages = ['eng'];
      await worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '180' });
    }
    const image = fs.readFileSync(page.path);
    let result = await worker.recognize(image, {}, { text: false, tsv: true });
    classified = classify(result.data.tsv);
    classified.ocr.imagePass = 'original';
    // 仅对黑色字的彩色细线干扰做一次有界补偿；更少文字或更低置信度不能覆盖原结果。
    if (page.alternatePath && Math.min(deadline, pageDeadline) - Date.now() >= 1200) {
      const alternate = await worker.recognize(fs.readFileSync(page.alternatePath), {}, { text: false, tsv: true });
      const candidate = classify(alternate.data.tsv);
      const originalCount = classified.ocr.acceptedCharacters || 0;
      const enoughMore = (candidate.ocr.acceptedCharacters || 0) >= originalCount + Math.max(4, Math.ceil(originalCount * 0.25));
      if (candidate.ocr.status === 'recognized' && enoughMore
          && candidate.ocr.confidence >= (classified.ocr.confidence || 0)) {
        candidate.ocr.imagePass = 'dark-text';
        classified = candidate;
      }
    }
    // 英语没有可用结果且总预算充足时才尝试中英文；不得用中文模型覆盖英语残词为完整读取。
    if (['no-text-detected', 'low-confidence'].includes(classified.ocr.status)
        && Math.min(deadline, pageDeadline) - Date.now() >= 4000) {
      await worker.reinitialize('eng+chi_sim', 1);
      activeLanguages = ['eng', 'chi_sim'];
      await worker.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '180' });
      result = await worker.recognize(image, {}, { text: false, tsv: true });
      classified = classify(result.data.tsv);
      classified.ocr.imagePass = 'original';
    }
    clearTimeout(pageTimer);
    emit({ number: page.number, ...classified });
  }
  await worker.terminate();
  clearTimeout(totalTimer);
} catch (error) {
  fs.writeSync(2, `OCR failure: ${String(error).slice(0, 500)}\n`);
  clearTimeout(pageTimer);
  clearTimeout(totalTimer);
  stop('unavailable', 1);
}
