import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { planJobTypeMigration } from './jobtype_migrate.mjs';

const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`PASS: ${name}\n`);
  } catch (error) {
    failed += 1;
    process.stderr.write(`FAIL: ${name}\n${error.stack || error.message}\n`);
  }
}

function extractBlock(beginMarker, endMarker) {
  const begin = html.indexOf(beginMarker);
  const end = html.indexOf(endMarker);
  assert.notEqual(begin, -1, `${beginMarker} がありません`);
  assert.notEqual(end, -1, `${endMarker} がありません`);
  assert.ok(end > begin, 'マーカーの順序が不正です');
  return html.slice(begin + beginMarker.length, end);
}

const jobTypeBlock = extractBlock('// JOBTYPE-BEGIN', '// JOBTYPE-END');
const jobTypeApi = new Function(`${jobTypeBlock}\nreturn { JOB_TYPE_OPTIONS, normalizeJobType, jobTypeOptionsHtml };`)();
const certsBlock = extractBlock('// CERTS-BEGIN', '// CERTS-END');
const certsApi = new Function(`${certsBlock}\nreturn { MAX_CERTS, normalizeCertifications, certExpiryStatus };`)();

await test('職種の正規化', () => {
  assert.equal(jobTypeApi.normalizeJobType('事務'), '一般職');
  assert.equal(jobTypeApi.normalizeJobType(' 薬剤師 '), '薬剤師');
  assert.equal(jobTypeApi.normalizeJobType(''), '');
  assert.equal(jobTypeApi.normalizeJobType('管理栄養士'), '管理栄養士');
});

await test('職種の選択肢と旧値保持', () => {
  assert.deepEqual(jobTypeApi.JOB_TYPE_OPTIONS, ['薬剤師', '一般職', '管理部']);

  const officeHtml = jobTypeApi.jobTypeOptionsHtml('事務');
  assert.match(officeHtml, /<option value="一般職" selected>一般職<\/option>/);

  const legacyHtml = jobTypeApi.jobTypeOptionsHtml('管理栄養士');
  assert.match(legacyHtml, /<option value="管理栄養士" selected>（旧）管理栄養士<\/option>/);

  const pharmacistHtml = jobTypeApi.jobTypeOptionsHtml('薬剤師');
  assert.equal((pharmacistHtml.match(/<option\b/g) || []).length, 4);
  assert.match(pharmacistHtml, /<option value="薬剤師" selected>薬剤師<\/option>/);
});

await test('職種selectに旧リテラルが残っていない', () => {
  const selectMatch = html.match(/<select id="f_jobType">([\s\S]*?)<\/select>/);
  assert.ok(selectMatch, 'f_jobType がありません');
  assert.doesNotMatch(selectMatch[1], /<option[^>]*>\s*事務\s*<\/option>/);
  assert.match(selectMatch[1], /jobTypeOptionsHtml\(e\.jobType\)/);
});

await test('職種移行計画', () => {
  const result = planJobTypeMigration([
    { id: 'e1', jobType: '事務' },
    { id: 'e2', jobType: '薬剤師' },
    { id: 'e3', jobType: '管理栄養士' },
    { id: 'e4', jobType: '' },
    { id: 'e5', jobType: '事務' },
  ]);
  assert.equal(result.total, 5);
  assert.deepEqual(result.changes, [
    { id: 'e1', from: '事務', to: '一般職' },
    { id: 'e5', from: '事務', to: '一般職' },
  ]);
  assert.deepEqual(result.unknown, [{ id: 'e3', jobType: '管理栄養士' }]);
});

await test('認定情報の正規化', () => {
  assert.equal(certsApi.MAX_CERTS, 8);
  const input = [
    { name: ' 研修認定 ', expiry: '2027-01-01' },
    { name: '', expiry: '' },
    { name: '不正日付1', expiry: '2027/01/01' },
    { name: '不正日付2', expiry: 'abc' },
    { name: '', expiry: '2027-02-01' },
    ...Array.from({ length: 7 }, (_, index) => ({ name: `認定${index}`, expiry: '' })),
  ];
  const snapshot = JSON.parse(JSON.stringify(input));
  const normalized = certsApi.normalizeCertifications(input);
  assert.equal(normalized.length, 8);
  assert.deepEqual(normalized[0], { name: '研修認定', expiry: '2027-01-01' });
  assert.equal(normalized[1].expiry, '');
  assert.equal(normalized[2].expiry, '');
  assert.deepEqual(normalized[3], { name: '', expiry: '2027-02-01' });
  assert.deepEqual(input, snapshot);
  assert.deepEqual(certsApi.normalizeCertifications(null), []);
  assert.deepEqual(
    certsApi.normalizeCertifications([{ name: '', expiry: 'abc' }]),
    [{ name: '', expiry: '' }],
  );
});

await test('認定期限のUTC判定', () => {
  const today = '2026-11-06';
  assert.equal(certsApi.certExpiryStatus('', today), 'none');
  assert.equal(certsApi.certExpiryStatus('2026-11-05', today), 'expired');
  assert.equal(certsApi.certExpiryStatus('2026-11-06', today), 'soon');
  assert.equal(certsApi.certExpiryStatus('2027-02-04', today), 'soon');
  assert.equal(certsApi.certExpiryStatus('2027-02-05', today), 'ok');
});

await test('認定入力欄と保存データ', () => {
  assert.match(html, /f_cert_name_0/);
  assert.match(html, /f_cert_expiry_7/);
  const getFormDataSource = html.slice(
    html.indexOf('function getFormData()'),
    html.indexOf('async function saveEmployee()'),
  );
  assert.match(getFormDataSource, /certifications/);
  assert.match(getFormDataSource, /normalizeCertifications/);
});

await test('全インラインスクリプトの構文', () => {
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let checked = 0;
  for (const match of html.matchAll(scriptPattern)) {
    const attributes = match[1];
    if (/\bsrc\s*=/i.test(attributes) || /\btype\s*=\s*["']module["']/i.test(attributes)) continue;
    new vm.Script(match[2], { filename: `index-inline-${checked + 1}.js` });
    checked += 1;
  }
  assert.ok(checked > 0, '検査対象のインラインスクリプトがありません');
});

process.stdout.write(`PASS ${passed} / FAIL ${failed}\n`);
if (failed > 0) process.exitCode = 1;
