#!/usr/bin/env node
/*
 * tests/test_main.js — 계산·자연어 파서·급여(일별 시간/식대 포함)·체크리스트·XLSX 단위 테스트
 */
'use strict';

const assert = require('assert');
const E = require('../include/alba_engine.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

console.log('=== [1] math_ops & parser 단위 테스트 ===');

test('시급 한글 표현 모두 인식 (10,000원 / 10000원 / 만원 / 1만원 / 1만 500원 / 1.2만원 / 만오천원)', () => {
  assert.strictEqual(E.parseKoreanAmount('10,000원'), 10000);
  assert.strictEqual(E.parseKoreanAmount('10000원'), 10000);
  assert.strictEqual(E.parseKoreanAmount('만원'), 10000);
  assert.strictEqual(E.parseKoreanAmount('1만원'), 10000);
  assert.strictEqual(E.parseKoreanAmount('1만 500원'), 10500);
  assert.strictEqual(E.parseKoreanAmount('1.2만원'), 12000);
  assert.strictEqual(E.parseKoreanAmount('만오천원'), 15000);
});

test('한 줄 자연어 파서 예시 4종 (일별 시간 및 식대 포함) 정확도 검증', () => {
  const p1 = E.parseText('철수 이번 달 총 62시간, 시급 10,000원 지각 20분');
  assert.strictEqual(p1.name, '철수');
  assert.strictEqual(p1.mode, 'total');
  assert.strictEqual(p1.totalHours, 62);
  assert.strictEqual(p1.hourlyWage, 10000);
  assert.strictEqual(p1.lateMinutes, 20);
  assert.strictEqual(p1.includeWeekly, true);

  const p2 = E.parseText('영희 80시간 만원');
  assert.strictEqual(p2.name, '영희');
  assert.strictEqual(p2.totalHours, 80);
  assert.strictEqual(p2.hourlyWage, 10000);

  const p3 = E.parseText('민수 주 14시간 시급 11,000원 주휴미포함');
  assert.strictEqual(p3.name, '민수');
  assert.strictEqual(p3.mode, 'weekly');
  assert.deepStrictEqual(p3.weekHours, [14, 14, 14, 14]);
  assert.strictEqual(p3.hourlyWage, 11000);
  assert.strictEqual(p3.includeWeekly, false);

  const p4 = E.parseText('지민 평일 5시간 시급 10,500원 4시간 이상 식대 8,000원');
  assert.strictEqual(p4.name, '지민');
  assert.strictEqual(p4.mode, 'daily');
  assert.strictEqual(p4.totalHours, 100);
  assert.strictEqual(p4.hourlyWage, 10500);
  assert.strictEqual(p4.includeMeal, true);
  assert.strictEqual(p4.mealMinHours, 4);
  assert.strictEqual(p4.mealAmount, 8000);
});

console.log('=== [2] 급여·주휴수당·일별 시간·식대·세금 정산 공식 테스트 ===');

test('철수 62시간(주 15.5h), 시급 10,000원, 지각 20분, 주휴 포함, 3.3% 세금', () => {
  const r = E.calculatePayroll({
    name: '철수',
    hourlyWage: 10000,
    mode: 'total',
    totalHours: 62,
    lateMinutes: 20,
    includeWeekly: true,
    tax: '3.3'
  });
  assert.strictEqual(r.basePay, 620000);
  assert.strictEqual(r.weeklyAllowance, 124000);
  assert.strictEqual(r.lateDeduction, 3333);
  assert.strictEqual(r.gross, 740667);
  assert.strictEqual(r.tax.total, 24440);
  assert.strictEqual(r.net, 716227);
});

test('일별(매일) 근무시간 입력 + 일정시간(4h) 이상 근무 시 식대 자동 지급 검증', () => {
  // 4주 동안 월~수 5시간(식대 대상 3일/주 = 총 12일), 목~금 3시간(4h 미만 식대 미대상 2일/주 = 8일), 주말 0시간
  // 주별 합계 = 5*3 + 3*2 = 21시간 (15h 이상이므로 주휴수당 대상!)
  const dailyHours = [];
  for (let w = 0; w < 4; w++) {
    dailyHours.push(5, 5, 5, 3, 3, 0, 0);
  }
  const r = E.calculatePayroll({
    name: '지민',
    hourlyWage: 10000,
    mode: 'daily',
    dailyHours,
    includeWeekly: true,
    includeMeal: true,
    mealMinHours: 4,
    mealAmount: 8000,
    tax: 'none'
  });
  assert.strictEqual(r.totalHours, 84); // 21h * 4주
  assert.strictEqual(r.workDays, 20);   // 5일 * 4주
  assert.strictEqual(r.mealDays, 12);   // 4시간 이상 근무한 날만 3일 * 4주 = 12일
  assert.strictEqual(r.mealAllowance, 96000); // 12일 * 8,000원
  assert.strictEqual(r.basePay, 840000);
  assert.strictEqual(r.weeklyAllowance, 168000); // (21/40)*8*10000 = 42,000 * 4주
  assert.strictEqual(r.gross, 840000 + 168000 + 96000);
  assert.strictEqual(r.net, 1104000);
});

test('주휴수당 포함 체크 해제 시 주휴수당 0원', () => {
  const r = E.calculatePayroll({
    name: '영희',
    hourlyWage: 10000,
    mode: 'total',
    totalHours: 80,
    includeWeekly: false,
    tax: 'none'
  });
  assert.strictEqual(r.weeklyAllowance, 0);
  assert.strictEqual(r.gross, 800000);
  assert.strictEqual(r.net, 800000);
});

test('4대보험 공제 10원 미만 절사 검증', () => {
  const r = E.calculatePayroll({
    name: '민수',
    hourlyWage: 10000,
    mode: 'total',
    totalHours: 100,
    includeWeekly: false,
    tax: '4ins'
  });
  assert.strictEqual(r.tax.total, 94040);
  assert.strictEqual(r.net, 905960);
});

console.log('=== [3] 위생·소방 9대 체크리스트 & .xlsx 생성 테스트 ===');

test('법정 9대 점검 항목 적합/점검필요 판정', () => {
  const c1 = E.buildChecklist({
    store: '행복분식',
    date: '2026-11-11',
    inspector: '김사장',
    fridgeTemp: 3.0,
    freezerTemp: -18.5,
    check1: true,
    check2: true,
    check3: true
  });
  assert.strictEqual(c1.total, 9);
  assert.strictEqual(c1.passCount, 9);
  assert.strictEqual(c1.allPass, true);

  const c2 = E.buildChecklist({
    store: '행복분식',
    fridgeTemp: 8.0,
    freezerTemp: -18.5,
    check1: true,
    check2: true,
    check3: false
  });
  assert.strictEqual(c2.allPass, false);
  assert.strictEqual(c2.failCount, 4);
});

test('순수 JS OpenXML .xlsx ZIP 시그니처(PK\\x03\\x04) 검증', () => {
  const r = E.calculatePayroll({ name: '철수', hourlyWage: 10000, totalHours: 60, includeMeal: true, mealDays: 15, mealAmount: 8000 });
  const bytes = E.payrollSlipXlsx(r);
  assert.strictEqual(bytes[0], 0x50);
  assert.strictEqual(bytes[1], 0x4b);
  assert.strictEqual(bytes[2], 0x03);
  assert.strictEqual(bytes[3], 0x04);
  assert.ok(bytes.length > 1500);
});

console.log('\n총 ' + passed + '개 단위 테스트 통과!\n');
