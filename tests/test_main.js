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

test('월별 실제 달력 주차(buildMonthCalendar) & 출퇴근 시각(calcShiftHours / dailyShifts) 검증', () => {
  // 2026-11: 11월 1일(일) ~ 11월 30일(월) -> 총 30일, 월~일 기준 6개 주차에 걸침
  const calNov = E.buildMonthCalendar('2026-11');
  assert.strictEqual(calNov.daysInMonth, 30);
  assert.strictEqual(calNov.weekCount, 6);
  assert.strictEqual(calNov.days[0].dayName, '일');
  assert.strictEqual(calNov.days[29].dayName, '월');

  // 출퇴근 시각 -> 근무시간 계산 (휴게시간 및 야간 자정 넘김 포함)
  assert.strictEqual(E.calcShiftHours('09:30', '14:30', 0), 5);
  assert.strictEqual(E.calcShiftHours('09:00', '18:00', 60), 8);
  assert.strictEqual(E.calcShiftHours('22:00', '02:00', 0), 4);

  // dailyShifts 배열로 2026-11 평일 09:00~14:00(5h) 근무 정산
  const shifts = calNov.days.map((d) => ({
    off: d.isWeekend,
    start: '09:00',
    end: '14:00',
    breakMinutes: 0
  }));
  const r = E.calculatePayroll({
    name: '현우',
    payMonth: '2026-11',
    hourlyWage: 10000,
    mode: 'daily',
    dailyShifts: shifts,
    includeWeekly: true,
    includeMeal: true,
    mealMinHours: 4,
    mealAmount: 8000,
    tax: 'none'
  });
  // 2026년 11월 평일 수 = 21일 -> 총 105시간, 식대 21일
  assert.strictEqual(r.workDays, 21);
  assert.strictEqual(r.totalHours, 105);
  assert.strictEqual(r.mealDays, 21);
  assert.strictEqual(r.weeks.length, 6);
});

test('주 5일 약속인데 4일만 출근한 주는 주휴수당 없음 (일별 모드)', () => {
  // 4주 모두 월~목 5시간(4일 = 20시간, 15h 이상이지만 약속한 5일 미충족) -> 주휴 0원
  const dailyHours = [];
  for (let w = 0; w < 4; w++) dailyHours.push(5, 5, 5, 5, 0, 0, 0);
  const base = { name: '현수', hourlyWage: 10000, mode: 'daily', dailyHours, includeWeekly: true, tax: 'none' };
  const absent = E.calculatePayroll(Object.assign({ contractDays: 5 }, base));
  assert.strictEqual(absent.weeklyAllowance, 0);
  assert.ok(absent.weeks.every((w) => w.absent && !w.eligible && w.hoursOk && w.workDays === 4));
  // 약속일수를 4일로 하면 개근이므로 주휴 지급
  const ok = E.calculatePayroll(Object.assign({ contractDays: 4 }, base));
  assert.ok(ok.weeklyAllowance > 0);
  assert.ok(ok.weeks.every((w) => w.eligible && !w.absent));
  // 기본값(5일)은 contractDays 생략과 동일
  assert.strictEqual(E.calculatePayroll(base).weeklyAllowance, 0);
});

test('결근이 있어도 그 주만 "주휴 지급"으로 예외 처리 가능 (공휴일·사장님 사정)', () => {
  const dailyHours = [];
  for (let w = 0; w < 4; w++) dailyHours.push(5, 5, 5, 5, 0, 0, 0);
  const r = E.calculatePayroll({
    name: '현수', hourlyWage: 10000, mode: 'daily', dailyHours, includeWeekly: true, tax: 'none',
    contractDays: 5, weekExcuse: [false, true, false, false]
  });
  assert.strictEqual(r.weeks[1].excused, true);
  assert.strictEqual(r.weeks[1].eligible, true);
  assert.ok(r.weeks[1].allowance > 0);
  assert.strictEqual(r.weeks[0].allowance, 0);
  assert.strictEqual(r.weeklyAllowance, r.weeks[1].allowance);
});

test('주차별 모드: 주별 "결근 있음" 체크한 주는 주휴 제외, 15h 미만 사유와 구분', () => {
  const r = E.calculatePayroll({
    name: '민아', hourlyWage: 10000, mode: 'weekly', weekHours: [20, 20, 10, 20], includeWeekly: true, tax: 'none',
    weekAbsent: [false, true, false, false]
  });
  assert.strictEqual(r.weeks[0].eligible, true);
  assert.strictEqual(r.weeks[1].eligible, false);
  assert.strictEqual(r.weeks[1].hoursOk, true);   // 시간은 충족, 결근 때문에 제외
  assert.strictEqual(r.weeks[2].hoursOk, false);  // 15h 미만
  assert.ok(/결근 제외/.test(r.rows.find((x) => x.label === '주휴수당').detail));
});

