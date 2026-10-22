import { readFile } from 'node:fs/promises';
import { evaluateLearningQuality } from './learning-quality.mjs';

const [goldPath, runPath] = process.argv.slice(2);
if (!goldPath || !runPath) {
  console.error('用法: node quality/evaluate.mjs <gold.json> <run.json>');
  process.exitCode = 2;
} else {
  try {
    const [gold, run] = await Promise.all([goldPath, runPath].map(async path => JSON.parse(await readFile(path, 'utf8'))));
    const report = evaluateLearningQuality(gold, run);
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
