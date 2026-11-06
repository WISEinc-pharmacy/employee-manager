import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const htmlPath = new URL('./index.html', import.meta.url);
const html = fs.readFileSync(htmlPath, 'utf8');
const blockMatch = html.match(/\/\/ INTAKE-APPROVE-BEGIN([\s\S]*?)\/\/ INTAKE-APPROVE-END/);
assert.ok(blockMatch, '純粋関数ブロックが見つかること');

const pure = new Function(`${blockMatch[1]}
return { isEmptyVal, findIntakeDuplicates, buildEmployeeFromIntake, computeAppendUpdates, applyIntakeApproval };`)();
const { isEmptyVal, findIntakeDuplicates, buildEmployeeFromIntake, computeAppendUpdates, applyIntakeApproval } = pure;

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function clone(value) { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }

function createFirestoreMock(initial = {}) {
  const stores = new Map();
  Object.entries(initial).forEach(([collection, docs]) => {
    stores.set(collection, new Map(Object.entries(docs).map(([id, data]) => [id, clone(data)])));
  });
  const calls = [];
  let addSequence = 0;
  const collectionStore = name => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name);
  };
  const db = {
    collection(name) {
      return {
        async add(data) {
          const id = `new-${++addSequence}`;
          calls.push({ operation: 'add', collection: name, id, data: clone(data) });
          collectionStore(name).set(id, clone(data));
          return { id };
        },
        doc(id) {
          return {
            async get() {
              calls.push({ operation: 'get', collection: name, id });
              const store = collectionStore(name);
              return { exists: store.has(id), data: () => clone(store.get(id)) };
            },
            async update(data) {
              calls.push({ operation: 'update', collection: name, id, data: clone(data) });
              const store = collectionStore(name);
              const current = store.get(id) || {};
              store.set(id, { ...current, ...clone(data) });
            },
          };
        },
      };
    },
  };
  return {
    db,
    calls,
    read: (collection, id) => clone(collectionStore(collection).get(id)),
  };
}

function makeDeps(mock, employees = []) {
  let timestampSequence = 0;
  return {
    db: mock.db,
    serverTimestamp: () => ({ mockTimestamp: ++timestampSequence }),
    userEmail: 'approver@example.test',
    employees,
  };
}

function functionBody(source, functionName) {
  const start = source.indexOf(`async function ${functionName}(`);
  assert.notEqual(start, -1, `${functionName} が存在すること`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = null;
  let escaped = false;
  for (let i = brace; i < source.length; i++) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth++;
    if (char === '}' && --depth === 0) return source.slice(brace + 1, i);
  }
  throw new Error(`${functionName} の終端が見つかりません`);
}

test('候補なしと新規作成は従来の保存規則を維持する', async () => {
  const d = {
    name: '架空 花子', kana: 'カクウ ハナコ', jobType: '事務', store: '架空店', hireDate: '2030-04-01',
    emailPersonal: 'hanako@example.test', position: 'なし', careerUp: '有', careerUpDate: '2031-04-01',
    note: '架空の備考', mentorName: '', birthDate: null, directApplyBonus: 0,
  };
  assert.deepEqual(findIntakeDuplicates(d, [{ id: 'other', name: '別人', emailPersonal: 'other@example.test' }]), []);
  const mock = createFirestoreMock({ employeeIntake: { intake1: { status: 'pending' } } });
  const result = await applyIntakeApproval(makeDeps(mock), d, 'intake1', { mode: 'new' });
  assert.deepEqual(result, { mode: 'new', employeeId: 'new-1' });
  assert.equal(mock.calls.filter(call => call.operation === 'add' && call.collection === 'employees').length, 1);
  const saved = mock.read('employees', 'new-1');
  assert.deepEqual({
    name: saved.name, kana: saved.kana, jobType: saved.jobType, store: saved.store, hireDate: saved.hireDate,
    emailPersonal: saved.emailPersonal, personalEmail: saved.personalEmail, position: saved.position,
    careerUpDate: saved.careerUpDate, note2: saved.note2, status: saved.status,
    hrThreadPending: saved.hrThreadPending, intakeDocId: saved.intakeDocId,
  }, {
    name: '架空 花子', kana: 'カクウ ハナコ', jobType: '事務', store: '架空店', hireDate: '2030-04-01',
    emailPersonal: 'hanako@example.test', personalEmail: 'hanako@example.test', position: '',
    careerUpDate: '2031-04-01', note2: '【入社受付フォーム】架空の備考', status: '在籍',
    hrThreadPending: true, intakeDocId: 'intake1',
  });
  assert.equal('mentorName' in saved, false);
  assert.equal('birthDate' in saved, false);
  assert.equal('directApplyBonus' in saved, false);
  assert.ok(saved.createdAt && saved.updatedAt);
  assert.equal(saved.updatedBy, 'approver@example.test');
  assert.deepEqual(mock.read('employeeIntake', 'intake1'), {
    status: 'approved', approvedBy: 'approver@example.test', approvedAt: { mockTimestamp: 3 }, employeeId: 'new-1',
  });
});