test('월 경계의 7일 미만 주는 결근 판정에서 제외 (15시간 조건만 적용)', () => {
  const r = E.calculatePayroll({
    name: '월경계', hourlyWage: 10000, mode: 'daily', includeWeekly: true, tax: 'none', contractDays: 5,
    payMonth: '2026-11',
    dailyShifts: Array.from({ length: 30 }, () => ({ off: false, start: '09:00', end: '14:00', breakMinutes: 0 }))
  });
  // 2026-11: 1주차(11/1 일요일 1일), 6주차(11/30 월요일 1일)는 7일 미만
  assert.strictEqual(r.weeks[0].partial, true);
  assert.strictEqual(r.weeks[0].absent, false);
  assert.strictEqual(r.weeks[r.weeks.length - 1].partial, true);
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

test('급여 엑셀: 요약/급여명세서/출퇴근 기록/주차별 요약 탭 구성과 출퇴근·약속일수·식대 내용', () => {
  const shifts = [];
  for (let d = 1; d <= 30; d++) {
    const dow = new Date(2026, 10, d).getDay();
    const work = dow >= 1 && dow <= 5 && d !== 10; // 11/10(화) 결근
    shifts.push({ off: !work, start: '09:00', end: '14:00', breakMinutes: 0 });
  }
  const r = E.calculatePayroll({
    name: '철수', hourlyWage: 10320, mode: 'daily', payMonth: '2026-11', dailyShifts: shifts,
    includeWeekly: true, includeMeal: true, mealMinHours: 4, mealAmount: 8000, tax: '3.3', contractDays: 5
  });
  const sheets = E.payrollSheets(r);
  assert.deepStrictEqual(sheets.map((x) => x.name), ['요약', '급여명세서', '출퇴근 기록', '주차별 요약']);
  const text = (sh) => sh.rows.map((row) => row.map((c) => (c && typeof c === 'object' ? c.v : c)).join('|')).join('\n');
  assert.ok(/주 5일 근무 약속/.test(text(sheets[0])));
  assert.ok(/09:00\|14:00/.test(text(sheets[2])));          // 출근·퇴근 시각
  assert.ok(/11\/10\|화\|3주차\|-\|-/.test(text(sheets[2]))); // 휴무일 표시
  assert.ok(/지급/.test(text(sheets[2])));                   // 식대 지급 여부
  assert.ok(/제외 \(결근\)/.test(text(sheets[3])));          // 4/5일 출근한 주
  assert.ok(/대상 \(개근\)/.test(text(sheets[3])));
  // 날짜별 입력이 아니면 출퇴근 기록 탭은 생략
  const r2 = E.calculatePayroll({ name: '영희', hourlyWage: 10000, mode: 'weekly', weekHours: [20, 20, 20, 20] });
  assert.deepStrictEqual(E.payrollSheets(r2).map((x) => x.name), ['요약', '급여명세서', '주차별 요약']);
  // 정산 명단 통합 파일: 명단 탭 + 사람별 탭
  const bytes = E.payrollRosterXlsx([r, r2]);
  assert.strictEqual(bytes[0], 0x50);
  assert.ok(bytes.length > 3000);
});

test('정산 명단 엑셀: 월별 탭(정산/근무기록/주휴판정) + 전체 요약, 사람이 늘어도 탭 수 고정, 총 근무일수·시간 합계', () => {
  const mk = (name, month, offDays, extra) => {
    const n = new Date(2026, Number(month.slice(5)), 0).getDate();
    const shifts = [];
    for (let d = 1; d <= n; d++) {
      const dow = new Date(2026, Number(month.slice(5)) - 1, d).getDay();
      shifts.push({ off: !(dow >= 1 && dow <= 5) || offDays.includes(d), start: '09:00', end: '14:00', breakMinutes: 0 });
    }
    return E.calculatePayroll(Object.assign({ name, hourlyWage: 10000, mode: 'daily', payMonth: month, dailyShifts: shifts,
      includeWeekly: true, includeMeal: true, mealAmount: 8000, tax: 'none' }, extra || {}));
  };
  const list = [mk('철수', '2026-10', []), mk('영희', '2026-10', [8]), mk('철수', '2026-11', [10]), mk('영희', '2026-11', []), mk('민수', '2026-11', [])];
  const sheets = E.payrollRosterSheets(list);
  assert.deepStrictEqual(sheets.map((x) => x.name),
    ['전체 요약', '2026-10 정산', '2026-10 근무기록', '2026-10 주휴판정', '2026-11 정산', '2026-11 근무기록', '2026-11 주휴판정']);
  const text = (sh) => sh.rows.map((row) => row.map((c) => (c && typeof c === 'object' ? c.v : c)).join('|')).join('\n');
  // 11월 근무기록: 한 날짜(11/2)에 3명이 출근한 기록과 그날 인원/시간
  const att = text(sheets[5]);
  assert.ok(/11\/2\|월\|2주차\|민수\|09:00\|14:00/.test(att));
  assert.ok(/3명\|15/.test(att));
  assert.ok(/■ 사람별 합계/.test(att));
  // 정산 탭의 합계: 근무일수 = 사람별 출근일수의 합
  const days11 = list.filter((r) => r.payMonth === '2026-11').reduce((s, r) => s + r.workDays, 0);
  assert.ok(new RegExp('합계\\|3명\\|\\|\\|' + days11 + '일').test(text(sheets[4])));
  // 전체 요약: 월별 + 전체 합계 총 근무일수
  const totalDays = list.reduce((s, r) => s + r.workDays, 0);
  assert.ok(text(sheets[0]).indexOf('전체 합계||' + totalDays + '일') >= 0);
  // 사람이 더 늘어도 탭 수는 그대로
  assert.strictEqual(E.payrollRosterSheets(list.concat([mk('지수', '2026-11', [])])).length, 7);
  assert.strictEqual(E.rosterFileName(list), '알바_정산명단_2026-10~2026-11_5명.xlsx');
});

console.log('\n총 ' + passed + '개 단위 테스트 통과!\n');
