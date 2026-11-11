#!/usr/bin/env node
/*
 * src/main.js — CLI (C++ bin/main 대응)
 *   node src/main.js "철수 이번 달 총 62시간, 시급 10,000원 지각 20분"
 *   node src/main.js "영희 80시간 만원" --json
 *   node src/main.js "민수 주 14시간 시급 11,000원 주휴미포함" --xlsx out.xlsx
 */
'use strict';

const fs = require('fs');
const E = require('../include/alba_engine.js');

const EXAMPLES = [
  '철수 이번 달 총 62시간, 시급 10,000원 지각 20분',
  '영희 80시간 만원',
  '민수 주 14시간 시급 11,000원 주휴미포함'
];

function pad(s, n) {
  s = String(s);
  let w = 0;
  for (const ch of s) w += /[\u1100-\uFFDC]/.test(ch) ? 2 : 1;
  return s + ' '.repeat(Math.max(0, n - w));
}

function printSlip(r) {
  console.log('\n┌─ 표준 급여명세서 ─ ' + r.name + ' (' + r.payMonthLabel + ')');
  r.rows.forEach((row) => {
    const amt = (row.sign < 0 && row.amount ? '-' : '') + E.formatWon(row.amount) + '원';
    console.log('│ ' + pad(row.label, 30) + amt.padStart(14) + '   ' + row.formula);
  });
  console.log('└─ ' + r.message + '\n');
}

function main(argv) {
  const args = argv.slice(2);
  let json = false;
  let xlsxPath = null;
  const words = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--xlsx') xlsxPath = args[++i] || 'payroll.xlsx';
    else words.push(args[i]);
  }
  const text = words.join(' ').trim();

  const inputs = text ? [text] : EXAMPLES;
  if (!text) console.log('사용법: node src/main.js "<한 줄 문장>" [--json] [--xlsx 파일.xlsx]\n예시 3건을 정산합니다.');

  const results = inputs.map((t) => {
    const parsed = E.parseText(t);
    const input = {
      name: parsed.name,
      hourlyWage: parsed.hourlyWage || 10320,
      mode: parsed.mode || 'total',
      totalHours: parsed.totalHours || 0,
      weekHours: parsed.weekHours || [0, 0, 0, 0],
      lateMinutes: parsed.lateMinutes,
      includeWeekly: parsed.includeWeekly,
      tax: parsed.tax || '3.3'
    };
    return E.calculatePayroll(input);
  });

  if (json) console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  else results.forEach(printSlip);

  if (xlsxPath) {
    const bytes = results.length === 1 ? E.payrollSlipXlsx(results[0]) : E.payrollRosterXlsx(results);
    fs.writeFileSync(xlsxPath, Buffer.from(bytes));
    console.log('엑셀 저장: ' + xlsxPath + ' (' + bytes.length + ' bytes)');
  }
}

if (require.main === module) main(process.argv);
module.exports = { main };