test('候補が存在しても new 指定なら既存社員を変更しない', async () => {
  const existing = { name: '架空 太郎', store: '既存店' };
  const mock = createFirestoreMock({ employees: { emp1: existing }, employeeIntake: { intake2: { status: 'pending' } } });
  await applyIntakeApproval(makeDeps(mock, [{ id: 'emp1', ...existing }]), { name: '架空 太郎', store: '新店' }, 'intake2', { mode: 'new' });
  assert.equal(mock.calls.filter(call => call.operation === 'add' && call.collection === 'employees').length, 1);
  assert.deepEqual(mock.read('employees', 'emp1'), existing);
});

test('追記は空欄だけを埋め、addせず申請を承認済みにする', async () => {
  const existing = { name: '架空 次郎', mentorName: '', birthDate: null, workLocations: [], status: '在籍' };
  const mock = createFirestoreMock({ employees: { emp2: existing }, employeeIntake: { intake3: { status: 'pending' } } });
  const d = { name: '架空 次郎', mentorName: '架空メンター', birthDate: '1990-01-01', workLocations: ['架空店'] };
  const result = await applyIntakeApproval(makeDeps(mock, [{ id: 'emp2', ...existing }]), d, 'intake3', { mode: 'append', targetId: 'emp2' });
  assert.equal(mock.calls.filter(call => call.operation === 'add').length, 0);
  assert.equal(mock.calls.filter(call => call.operation === 'update' && call.collection === 'employees' && call.id === 'emp2').length, 1);
  const saved = mock.read('employees', 'emp2');
  assert.equal(saved.mentorName, '架空メンター');
  assert.equal(saved.birthDate, '1990-01-01');
  assert.deepEqual(saved.workLocations, ['架空店']);
  assert.equal(saved.updatedBy, 'approver@example.test');
  assert.equal(saved.hrThreadPending, undefined);
  assert.deepEqual(result.filledKeys, ['mentorName', 'birthDate', 'workLocations', 'intakeDocId']);
  assert.deepEqual(mock.read('employeeIntake', 'intake3'), {
    status: 'approved', approvedBy: 'approver@example.test', approvedAt: { mockTimestamp: 2 }, employeeId: 'emp2',
    appendedToExisting: true, appendedKeys: ['mentorName', 'birthDate', 'workLocations', 'intakeDocId'],
  });
});

test('追記は既存値と常時対象外キーを上書きしない', () => {
  const existing = { jobType: '薬剤師', store: '足立', hireDate: '2028-01-01', name: '既存名', kana: 'キソン', status: '退職', position: '主任', hrThreadPending: false };
  const built = { jobType: '事務', store: '架空店', hireDate: '2030-01-01', name: '申請名', kana: 'シンセイ', status: '在籍', position: '', hrThreadPending: true };
  const result = computeAppendUpdates(existing, built);
  assert.deepEqual(result.updates, {});
  assert.deepEqual(result.skipped, [
    { key: 'jobType', existing: '薬剤師', incoming: '事務' },
    { key: 'store', existing: '足立', incoming: '架空店' },
    { key: 'hireDate', existing: '2028-01-01', incoming: '2030-01-01' },
  ]);
  for (const key of ['name', 'kana', 'status', 'position', 'hrThreadPending']) {
    assert.equal(key in result.updates, false);
    assert.equal(result.skipped.some(item => item.key === key), false);
  }
});

test('空判定は空文字・空白・null・空配列だけを空とする', () => {
  assert.equal(isEmptyVal(undefined), true);
  assert.equal(isEmptyVal(null), true);
  assert.equal(isEmptyVal(''), true);
  assert.equal(isEmptyVal('　 '), true);
  assert.equal(isEmptyVal([]), true);
  assert.equal(isEmptyVal(0), false);
  assert.equal(isEmptyVal(false), false);
  const result = computeAppendUpdates({ a: '', b: '　', c: null, d: [], e: 0, f: false }, { a: 'A', b: 'B', c: 'C', d: ['D'], e: 1, f: true });
  assert.deepEqual(result.updates, { a: 'A', b: 'B', c: 'C', d: ['D'] });
  assert.deepEqual(result.skipped, [{ key: 'e', existing: 0, incoming: 1 }, { key: 'f', existing: false, incoming: true }]);
});

test('候補判定は氏名空白とメール大小文字を正規化し全候補を優先順で返す', () => {
  const employees = [
    { id: 'name-only', name: '架空　花子', status: '退職' },
    { id: 'both', name: '架 空 花 子', personalEmail: 'HANAKO@EXAMPLE.TEST', status: '在籍' },
    { id: 'email-only', name: '別人', emailPersonal: 'hanako@example.test' },
  ];
  const result = findIntakeDuplicates({ name: '架空花子', emailPersonal: ' hanako@example.test ' }, employees);
  assert.deepEqual(result.map(item => ({ id: item.employee.id, reasons: item.reasons })), [
    { id: 'both', reasons: ['name', 'email'] },
    { id: 'name-only', reasons: ['name'] },
    { id: 'email-only', reasons: ['email'] },
  ]);
  assert.equal(result[1].employee.status, '退職');
  assert.deepEqual(findIntakeDuplicates({ name: '　', emailPersonal: ' ' }, employees), []);
});

