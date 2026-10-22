#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createLocalCatalog, evaluate, readJson, validateDataset } from '../evaluation/gold-eval.mjs';

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) values[key] = true;
    else { values[key] = next; index += 1; }
  }
  return values;
}

function required(args, key) {
  if (!args[key]) throw new Error(`缺少 --${key}`);
  return path.resolve(args[key]);
}

function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function help() {
  process.stdout.write(`Askme MANF9543 本地金标评测\n\n` +
    `  validate --dataset <gold.json>\n` +
    `  catalog --index <local-index-export.json> --out <catalog.json> [--include-text]\n` +
    `  evaluate --dataset <gold.json> --run <run.json> --out <report.json> [--catalog <catalog.json>]\n\n` +
    `catalog 默认只导出证据 ID、标题、位置、版本 hash 和字符数；只有显式传入 --include-text 才复制正文。\n`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === 'validate') {
    const result = validateDataset(readJson(required(args, 'dataset')));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.valid) process.exitCode = 1;
  } else if (args.command === 'catalog') {
    const catalog = createLocalCatalog(readJson(required(args, 'index')), { includeText: args['include-text'] === true });
    const out = required(args, 'out');
    writeJson(out, catalog);
    process.stdout.write(`已写入 ${catalog.entries.length} 条本地证据目录：${out}\n`);
  } else if (args.command === 'evaluate') {
    const dataset = readJson(required(args, 'dataset'));
    const run = readJson(required(args, 'run'));
    const catalog = args.catalog ? readJson(path.resolve(args.catalog)) : undefined;
    const report = evaluate(dataset, run, { catalog });
    const out = required(args, 'out');
    writeJson(out, report);
    process.stdout.write(`${JSON.stringify(report.aggregate, null, 2)}\n报告：${out}\n`);
  } else {
    help();
  }
} catch (error) {
  process.stderr.write(`评测失败：${error.message}\n`);
  process.exitCode = 1;
}

