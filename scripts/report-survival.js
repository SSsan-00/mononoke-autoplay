import path from 'node:path';
import { writeExperimentReport } from '../src/experiment-report.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (!process.argv[2]) throw new Error('出力ディレクトリを指定してください。');
const directory = path.resolve(process.argv[2]);
await writeExperimentReport(directory);
execFileSync(process.env.MONONOKE_PYTHON || 'python3', [fileURLToPath(new URL('./plot-survival.py', import.meta.url)), directory], { stdio: 'inherit' });
console.log(`再集計完了: ${directory}`);
