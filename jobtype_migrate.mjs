import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CURRENT_JOB_TYPES = new Set(['', '薬剤師', '一般職', '管理部']);

export function planJobTypeMigration(employees) {
  const rows = Array.isArray(employees) ? employees : [];
  const changes = [];
  const unknown = [];

  for (const employee of rows) {
    const row = employee && typeof employee === 'object' ? employee : {};
    const jobType = typeof row.jobType === 'string' ? row.jobType : '';
    if (jobType === '事務') {
      changes.push({ id: row.id, from: '事務', to: '一般職' });
    } else if (!CURRENT_JOB_TYPES.has(jobType)) {
      unknown.push({ id: row.id, jobType });
    }
  }

  return { changes, unknown, total: rows.length };
}

async function runCli(args) {
  const inputIndex = args.indexOf('--input');
  if (inputIndex < 0 || !args[inputIndex + 1] || args.length !== 2) {
    throw new Error('使い方: node jobtype_migrate.mjs --input <employees.json>');
  }

  const inputPath = resolve(args[inputIndex + 1]);
  const employees = JSON.parse(await readFile(inputPath, 'utf8'));
  if (!Array.isArray(employees)) {
    throw new Error('入力JSONのルートは配列である必要があります');
  }
  process.stdout.write(JSON.stringify(planJobTypeMigration(employees), null, 2) + '\n');
}

const isDirectRun = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`エラー: ${error.message}\n`);
    process.exitCode = 1;
  });
}
