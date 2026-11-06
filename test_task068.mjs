import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL: ${name}: ${error.message}`);
  }
}

function equal(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function ok(value, label) {
  if (!value) throw new Error(label);
}

const conversionMatch = html.match(/\/\/ CONVERSION-BEGIN[\s\S]*?\/\/ CONVERSION-END/);
if (!conversionMatch) throw new Error('CONVERSION block not found');
const conversionBlock = conversionMatch[0];
const conversionContext = {};
vm.runInNewContext(`${conversionBlock}\nthis.api = { CONVERSION_TYPES, normalizeConversion, formatConversion };`, conversionContext);
const { CONVERSION_TYPES, normalizeConversion, formatConversion } = conversionContext.api;

test('hyphen date and canonical type are separated', () => {
  const value = normalizeConversion({ conversionPlannedType: '2027-02-01 → 40時間正社員' });
  equal(value.date, '2027-02-01', 'date');
  equal(value.type, '40時間正社員', 'type');
  equal(value.legacyText, '', 'legacyText');
});

test('slash date and canonical type are separated', () => {
  const value = normalizeConversion({ conversionPlannedType: '2027/2/1 40時間正社員' });
  equal(value.date, '2027-02-01', 'date');
  equal(value.type, '40時間正社員', 'type');
});

test('Japanese date and short-time type are separated', () => {
  const value = normalizeConversion({ conversionPlannedType: '2027年2月1日→30時間時短社員' });
  equal(value.date, '2027-02-01', 'date');
  equal(value.type, '30時間時短社員', 'type');
});

test('stored conversion date is retained for a type-only value', () => {
  const value = normalizeConversion({ conversionDate: '2027-03-02', conversionPlannedType: '40時間正社員' });
  equal(value.date, '2027-03-02', 'date');
  equal(value.type, '40時間正社員', 'type');
});

test('stored conversion date wins over a different embedded date', () => {
  const value = normalizeConversion({ conversionDate: '2027-03-02', conversionPlannedType: '2027-02-01 → 40時間正社員' });
  equal(value.date, '2027-03-02', 'date');
  equal(value.type, '40時間正社員', 'type');
});

test('minor width, spacing, and h variants normalize uniquely', () => {
  const value = normalizeConversion({ conversionPlannedType: '４０ h 正社員' });
  equal(value.type, '40時間正社員', 'type');
});

test('ASCII arrow and h variant normalize uniquely', () => {
  const value = normalizeConversion({ conversionPlannedType: '2027-02-01 -> 30h正社員' });
  equal(value.date, '2027-02-01', 'date');
  equal(value.type, '30時間正社員', 'type');
});

test('unknown value remains as legacy text and is formatted', () => {
  const value = normalizeConversion({ conversionPlannedType: '要相談' });
  equal(value.type, '', 'type');
  equal(value.legacyText, '要相談', 'legacyText');
  ok(formatConversion({ conversionPlannedType: '要相談' }).includes('要相談'), 'legacy text is missing');
});

test('empty values format as a hyphen', () => {
  equal(formatConversion({}), '-', 'format');
});

test('convSwitchText does not duplicate an embedded date', () => {
  const convMatch = html.match(/function convSwitchText\(e\)\s*\{[\s\S]*?\n\}/);
  ok(convMatch, 'convSwitchText not found');
  const context = {};
  vm.runInNewContext(`${conversionBlock}\nconst esc = value => String(value);\n${convMatch[0]}\nthis.result = convSwitchText({ conversionPlannedType: '2027-02-01 → 40時間正社員' });`, context);
  equal(context.result, '2027-02-01 → 40時間正社員', 'display');
});

test('employee modal contains the conversion select and four types', () => {
  const selectMatch = html.match(/<select id="f_conversionPlannedType">[\s\S]*?<\/select>/);
  ok(selectMatch, 'conversion select not found');
  ok(selectMatch[0].includes('${conversionTypeOptions}'), 'canonical options are not rendered');
  ok(selectMatch[0].includes('${legacyConversionOption}'), 'legacy option is not rendered');
  equal(CONVERSION_TYPES.length, 4, 'type option count');
  for (const type of CONVERSION_TYPES) ok(html.includes(`'${type}'`), `type missing: ${type}`);
  ok(html.includes('切替日（正社員切替）'), 'conversion date label missing');
  ok(html.includes('切替後の雇用形態'), 'conversion type label missing');
});

test('CSV export appends the conversion column', () => {
  const exportMatch = html.match(/function exportCSV\(\)\s*\{[\s\S]*?\n\}/);
  ok(exportMatch, 'exportCSV not found');
  ok(exportMatch[0].includes("'正社員切替'"), 'CSV header missing');
  ok(exportMatch[0].includes('formatConversion(e)'), 'CSV formatter missing');
});

test('form storage keeps date and type in separate fields', () => {
  const formMatch = html.match(/function getFormData\(\)\s*\{[\s\S]*?\n\}/);
  ok(formMatch, 'getFormData not found');
  ok(formMatch[0].includes("conversionDate: g('f_conversionDate')"), 'conversionDate field missing');
  ok(formMatch[0].includes("conversionPlannedType: g('f_conversionPlannedType')"), 'conversionPlannedType field missing');
});

test('CSV import map and existing feature blocks remain intact', () => {
  const mapMatch = html.match(/const CSV_COL_MAP = \{[\s\S]*?\n\};/);
  ok(mapMatch, 'CSV_COL_MAP not found');
  ok(!mapMatch[0].includes('正社員切替'), 'CSV import map must not include the new export-only column');
  for (const marker of ['JOBTYPE-BEGIN', 'JOBTYPE-END', 'INTAKE-APPROVE-BEGIN', 'INTAKE-APPROVE-END']) {
    equal(html.split(marker).length - 1, 1, `${marker} count`);
  }
  ok(html.includes("row('転換後の予定雇用形態', d.conversionPlannedType)"), 'existing detail row changed');
});

test('all inline scripts have valid syntax', () => {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  let inlineCount = 0;
  for (const [, attributes, source] of scripts) {
    if (/\bsrc\s*=/.test(attributes)) continue;
    new vm.Script(source);
    inlineCount += 1;
  }
  ok(inlineCount > 0, 'no inline scripts found');
});

console.log(`PASS ${passed} / FAIL ${failed}`);
if (failed > 0) process.exit(1);