test('存在しない追記先は一切書き込まずエラーにする', async () => {
  const mock = createFirestoreMock({ employeeIntake: { intake4: { status: 'pending' } } });
  await assert.rejects(
    applyIntakeApproval(makeDeps(mock), { name: '架空 三郎' }, 'intake4', { mode: 'append', targetId: 'missing' }),
    /追記先の社員データが見つかりません/,
  );
  assert.equal(mock.calls.filter(call => call.operation === 'update' || call.operation === 'add').length, 0);
});

test('不正な choice は読込も書込もせずエラーにする', async () => {
  for (const choice of [{ mode: 'unknown' }, { mode: 'append' }]) {
    const mock = createFirestoreMock({ employeeIntake: { intake5: { status: 'pending' } } });
    await assert.rejects(applyIntakeApproval(makeDeps(mock), {}, 'intake5', choice));
    assert.deepEqual(mock.calls, []);
  }
});

test('追記直前の最新値を使いキャッシュ値を使わない', async () => {
  const mock = createFirestoreMock({
    employees: { emp3: { name: '架空 四郎', mentorName: '最新メンター' } },
    employeeIntake: { intake6: { status: 'pending' } },
  });
  const cached = [{ id: 'emp3', name: '架空 四郎', mentorName: '' }];
  const result = await applyIntakeApproval(makeDeps(mock, cached), { name: '架空 四郎', mentorName: '申請メンター' }, 'intake6', { mode: 'append', targetId: 'emp3' });
  assert.equal(mock.calls.some(call => call.operation === 'get' && call.collection === 'employees' && call.id === 'emp3'), true);
  assert.equal(result.filledKeys.includes('mentorName'), false);
  assert.deepEqual(result.skipped.find(item => item.key === 'mentorName'), { key: 'mentorName', existing: '最新メンター', incoming: '申請メンター' });
  assert.equal(mock.read('employees', 'emp3').mentorName, '最新メンター');
});

test('純粋関数と承認処理は入力を破壊しない', async () => {
  const d = { name: '架空 五郎', mentorName: '架空メンター', workLocations: ['架空店'] };
  const existing = { name: '架空 五郎', mentorName: '' };
  const built = buildEmployeeFromIntake(d, 'intake7');
  const cached = [{ id: 'emp4', ...existing }];
  const before = { d: JSON.stringify(d), existing: JSON.stringify(existing), built: JSON.stringify(built), cached: JSON.stringify(cached) };
  findIntakeDuplicates(d, cached);
  computeAppendUpdates(existing, built);
  const mock = createFirestoreMock({ employees: { emp4: existing }, employeeIntake: { intake7: { status: 'pending' } } });
  await applyIntakeApproval(makeDeps(mock, cached), d, 'intake7', { mode: 'append', targetId: 'emp4' });
  assert.equal(JSON.stringify(d), before.d);
  assert.equal(JSON.stringify(existing), before.existing);
  assert.equal(JSON.stringify(built), before.built);
  assert.equal(JSON.stringify(cached), before.cached);
});

test('画面に重複モーダルと承認処理の配線がある', () => {
  assert.match(html, /id="intakeDupeModal"/);
  assert.match(html, /function findIntakeDuplicates\s*\(/);
  assert.match(html, /async function applyIntakeApproval\s*\(/);
  const body = functionBody(html, 'approveIntake');
  assert.match(body, /findIntakeDuplicates/);
  assert.match(body, /openIntakeDupeModal/);
  assert.match(body, /applyIntakeApproval|finishNewIntakeApproval/);
  assert.doesNotMatch(body, /db\.collection\('employees'\)\.add\s*\(/);
  for (const text of [
    '同じ人かもしれない社員が登録されています',
    '追記を選ぶと、その社員の空欄の項目だけ入社フォームの内容で埋めます。すでに入っている値は書き換えません。',
    '選んだ社員へ追記する', '別人として新規作成する', 'キャンセル',
  ]) assert.ok(html.includes(text), `文言「${text}」が存在すること`);
});

test('全インラインスクリプトに構文エラーがない', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  let checked = 0;
  for (const [, attrs, source] of scripts) {
    if (/\bsrc\s*=/.test(attrs) || /\btype\s*=\s*["']module["']/.test(attrs)) continue;
    new vm.Script(source, { filename: `index-inline-${checked + 1}.js` });
    checked++;
  }
  assert.ok(checked > 0);
});

let passed = 0;
let failed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}
console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exitCode = 1;
