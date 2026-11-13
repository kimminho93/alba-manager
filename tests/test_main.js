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

test('식대: 점심/저녁 시간대에 따라 자동 체크, 둘 다 걸치면 하루 2회, 직접 고친 날은 그대로, 기준시간 미달이면 없음', () => {
  const sh = (start, end, extra) => Object.assign({ off: false, start, end, breakMinutes: 0 }, extra || {});
  const m = (s, e) => E.mealsForShift(sh(s, e), 4);
  assert.deepStrictEqual([m('09:00', '14:00').lunch, m('09:00', '14:00').dinner], [true, false]);
  assert.deepStrictEqual([m('14:00', '19:00').lunch, m('14:00', '19:00').dinner], [false, true]);
  assert.deepStrictEqual([m('11:00', '21:00').lunch, m('11:00', '21:00').dinner], [true, true]);   // 풀타임: 점심·저녁 모두
  assert.deepStrictEqual([m('22:00', '03:00').lunch, m('22:00', '03:00').dinner], [false, true]);  // 야간: 시간대 안 겹쳐도 한 번 (저녁)
  assert.deepStrictEqual([m('06:00', '11:00').lunch, m('06:00', '11:00').dinner], [true, false]);  // 이른 근무: 한 번 (점심)
  assert.deepStrictEqual([m('09:00', '12:59').lunch, m('09:00', '12:59').dinner], [false, false]); // 4시간 미만
  // 직접 고침: 풀타임이지만 저녁은 제외 / 기준 미달이어도 직접 체크하면 인정
  const mm = E.mealsForShift(sh('11:00', '21:00', { meals: ['L'] }), 4);
  assert.deepStrictEqual([mm.lunch, mm.dinner, mm.manual], [true, false, true]);
  assert.strictEqual(E.mealsForShift(sh('09:00', '12:00', { meals: ['L'] }), 4).lunch, true);
  assert.strictEqual(E.mealsForShift({ off: true, start: '09:00', end: '14:00', breakMinutes: 0, meals: ['L', 'D'] }, 4).lunch, false);

  // 한 달 계산: 2일 풀타임(점심+저녁), 3일은 4시간 근무 → 끼니 수로 센다
  const shifts = [];
  for (let d = 1; d <= 30; d++) shifts.push({ off: d !== 2 && d !== 3, start: d === 2 ? '06:00' : '09:00', end: d === 2 ? '23:00' : '13:00', breakMinutes: 0 });
  const calc = (list) => E.calculatePayroll({ name: '식대', hourlyWage: 10000, mode: 'daily', payMonth: '2026-11', dailyShifts: list,
    includeMeal: true, mealMinHours: 4, mealAmount: 8000, tax: 'none' });
  const r = calc(shifts);
  assert.strictEqual(r.mealDays, 3);          // 2일: 점심+저녁 2회, 3일: 점심 1회
  assert.strictEqual(r.mealAllowance, 24000);
  assert.strictEqual(r.days[1].mealCount, 2);
  assert.deepStrictEqual(r.days[1].meals, { lunch: true, dinner: true });
  // 2일의 저녁을 직접 뺌 → 2회
  shifts[1] = Object.assign({}, shifts[1], { meals: ['L'] });
  assert.strictEqual(calc(shifts).mealDays, 2);
  // 기준(4시간)에 못 미치면 자동으로는 없음
  shifts[1] = { off: false, start: '06:00', end: '23:00', breakMinutes: 0 };
  shifts[2] = { off: false, start: '09:00', end: '12:59', breakMinutes: 0 };
  assert.strictEqual(calc(shifts).mealDays, 2);
  // 식사 시간대 설정을 바꾸면 자동 판정도 바뀜
  try {
    E.setMealTimes({ lunchStart: '12:00', lunchEnd: '15:00' });
    assert.strictEqual(E.mealsForShift(sh('09:00', '13:00'), 4).lunch, true);     // 12~13시 1시간 겹침
    assert.strictEqual(E.mealsForShift(sh('09:00', '12:30'), 4).lunch, false);    // 3.5시간 근무라 기준시간(4시간) 미달
  } finally { E.setMealTimes({}); }
});

test('식대 직접 고침은 알바생 월 기록에 저장되고 백업 후에도 유지됨', () => {
  const w = E.createWorker('철수', 5, 10000);
  const shifts = E.emptyShifts('2026-11');
  shifts[0] = { off: false, start: '11:00', end: '21:00', breakMinutes: 0, meals: ['L'] };
  shifts[1] = { off: false, start: '11:00', end: '21:00', breakMinutes: 0 };
  E.setRecord(w, '2026-11', { wage: 10000, dailyShifts: shifts });
  assert.deepStrictEqual(w.months['2026-11'].dailyShifts[0].meals, ['L']);
  assert.strictEqual(w.months['2026-11'].dailyShifts[1].meals, undefined);
  const back = E.parseBackup(E.buildBackup({ workers: [w], archive: [], presets: [], store: {} }));
  assert.deepStrictEqual(back.data.workers[0].months['2026-11'].dailyShifts[0].meals, ['L']);
  const r = E.calculatePayroll(E.workerPayrollInput(back.data.workers[0], '2026-11'));
  assert.strictEqual(r.mealDays, 3);   // 1일 점심 1회 + 2일 점심·저녁 2회
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

console.log('=== [3] 위생 점검 41개 항목 체크리스트 & .xlsx 생성 테스트 ===');

test('위생 점검 41개 항목 적합/점검필요 판정', () => {
  const all = Array.from({ length: 41 }, (_, i) => i + 1);
  const c1 = E.buildChecklist({
    store: '행복분식', date: '2026-11-11', inspector: '김사장',
    fridgeTemp: 3.0, freezerTemp: -18.5, checks: all
  });
  assert.strictEqual(c1.total, 41);
  assert.strictEqual(c1.passCount, 41);
  assert.strictEqual(c1.allPass, true);
  assert.strictEqual(c1.items[0].no, 1);
  assert.strictEqual(c1.items[40].no, 41);
  assert.ok(c1.items[0].text.indexOf('소비기한') >= 0);
  assert.ok(c1.items[40].text.indexOf('산가페이퍼') >= 0);

  // 3개 항목만 체크 → 나머지는 점검필요
  const c2 = E.buildChecklist({ checks: [1, 2, 3] });
  assert.strictEqual(c2.passCount, 3);
  assert.strictEqual(c2.failCount, 38);
  assert.strictEqual(c2.allPass, false);

  // 20번(냉장·냉동 온도)은 체크해도 온도가 기준을 벗어나면 점검필요
  const c3 = E.buildChecklist({ fridgeTemp: 8.0, freezerTemp: -18.5, checks: all });
  assert.strictEqual(c3.failCount, 1);
  assert.strictEqual(c3.items[19].ok, false);
  const c4 = E.buildChecklist({ fridgeTemp: 3, freezerTemp: -10, checks: all });
  assert.strictEqual(c4.items[19].ok, false);

  // 범위 밖/중복 번호는 무시
  const c5 = E.buildChecklist({ checks: [1, 1, 0, 42, 'x', 5] });
  assert.deepStrictEqual(c5.input.checks, [1, 5]);
});

test('위생 점검 엑셀: 41개 항목 전부 시트에 포함', () => {
  const c = E.buildChecklist({ store: '행복분식', checks: [1, 2] });
  const sh = E.checklistSheet(c);
  const text = JSON.stringify(sh.rows);
  assert.ok(text.indexOf('산가페이퍼') >= 0);
  assert.ok(text.indexOf('소방') < 0 && text.indexOf('소화기') < 0);
  assert.ok(E.checklistFileName(c).indexOf('위생점검표_') === 0);
  const bytes = E.checklistXlsx(c);
  assert.strictEqual(bytes[0], 0x50);
});

test('알바생 기록: 기록 없는 달은 빈 달력(0시간)·지난 달 설정 이어받기·시급은 그 달부터 적용', () => {
  const w = E.createWorker('홍길동', 5, 10320);
  assert.strictEqual(w.name, '홍길동');
  assert.deepStrictEqual(w.months, {});
  // 기록이 없으면 전부 휴무 → 0시간·0원
  const r0 = E.calculatePayroll(E.workerPayrollInput(w, '2026-11'));
  assert.strictEqual(r0.totalHours, 0);
  assert.strictEqual(r0.net, 0);
  assert.strictEqual(E.emptyShifts('2026-11').length, 30);

  // 10월에 평일 5시간 근무 기록 저장
  const shifts = E.emptyShifts('2026-10').map((s, i) => {
    const dow = new Date(2026, 9, i + 1).getDay();
    return dow >= 1 && dow <= 5 ? { off: false, start: '09:00', end: '14:00', breakMinutes: 0 } : s;
  });
  E.setRecord(w, '2026-10', { wage: 10320, contractDays: 5, includeWeekly: true, includeMeal: true, mealMinHours: 4, mealAmount: 8000, tax: '3.3', dailyShifts: shifts, weekExcuse: [] });
  const oct = E.calculatePayroll(E.workerPayrollInput(w, '2026-10'));
  assert.ok(oct.totalHours > 100);

  // 11월은 기록이 없으니 근무는 0이지만 시급·식대 설정은 10월 것을 이어받음
  const st = E.workerSettings(w, '2026-11');
  assert.strictEqual(st.wage, 10320);
  assert.strictEqual(st.mealAmount, 8000);
  assert.strictEqual(E.calculatePayroll(E.workerPayrollInput(w, '2026-11')).totalHours, 0);

  // 11월에 시급을 올리면 11월부터 적용되고 10월은 그대로
  E.setRecord(w, '2026-11', { wage: 11000, contractDays: 5, includeWeekly: true, includeMeal: true, mealMinHours: 4, mealAmount: 8000, tax: '3.3', dailyShifts: E.emptyShifts('2026-11'), weekExcuse: [] });
  assert.strictEqual(w.months['2026-10'].wage, 10320);
  assert.strictEqual(w.months['2026-11'].wage, 11000);
  // 12월 기록이 이미 있었다면 11월 이후이므로 새 시급으로 맞춰짐
  E.setRecord(w, '2026-12', { wage: 11000, dailyShifts: E.emptyShifts('2026-12') });
  E.setRecord(w, '2026-11', { wage: 12000, dailyShifts: E.emptyShifts('2026-11') });
  assert.strictEqual(w.months['2026-12'].wage, 12000);
  assert.strictEqual(w.months['2026-10'].wage, 10320);
  assert.deepStrictEqual(E.recordMonths([w]), ['2026-10', '2026-11', '2026-12']);
});

test('알바생 고유 코드: 새로 만들면 자동 부여, 서로 겹치지 않고, 백업·정리 후에도 유지, 없던 사람은 채움', () => {
  const a = E.createWorker('가', 5, 10320), b = E.createWorker('나', 5, 10320);
  assert.ok(/^[A-HJ-NP-Z2-9]{8}$/.test(a.code), a.code);
  assert.notStrictEqual(a.code, b.code);
  const kept = E.normalizeWorkers([a, b]);
  assert.strictEqual(kept[0].code, a.code);
  assert.strictEqual(kept[1].code, b.code);
  // 같은 코드가 두 번 있으면 뒤 사람 코드를 새로 부여
  const dup = E.normalizeWorkers([a, Object.assign({}, b, { code: a.code })]);
  assert.notStrictEqual(dup[0].code, dup[1].code);
  // 코드가 없던 예전 데이터에는 새로 채움
  const old = E.normalizeWorkers([{ id: 'x1', name: '옛날', contractDays: 5, wage: 10000, months: {} }]);
  assert.ok(/^[A-Z0-9]{8}$/.test(old[0].code));
  // 백업 왕복
  const back = E.parseBackup(E.buildBackup({ workers: [a], archive: [], presets: [], store: {}, settings: {} }, new Date()));
  assert.strictEqual(back.data.workers[0].code, a.code);
});

test('알바생 비밀번호: 정리(앞뒤 공백 제거, 20자), 비어 있으면 저장 안 함, 백업 왕복', () => {
  const w = E.createWorker('가', 5, 10320);
  w.password = '  1234  ';
  const kept = E.normalizeWorkers([w, Object.assign({}, E.createWorker('나', 5, 10320), { password: '   ' })]);
  assert.strictEqual(kept[0].password, '1234');
  assert.strictEqual(kept[1].password, undefined);
  assert.strictEqual(E.cleanPassword('a'.repeat(30)).length, 20);
  const back = E.parseBackup(E.buildBackup({ workers: kept, archive: [], presets: [], store: {}, settings: {} }, new Date()));
  assert.strictEqual(back.data.workers[0].password, '1234');
});

test('예전 정산 명단(이름+달 한 줄씩) → 알바생별 월 기록으로 자동 변환', () => {
  const sh = (end) => E.emptyShifts('2026-11').map((s, i) => (i < 5 ? { off: false, start: '09:00', end, breakMinutes: 0 } : s));
  const old = [
    { name: '철수', payMonth: '2026-10', hourlyWage: 10000, dailyShifts: E.emptyShifts('2026-10'), includeMeal: true, mealAmount: 7000 },
    { name: '철수', payMonth: '2026-11', hourlyWage: 10320, dailyShifts: sh('14:00'), contractDays: 4 },
    { name: '철수', payMonth: '2026-11', hourlyWage: 10320, dailyShifts: sh('15:00'), contractDays: 4 },   // 같은 달 중복 → 마지막 것
    { name: '영희', payMonth: '2026-11', hourlyWage: 11000, dailyShifts: sh('14:00') },
    '깨진항목', { name: '', payMonth: '2026-11' }
  ];
  const ws = E.migrateRoster(old);
  assert.strictEqual(ws.length, 2);
  const c = ws.find((w) => w.name === '철수');
  assert.deepStrictEqual(Object.keys(c.months).sort(), ['2026-10', '2026-11']);
  assert.strictEqual(c.months['2026-11'].dailyShifts[0].end, '15:00');
  assert.strictEqual(c.months['2026-10'].wage, 10000);
  assert.strictEqual(c.wage, 10320);            // 가장 최근 달 기준 기본값
  assert.strictEqual(c.contractDays, 4);
  assert.ok(typeof c.id === 'string' && c.id.length > 3);
});

test('구글 시트 월별 탭 보관 기간: 이번 달 포함 60개월', () => {
  assert.strictEqual(E.retentionCutoff(new Date(2026, 10, 12).getTime()), '2021-12');
  assert.strictEqual(E.retentionCutoff(new Date(2026, 0, 5).getTime()), '2021-02');
});

test('백업 파일: 내려받기 → 불러오기로 기록이 그대로 복원되고, 엉뚱한 파일은 거절', () => {
  const w = E.createWorker('철수', 5, 10000);
  E.setRecord(w, '2026-11', { wage: 10000, dailyShifts: E.emptyShifts('2026-11') });
  const workers = [w];
  const archive = [{ store: '행복분식', date: '2026-11-12', inspector: '김사장', checks: [1, 2, 3] }];
  const presets = [{ name: '오전', start: '09:00', end: '14:00', breakMin: 0 }];
  const text = E.buildBackup({ workers, archive, presets, store: { store: '행복분식', inspector: '김사장' } }, Date.UTC(2026, 10, 12, 8, 0, 0));
  assert.ok(E.backupFileName(new Date(2026, 10, 12).getTime()).indexOf('사장님도우미_백업_2026-11-12') === 0);
  const r = E.parseBackup(text);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.counts.workers, 1);
  assert.strictEqual(r.counts.archive, 1);
  assert.deepStrictEqual(r.data.workers, workers);
  assert.deepStrictEqual(r.data.archive, archive);
  assert.strictEqual(r.data.store.store, '행복분식');
  assert.strictEqual(r.data.presets.length, 1);

  assert.strictEqual(E.parseBackup('').ok, false);
  assert.strictEqual(E.parseBackup('안녕하세요').ok, false);
  assert.strictEqual(E.parseBackup('{"app":"other","data":{}}').ok, false);
  assert.strictEqual(E.parseBackup('{"app":"alba-manager","version":99,"data":{}}').ok, false);

  // 예전(버전 1) 백업 파일: 정산 명단이 알바생별 월 기록으로 변환됨
  const roster = [
    { name: '철수', payMonth: '2026-10', hourlyWage: 10000, dailyShifts: E.emptyShifts('2026-10') },
    { name: '철수', payMonth: '2026-11', hourlyWage: 10320, dailyShifts: E.emptyShifts('2026-11') },
    { name: '영희', payMonth: '2026-11', hourlyWage: 11000, dailyShifts: E.emptyShifts('2026-11') }
  ];
  const old = JSON.stringify({ app: 'alba-manager', version: 1, data: { roster, archive: [], presets: [], store: {} } });
  const ro = E.parseBackup(old);
  assert.strictEqual(ro.ok, true);
  assert.strictEqual(ro.counts.workers, 2);
  assert.strictEqual(ro.data.workers.find((x) => x.name === '철수').months['2026-10'].wage, 10000);

  // 일부 항목이 깨져 있으면 그 항목만 제외
  const bad = JSON.stringify({ app: 'alba-manager', version: 2, data: { workers: [w, 'x', null, 5], archive: [], presets: [{ start: 'a', end: 'b' }], store: 3 } });
  const rb = E.parseBackup(bad);
  assert.strictEqual(rb.ok, true);
  assert.strictEqual(rb.counts.workers, 1);
  assert.strictEqual(rb.counts.skipped, 3);
  assert.strictEqual(rb.data.presets.length, 0);
  assert.deepStrictEqual(rb.data.store, { store: '', inspector: '' });
});

test('설정: 세율·보험료율을 바꾸면 공제 계산이 바뀌고, 이상한 값은 기본값으로, 백업에도 포함', () => {
  try {
    assert.strictEqual(E.calcTax('3.3', 1000000).total, 33000);
    E.setRates({ incomeTax: 2, localTax: 10 });
    const t = E.calcTax('3.3', 1000000);
    assert.strictEqual(t.total, 22000);
    assert.ok(t.label.indexOf('2.2%') === 0);
    assert.ok(t.lines[0].label.indexOf('2%') > 0);
    E.setRates({ pension: 5, health: 4, care: 10, employment: 1 });
    const i = E.calcTax('4ins', 1000000);
    assert.strictEqual(i.total, 50000 + 40000 + 4000 + 10000);
    // 이상한 값은 기본값 유지
    const r = E.sanitizeRates({ pension: 'abc', health: -3, care: 500, employment: '' , incomeTax: '2.5'});
    assert.strictEqual(r.pension, 4.5); assert.strictEqual(r.health, 3.545); assert.strictEqual(r.care, 12.95);
    assert.strictEqual(r.incomeTax, 2.5);
    // 설정 + 백업
    assert.strictEqual(E.sanitizeSettings({ mealTimes: { lunchStart: '15:00', lunchEnd: '12:00' } }).mealTimes.lunchStart, '11:00');   // 끝이 시작보다 빠르면 기본값
    const st = E.sanitizeSettings({ minWage: '11000', rates: { pension: 5 } });
    assert.strictEqual(st.minWage, 11000); assert.strictEqual(st.rates.pension, 5);
    assert.strictEqual(E.sanitizeSettings({ minWage: -1 }).minWage, 10320);
    const back = E.parseBackup(E.buildBackup({ workers: [], archive: [], presets: [], store: {}, settings: st }));
    assert.strictEqual(back.data.settings.minWage, 11000);
    assert.strictEqual(back.data.settings.rates.pension, 5);
    // 설정이 없는 예전 백업은 기본값
    const old = E.parseBackup(JSON.stringify({ app: 'alba-manager', version: 1, data: { roster: [] } }));
    assert.strictEqual(old.data.settings.rates.pension, 4.5);
  } finally {
    E.setRates({});   // 다른 테스트에 영향 없도록 처음 값으로
  }
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
  // 11월 근무기록: 한 날짜(11/2)에 3명이 출근한 기록, 개인별 누적 근무일수/시간, 그날 출근 인원
  const att = text(sheets[5]);
  assert.ok(/11\/2\|월\|민수\|09:00\|14:00/.test(att));
  assert.ok(/11\/2\|월\|철수\|09:00\|14:00\|0\|5\|1일\|5\|/.test(att));   // 철수 첫 출근: 누적 1일·5h
  assert.ok(/3명/.test(att));
  assert.ok(!/사람별 합계/.test(att));                                  // 정산 탭과 중복되는 목록은 두지 않음
  // 철수 11월 마지막 행의 누적 = 정산 결과(근무일수·근무시간)
  const cheol = list.find((r) => r.name === '철수' && r.payMonth === '2026-11');
  assert.ok(att.indexOf('|' + cheol.workDays + '일|' + cheol.totalHours + '|') >= 0);
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

test('출퇴근: 출근 → 퇴근이면 그 날 달력 칸에 시각이 그대로 들어가고 일수·누적시간이 계산됨', () => {
  const w = E.createWorker('홍길동', 5, 10320);
  const d = (h, m) => new Date(2026, 10, 12, h, m, 0);   // 2026-11-12
  const a = E.applyPunch(w, d(9, 3));
  assert.strictEqual(a.kind, 'in');
  assert.strictEqual(E.punchIsOpen(w), true);
  assert.deepStrictEqual(E.monthSummary(w, '2026-11'), { workDays: 0, totalHours: 0 });
  const b = E.applyPunch(w, d(18, 33));
  assert.strictEqual(b.kind, 'out');
  assert.strictEqual(E.punchIsOpen(w), false);
  const sh = E.workerShifts(w, '2026-11')[11];
  assert.strictEqual(sh.off, false);
  assert.strictEqual(a.start, '09:30');   // 출근은 30분 단위 올림
  assert.strictEqual(sh.start, '09:30');
  assert.strictEqual(sh.end, '18:30');   // 퇴근은 30분 단위 내림
  const sum = E.monthSummary(w, '2026-11');
  assert.strictEqual(sum.workDays, 1);
  assert.ok(Math.abs(sum.totalHours - 9) < 0.01);
});

test('출근 30분 올림: 정각 유지, 1분이라도 지나면 다음 30분, 올림 전 시각 기준으로 중복 찍기 판단', () => {
  const at = (h, m) => new Date(2026, 10, 12, h, m, 0);
  const t = (h, m) => { const w = E.createWorker('가', 5, 10320); return E.applyPunch(w, at(h, m)).start; };
  assert.strictEqual(t(9, 0), '09:00');
  assert.strictEqual(t(9, 1), '09:30');
  assert.strictEqual(t(9, 30), '09:30');
  assert.strictEqual(t(9, 31), '10:00');
  assert.strictEqual(t(23, 50), '23:59');
  const w = E.createWorker('나', 5, 10320);
  E.applyPunch(w, at(9, 5));                                   // 09:30로 기록
  assert.strictEqual(E.punchNext(w, at(9, 6)), 'out');          // 방금 출근 → 근무 중으로 보임 (올림한 09:30 전이어도)
  assert.strictEqual(E.punchNext(w, at(9, 25)), 'out');
  assert.strictEqual(E.applyPunch(w, at(9, 5)).kind, 'too_soon');   // 1분 안에 또 누름
  assert.strictEqual(E.punchIsOpen(w), true);
  assert.strictEqual(E.applyPunch(w, at(13, 0)).kind, 'out');
});

test('출퇴근 끊기: 출근 올림(08:59→09:00, 09:01→09:30), 퇴근 내림(09:59→09:30, 10:00 이후→10:00), 단위 설정', () => {
  const at = (h, m) => new Date(2026, 10, 12, h, m, 0);
  const inT = (h, m, u) => { const w = E.createWorker('가', 5, 10320); return E.applyPunch(w, at(h, m), u).start; };
  assert.strictEqual(inT(8, 59), '09:00');
  assert.strictEqual(inT(9, 0), '09:00');
  assert.strictEqual(inT(9, 1), '09:30');
  const outT = (h, m, u) => { const w = E.createWorker('가', 5, 10320); E.applyPunch(w, at(8, 50), u); const r = E.applyPunch(w, at(h, m), u); return r.end; };
  assert.strictEqual(outT(9, 59), '09:30');
  assert.strictEqual(outT(10, 0), '10:00');
  assert.strictEqual(outT(10, 29), '10:00');
  assert.strictEqual(outT(10, 30), '10:30');
  // 단위 바꾸기
  assert.strictEqual(inT(9, 1, 15), '09:15');
  assert.strictEqual(inT(9, 1, 60), '10:00');
  assert.strictEqual(inT(9, 1, 1), '09:01');
  assert.strictEqual(outT(10, 29, 15), '10:15');
  assert.strictEqual(outT(10, 29, 1), '10:29');
  assert.strictEqual(outT(10, 59, 60), '10:00');
  // 엉뚱한 단위는 30분으로
  assert.strictEqual(E.sanitizeSettings({ punchUnit: 7 }).punchUnit, 30);
  assert.strictEqual(E.sanitizeSettings({ punchUnit: '15' }).punchUnit, 15);
  assert.strictEqual(E.sanitizeSettings({}).punchUnit, 30);
  // 출근 직후(같은 단위 안) 퇴근하면 근무 0시간, 기록은 남기지 않고 출근만 취소
  const w = E.createWorker('나', 5, 10320);
  E.applyPunch(w, at(9, 5));   // 09:30 기록
  const r = E.applyPunch(w, at(9, 40));   // 내림 09:30 = 출근과 같음
  assert.strictEqual(r.kind, 'out'); assert.strictEqual(r.empty, true);
  assert.strictEqual(E.punchIsOpen(w), false);
  assert.deepStrictEqual(E.monthSummary(w, '2026-11'), { workDays: 0, totalHours: 0 });
});

test('출퇴근 유예: 출근은 (찍은 시각 − 유예)를 올림, 퇴근은 (찍은 시각 + 유예)를 내림, 달력엔 항상 단위 배수', () => {
  const at = (h, m) => new Date(2026, 10, 12, h, m, 0);
  const O = (o) => Object.assign({ unit: 30, inMode: 'round', outMode: 'round', graceIn: 0, graceOut: 0 }, o);
  const inT = (h, m, o) => { const w = E.createWorker('가', 5, 10320); return E.applyPunch(w, at(h, m), O(o)).start; };
  const outT = (h, m, o) => { const w = E.createWorker('가', 5, 10320); E.applyPunch(w, at(8, 0), O(o)); return E.applyPunch(w, at(h, m), O(o)).end; };
  // 출근 유예 0 / 5 / 10 / 15
  [[ '08:59', '09:00', '09:00', '09:00', '09:00' ], [ '09:00', '09:00', '09:00', '09:00', '09:00' ], [ '09:03', '09:30', '09:00', '09:00', '09:00' ],
   [ '09:08', '09:30', '09:30', '09:00', '09:00' ], [ '09:11', '09:30', '09:30', '09:30', '09:00' ], [ '09:16', '09:30', '09:30', '09:30', '09:30' ], [ '09:31', '10:00', '09:30', '09:30', '09:30' ]].forEach(r => {
    const [h, m] = r[0].split(':').map(Number);
    [0, 5, 10, 15].forEach((g, k) => assert.strictEqual(inT(h, m, { graceIn: g }), r[k + 1], '출근 ' + r[0] + ' 유예 ' + g));
  });
  // 퇴근 유예 0 / 5 / 10 / 15
  [[ '17:44', '17:30', '17:30', '17:30', '17:30' ], [ '17:46', '17:30', '17:30', '17:30', '18:00' ], [ '17:52', '17:30', '17:30', '18:00', '18:00' ], [ '17:57', '17:30', '18:00', '18:00', '18:00' ],
   [ '18:00', '18:00', '18:00', '18:00', '18:00' ], [ '18:10', '18:00', '18:00', '18:00', '18:00' ], [ '18:25', '18:00', '18:30', '18:30', '18:30' ], [ '18:31', '18:30', '18:30', '18:30', '18:30' ]].forEach(r => {
    const [h, m] = r[0].split(':').map(Number);
    [0, 5, 10, 15].forEach((g, k) => assert.strictEqual(outT(h, m, { graceOut: g }), r[k + 1], '퇴근 ' + r[0] + ' 유예 ' + g));
  });
  // 찍은 그대로 모드: 유예 무시
  assert.strictEqual(inT(9, 13, { inMode: 'exact', graceIn: 10 }), '09:13');
  assert.strictEqual(outT(17, 48, { outMode: 'exact', graceOut: 10 }), '17:48');
  // 출근만 그대로, 퇴근은 내림
  assert.strictEqual(outT(17, 48, { inMode: 'exact' }), '17:30');
  // 모든 시각(00:00~23:59)·모든 단위·모든 유예에서 성질 확인
  const m2h = x => ('0' + Math.floor(x / 60)).slice(-2) + ':' + ('0' + (x % 60)).slice(-2);
  [5, 10, 15, 20, 30, 60].forEach(U => E.graceChoices(U).forEach(G => {
    let prevIn = -1, prevOut = -1;
    for (let t = 0; t < 1440; t++) {
      const hm = m2h(t);
      const a = E.roundUpUnit(hm, U, G), b = E.roundDownUnit(hm, U, G);
      const am = Number(a.slice(0, 2)) * 60 + Number(a.slice(3)), bm = Number(b.slice(0, 2)) * 60 + Number(b.slice(3));
      const edge = am === 1439 || bm === 1439;
      if (!edge) {
        assert.strictEqual(am % U, 0, '출근은 단위 배수 ' + hm + ' U' + U + ' G' + G);
        assert.strictEqual(bm % U, 0, '퇴근은 단위 배수 ' + hm + ' U' + U + ' G' + G);
        assert.ok(am >= t - G && am < t - G + U, '출근 범위 ' + hm);
        assert.ok(bm <= t + G && bm > t + G - U, '퇴근 범위 ' + hm);
      }
      assert.ok(am >= prevIn && bm >= prevOut, '시각이 늦어지면 결과도 늦어짐(역전 없음) ' + hm);
      prevIn = am; prevOut = bm;
    }
  }));
  // 유예 선택지는 단위의 절반 이하만
  assert.deepStrictEqual(E.graceChoices(30), [0, 5, 10, 15]);
  assert.deepStrictEqual(E.graceChoices(60), [0, 5, 10, 15]);
  assert.deepStrictEqual(E.graceChoices(20), [0, 5, 10]);
  assert.deepStrictEqual(E.graceChoices(15), [0, 5]);
  assert.deepStrictEqual(E.graceChoices(10), [0, 5]);
  assert.deepStrictEqual(E.graceChoices(5), [0]);
  assert.strictEqual(E.sanitizeSettings({ punchUnit: 15, punchGraceIn: 15, punchGraceOut: 10 }).punchGraceIn, 5);   // 15분 단위는 5분까지
  assert.strictEqual(E.sanitizeSettings({ punchUnit: 30, punchGraceOut: 12 }).punchGraceOut, 10);   // 허용 값으로 내림
  // 설정 저장·예전 설정 이어받기
  const st = E.sanitizeSettings({ punchUnit: 30, punchInMode: 'exact', punchOutMode: 'round', punchGraceOut: 5 });
  assert.deepStrictEqual(E.punchOptions(st), { unit: 30, inMode: 'exact', outMode: 'round', graceIn: 0, graceOut: 5 });
  const old = E.sanitizeSettings({ punchUnit: 1 });   // 예전 '끊지 않음'
  assert.deepStrictEqual([old.punchUnit, old.punchInMode, old.punchOutMode], [30, 'exact', 'exact']);
  assert.deepStrictEqual(E.punchOptions(E.sanitizeSettings({})), { unit: 30, inMode: 'round', outMode: 'round', graceIn: 0, graceOut: 0 });
  // 조기 퇴근을 봐줘서 18:00으로 기록돼도, 출근과 같은 시각으로 끊기면 근무 0시간 처리는 그대로
  const w = E.createWorker('나', 5, 10320);
  E.applyPunch(w, at(9, 5), O({ graceIn: 5 }));   // 09:00
  const r = E.applyPunch(w, at(9, 25), O({ graceOut: 5 }));   // 09:30 → 출근(09:00)보다 늦음: 정상 기록
  assert.strictEqual(r.end, '09:30'); assert.strictEqual(r.empty, undefined);
  // 일괄 퇴근·시트 복구 재생에도 같은 규칙
  const a = E.createWorker('가', 5, 10320); E.applyPunch(a, at(9, 3), O({ graceIn: 5 }));
  const done = E.applyPunchAll([a], at(17, 56), O({ graceOut: 5 }));
  assert.strictEqual(done[0].result.start, '09:00'); assert.strictEqual(done[0].result.end, '18:00');
  const a2 = E.createWorker('가', 5, 10320); a2.code = a.code;
  const ts = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':00';
  E.replayPunchLog([a2], [[ts(at(9, 3)), a.code, '가', '출근', '이름+비밀번호', '정상', ''], [ts(at(17, 56)), a.code, '가', '퇴근', '이름+비밀번호', '정상', '']], 0, O({ graceIn: 5, graceOut: 5 }));
  assert.deepStrictEqual([E.workerShifts(a2, '2026-11')[11].start, E.workerShifts(a2, '2026-11')[11].end], ['09:00', '18:00']);
});

test('출퇴근: 유예로 새 출근이 앞선 근무 끝보다 앞당겨져도 앞선 근무를 지우지 않고 이어 붙임', () => {
  const at = (h, m) => new Date(2026, 10, 12, h, m, 0);
  const w = E.createWorker('가', 5, 10320);
  const exactOut = { unit: 30, inMode: 'round', outMode: 'exact', graceIn: 15, graceOut: 0 };
  E.applyPunch(w, at(9, 0), exactOut);   // 09:00
  E.applyPunch(w, at(14, 5), exactOut);   // 14:05 (찍은 그대로)
  E.applyPunch(w, at(14, 12), exactOut);   // 유예 15 → 14:00 (앞선 근무 끝 14:05 보다 이름)
  const r = E.applyPunch(w, at(18, 0), exactOut);
  const sh = E.workerShifts(w, '2026-11')[11];
  assert.deepStrictEqual([sh.start, sh.end, sh.breakMinutes], ['09:00', '18:00', 0]);
  assert.ok(r.note);
  // 새 근무가 앞선 근무 안에 다 들어가도 앞선 근무가 줄어들지 않음
  const w2 = E.createWorker('나', 5, 10320);
  E.applyPunch(w2, at(9, 0), exactOut); E.applyPunch(w2, at(18, 0), exactOut);
  E.applyPunch(w2, at(18, 10), exactOut);   // → 18:00
  E.applyPunch(w2, at(18, 20), exactOut);
  const s2 = E.workerShifts(w2, '2026-11')[11];
  assert.deepStrictEqual([s2.start, s2.end], ['09:00', '18:20']);
});

test('일괄 퇴근: 근무 중인 사람만 한꺼번에 퇴근, 출근 안 한 사람은 그대로, 시트 기록 재생도 같은 결과', () => {
  const at = (h, m) => new Date(2026, 10, 12, h, m, 0);
  const a = E.createWorker('가', 5, 10320), b = E.createWorker('나', 5, 10320), c = E.createWorker('다', 5, 10320);
  E.applyPunch(a, at(9, 0)); E.applyPunch(b, at(13, 5));
  const done = E.applyPunchAll([a, b, c], at(22, 12));
  assert.strictEqual(done.length, 2);
  assert.deepStrictEqual(done.map(d => d.worker.name), ['가', '나']);
  assert.strictEqual(done[0].result.end, '22:00');
  assert.strictEqual(E.punchIsOpen(a) || E.punchIsOpen(b) || E.punchIsOpen(c), false);
  assert.strictEqual(E.workerShifts(a, '2026-11')[11].end, '22:00');
  assert.strictEqual(E.workerShifts(b, '2026-11')[11].start, '13:30');
  assert.strictEqual(E.applyPunchAll([a, b, c], at(22, 13)).length, 0);   // 두 번 눌러도 안전
  // 다른 기기에서 시트 기록으로 복구해도 같은 결과
  const a2 = E.createWorker('가', 5, 10320); a2.code = a.code;
  const ts = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':00';
  const rows = [[ts(at(9, 0)), a.code, '가', '출근', '이름+비밀번호', '정상', ''], [ts(at(22, 12)), a.code, '가', '퇴근', '일괄 퇴근(관리자)', '정상', '']];
  assert.strictEqual(E.replayPunchLog([a2], rows, 0, 30), 2);
  assert.strictEqual(E.workerShifts(a2, '2026-11')[11].end, '22:00');
});

test('출퇴근: 1분 안에 다시 찍으면 무시, 출근 후 16시간이 넘으면 퇴근 누락으로 보고 새 출근', () => {
  const w = E.createWorker('김철수', 5, 10320);
  E.applyPunch(w, new Date(2026, 10, 12, 9, 0, 0));
  assert.strictEqual(E.applyPunch(w, new Date(2026, 10, 12, 9, 0, 30)).kind, 'too_soon');
  assert.strictEqual(E.punchIsOpen(w), true);
  const r = E.applyPunch(w, new Date(2026, 10, 13, 10, 0, 0));   // 25시간 뒤
  assert.strictEqual(r.kind, 'in');
  assert.ok(r.note.indexOf('무시') >= 0);
  assert.deepStrictEqual(w.punch, { date: '2026-11-13', time: '10:00', at: '10:00' });
  assert.strictEqual(E.workerShifts(w, '2026-11')[11].off, true);   // 전날은 기록되지 않음
});

test('출퇴근: 밤을 넘겨 퇴근하면 출근한 날 칸에 야간 근무로 기록', () => {
  const w = E.createWorker('이영희', 5, 10320);
  E.applyPunch(w, new Date(2026, 10, 12, 18, 0, 0));
  const r = E.applyPunch(w, new Date(2026, 10, 13, 2, 0, 0));
  assert.strictEqual(r.kind, 'out');
  const sh = E.workerShifts(w, '2026-11')[11];
  assert.strictEqual(sh.start, '18:00');
  assert.strictEqual(sh.end, '02:00');
  assert.ok(Math.abs(E.monthSummary(w, '2026-11').totalHours - 8) < 0.01);
});

test('출퇴근: 같은 날 두 번 일하면 한 칸으로 합치고 사이 시간은 휴게로 뺌', () => {
  const w = E.createWorker('박민수', 5, 10320);
  E.applyPunch(w, new Date(2026, 10, 12, 9, 0, 0)); E.applyPunch(w, new Date(2026, 10, 12, 12, 0, 0));
  E.applyPunch(w, new Date(2026, 10, 12, 14, 0, 0)); E.applyPunch(w, new Date(2026, 10, 12, 18, 0, 0));
  const sh = E.workerShifts(w, '2026-11')[11];
  assert.strictEqual(sh.start, '09:00');
  assert.strictEqual(sh.end, '18:00');
  assert.strictEqual(sh.breakMinutes, 120);
  assert.ok(Math.abs(E.monthSummary(w, '2026-11').totalHours - 7) < 0.01);
});

test('출퇴근: 출근 중 상태(punch)는 저장·불러오기 정리에서도 유지, 깨진 값은 버림', () => {
  const w = E.createWorker('최하나', 5, 10320);
  E.applyPunch(w, new Date(2026, 10, 12, 9, 0, 0));
  const [back] = E.normalizeWorkers(JSON.parse(JSON.stringify([w])));
  assert.deepStrictEqual(back.punch, { date: '2026-11-12', time: '09:00', at: '09:00' });
  const [bad] = E.normalizeWorkers([Object.assign({}, w, { punch: { date: 'x', time: '99:99' } })]);
  assert.strictEqual(bad.punch, undefined);
});

console.log('\n(앞부분 ' + passed + '개 통과, 이어서 출퇴근 테스트)\n');

test('식대는 실비: 세금·보험료 계산에서 제외하고 실수령액에는 더한다', () => {
  const base = { name: '가', hourlyWage: 10000, contractDays: 5, mode: 'weekly', weeklyHours: [10], tax: '3.3', includeWeekly: false };
  const a = E.calculatePayroll(Object.assign({}, base, { includeMeal: false }));
  const b = E.calculatePayroll(Object.assign({}, base, { includeMeal: true, mealDays: 2, mealAmount: 5000, mealMinHours: 4 }));
  assert.strictEqual(b.tax.total, a.tax.total);          // 식대가 있어도 공제액은 같다
  assert.strictEqual(b.taxBase, a.gross);
  assert.strictEqual(b.net, a.net + b.mealAllowance);    // 식대는 그대로 더해진다
});

test('자정 무효 처리: 자정까지 퇴근을 안 찍은 사람은 그날 출근이 무효(휴무)', () => {
  const a = E.createWorker('가', 5, 10320), b = E.createWorker('나', 5, 10320), c = E.createWorker('다', 5, 10320);
  E.applyPunch(a, new Date(2026, 10, 12, 18, 0, 0));
  E.applyPunch(b, new Date(2026, 10, 12, 9, 0, 0)); E.applyPunch(b, new Date(2026, 10, 12, 12, 0, 0));   // 오전 근무 끝
  E.applyPunch(b, new Date(2026, 10, 12, 18, 0, 0));                                                      // 저녁 출근 후 퇴근 누락
  E.applyPunch(c, new Date(2026, 10, 12, 9, 0, 0)); E.applyPunch(c, new Date(2026, 10, 12, 13, 0, 0));   // 정상 퇴근
  assert.strictEqual(E.autoCloseOpen([a, b, c], new Date(2026, 10, 12, 23, 59, 0)).length, 0);   // 아직 자정 전
  const done = E.autoCloseOpen([a, b, c], new Date(2026, 10, 13, 0, 0, 5));
  assert.strictEqual(done.length, 2);
  assert.strictEqual(E.punchIsOpen(a), false);
  assert.strictEqual(E.monthSummary(a, '2026-11').workDays, 0);          // 근무로 안 침
  assert.strictEqual(E.workerShifts(a, '2026-11')[11].off, true);        // 휴무
  assert.strictEqual(E.monthSummary(b, '2026-11').workDays, 1);          // 앞서 끝낸 오전 근무는 그대로
  assert.ok(Math.abs(E.monthSummary(b, '2026-11').totalHours - 3) < 0.01);
  assert.strictEqual(E.monthSummary(c, '2026-11').workDays, 1);
  assert.strictEqual(E.autoCloseOpen([a, b, c], new Date(2026, 10, 13, 9, 0, 0)).length, 0);
});

test('자동 퇴근 시각: 기본 자정, 설정한 시각에 퇴근 처리하고 기록 대신 확인 필요로 남김, 사장님이 퇴근 시각 넣으면 기록', () => {
  const D = (d, h, m) => new Date(2026, 10, d, h, m, 0);
  assert.strictEqual(E.sanitizeSettings({}).autoOutTime, '00:00');
  assert.strictEqual(E.sanitizeSettings({ autoOutTime: '02:00' }).autoOutTime, '02:00');
  assert.strictEqual(E.sanitizeSettings({ autoOutTime: '02:30' }).autoOutTime, '00:00');   // 없는 값은 기본
  // 마감 시각 계산
  const dl = (date, at, cut) => { const x = E.autoOutDeadline({ date, time: at, at }, cut); return x.getDate() + ' ' + x.getHours() + ':' + x.getMinutes(); };
  assert.strictEqual(dl('2026-11-12', '18:00', '00:00'), '13 0:0');
  assert.strictEqual(dl('2026-11-12', '18:00', '02:00'), '13 2:0');
  assert.strictEqual(dl('2026-11-12', '18:00', '23:00'), '12 23:0');
  assert.strictEqual(dl('2026-11-12', '23:10', '23:00'), '13 23:0');
  assert.strictEqual(dl('2026-11-13', '00:06', '00:00'), '14 0:0');
  assert.strictEqual(dl('2026-11-13', '00:00', '00:00'), '14 0:0');
  // 02:00 마감: 01:00 퇴근은 정상 야간 근무
  const a = E.createWorker('가', 5, 10320);
  E.applyPunch(a, D(12, 18, 0), { autoOut: '02:00' });
  assert.strictEqual(E.autoCloseOpen([a], D(13, 0, 30), '02:00').length, 0);
  const r = E.applyPunch(a, D(13, 1, 0), { autoOut: '02:00' });
  assert.strictEqual(r.kind, 'out');
  const sh = E.workerShifts(a, '2026-11')[11];
  assert.deepStrictEqual([sh.start, sh.end], ['18:00', '01:00']);
  assert.ok(Math.abs(E.calcShiftHours(sh.start, sh.end, sh.breakMinutes) - 7) < 0.01);
  // 마감까지 퇴근 안 찍음 → 퇴근 처리, 기록 없음, 확인 필요
  const b = E.createWorker('나', 5, 10320);
  E.applyPunch(b, D(12, 9, 0)); E.applyPunch(b, D(12, 12, 0));        // 오전 근무
  E.applyPunch(b, D(12, 17, 40));                                        // 18:00 출근(올림), 퇴근 안 찍음
  const done = E.autoCloseOpen([b], D(13, 0, 0), '00:00');
  assert.strictEqual(done.length, 1);
  assert.strictEqual(E.punchIsOpen(b), false);
  assert.deepStrictEqual(b.pending, [{ date: '2026-11-12', start: '18:00', at: '17:40', cut: '2026-11-13 00:00' }]);
  assert.ok(Math.abs(E.monthSummary(b, '2026-11').totalHours - 3) < 0.01);   // 오전 근무만
  // 저장·불러오기 정리에서도 유지
  assert.deepStrictEqual(E.normalizeWorkers([JSON.parse(JSON.stringify(b))])[0].pending, b.pending);
  // 사장님이 퇴근 시각 입력 → 앞선 오전 근무와 합쳐 기록, 확인 필요에서 빠짐
  assert.strictEqual(E.resolvePending(b, 0, '18:00').ok, false);   // 출근과 같은 시각
  assert.strictEqual(E.resolvePending(b, 0, '9시').ok, false);
  E.applyPunch(b, D(13, 9, 0));   // 다음 날 출근 중이어도
  const rr = E.resolvePending(b, 0, '22:00');
  assert.strictEqual(rr.ok, true);
  const s2 = E.workerShifts(b, '2026-11')[11];
  assert.deepStrictEqual([s2.start, s2.end, s2.breakMinutes], ['09:00', '22:00', 360]);
  assert.strictEqual(b.pending, undefined);
  assert.strictEqual(E.punchIsOpen(b), true);   // 근무 중 상태 유지
  // 근무 없음으로 정리
  const c = E.createWorker('다', 5, 10320);
  E.applyPunch(c, D(12, 20, 0)); E.autoCloseOpen([c], D(13, 0, 1));
  assert.strictEqual(E.dismissPending(c, 0), true);
  assert.strictEqual(c.pending, undefined);
  assert.strictEqual(E.monthSummary(c, '2026-11').workDays, 0);
  // 밤을 넘긴 퇴근 시각 입력(02:00)도 그 날 칸에 야간으로
  const d = E.createWorker('라', 5, 10320);
  E.applyPunch(d, D(12, 20, 0)); E.autoCloseOpen([d], D(13, 0, 1));
  E.resolvePending(d, 0, '02:00');
  assert.ok(Math.abs(E.monthSummary(d, '2026-11').totalHours - 6) < 0.01);
  // 앱이 꺼져 있다 마감 뒤에 찍으면: 먼저 확인 필요로 남기고 새 출근
  const e = E.createWorker('마', 5, 10320);
  E.applyPunch(e, D(12, 18, 0), { autoOut: '00:00' });
  const r2 = E.applyPunch(e, D(13, 9, 0), { autoOut: '00:00' });
  assert.strictEqual(r2.kind, 'in');
  assert.strictEqual(e.pending.length, 1);
  // 같은 사람 같은 근무가 두 번 확인 필요로 들어가도 하나만
  e.pending.push({ date: '2026-11-12', start: '18:00' });
  assert.strictEqual(E.normalizeWorkers([e])[0].pending.length, 1);
});

test('밤을 넘긴 퇴근도 그 날 앞선 근무를 지우지 않고 합침', () => {
  const D = (d, h, m) => new Date(2026, 10, d, h, m, 0);
  const w = E.createWorker('가', 5, 10320);
  const o = { autoOut: '03:00' };
  E.applyPunch(w, D(12, 9, 0), o); E.applyPunch(w, D(12, 12, 0), o);
  E.applyPunch(w, D(12, 18, 0), o); E.applyPunch(w, D(13, 1, 0), o);
  const sh = E.workerShifts(w, '2026-11')[11];
  assert.deepStrictEqual([sh.start, sh.end, sh.breakMinutes], ['09:00', '01:00', 360]);
  assert.ok(Math.abs(E.monthSummary(w, '2026-11').totalHours - 10) < 0.01);
});

test('장부 재생: 자동 퇴근 줄·지난 마감 시각은 확인 필요로 복구 (예전 자정 무효 줄도)', () => {
  const saved = new Date(2026, 10, 12, 8, 0, 0).getTime();
  const mk = () => E.createWorker('가', 5, 10320);
  const w = mk();
  E.replayPunchLog([w], [
    ['2026-11-12 18:00:00', w.code, '가', '출근', '이름+비밀번호', '정상', ''],
    ['2026-11-13 02:00:00', w.code, '가', '퇴근누락(확인필요)', '자동(마감)', '정상(자동)', '']
  ], saved, { autoOut: '02:00' });
  assert.strictEqual(E.punchIsOpen(w), false);
  assert.strictEqual(w.pending.length, 1);
  // 자동 줄이 없어도 다음 줄 시각이 마감을 지났으면 확인 필요로
  const v = mk();
  E.replayPunchLog([v], [
    ['2026-11-12 18:00:00', v.code, '가', '출근', '이름+비밀번호', '정상', ''],
    ['2026-11-13 09:00:00', v.code, '가', '출근', '이름+비밀번호', '정상', '']
  ], saved, { autoOut: '00:00' });
  assert.strictEqual(v.pending.length, 1);
  assert.strictEqual(v.punch.date, '2026-11-13');
  // 예전 형식(자동(자정)) 줄
  const u = mk();
  E.replayPunchLog([u], [
    ['2026-11-12 18:00:00', u.code, '가', '출근', '이름+비밀번호', '정상', ''],
    ['2026-11-13 00:00:00', u.code, '가', '퇴근누락(무효)', '자동(자정)', '정상(자동)', '']
  ], saved);
  assert.strictEqual(E.punchIsOpen(u), false);
  assert.strictEqual(u.pending.length, 1);
});

test('출퇴근기록 장부 재생: 저장 이후에 찍은 출근·퇴근·자동퇴근을 복구', () => {
  const w = E.createWorker('가', 5, 10320);
  const saved = new Date(2026, 10, 12, 8, 0, 0).getTime();
  const rows = [
    ['2026-11-12 07:00:00', w.code, '가', '출근', '이름+비밀번호', '정상', ''],   // 저장 이전: 건너뜀
    ['2026-11-12 09:03:00', w.code, '가', '출근', '이름+비밀번호', '정상', ''],
    ['2026-11-12 09:10:00', w.code, '가', '', '이름+비밀번호', '비밀번호 오류', '1번째 연속 실패'],
    ['2026-11-12 13:00:00', w.code, '가', '퇴근', '이름+비밀번호', '정상', ''],
    ['2026-11-12 18:00:00', w.code, '가', '출근', '이름+비밀번호', '정상', ''],
    ['2026-11-13 00:00:00', w.code, '가', '퇴근누락(무효)', '자동(자정)', '정상(자동)', '']
  ];
  assert.strictEqual(E.replayPunchLog([w], rows, saved), 4);
  assert.strictEqual(E.punchIsOpen(w), false);
  // 09:30 출근 ~ 13:00 근무만 남고, 퇴근 누락한 저녁 출근은 무효
  assert.ok(Math.abs(E.monthSummary(w, '2026-11').totalHours - 3.5) < 0.01 && E.monthSummary(w, '2026-11').workDays === 1);
  // 출근만 있고 퇴근이 없으면 근무 중으로 복구
  const v = E.createWorker('나', 5, 10320);
  E.replayPunchLog([v], [['2026-11-12 18:00:00', v.code, '나', '출근', '이름+비밀번호', '정상', '']], saved);
  assert.strictEqual(E.punchIsOpen(v), true);
});

test('출근 올림 시각 전에 퇴근하면 근무 0시간으로 출근 취소, 그 뒤 다시 출근 가능', () => {
  const at = (h, m) => new Date(2026, 10, 12, h, m, 0);
  const w = E.createWorker('가', 5, 10320);
  assert.strictEqual(E.applyPunch(w, at(9, 5)).kind, 'in');     // 09:30 출근으로 기록
  const r = E.applyPunch(w, at(9, 20));                          // 15분 뒤 퇴근
  assert.strictEqual(r.kind, 'out');
  assert.strictEqual(E.punchIsOpen(w), false);
  assert.strictEqual(E.monthSummary(w, '2026-11').workDays, 0);
  assert.strictEqual(E.applyPunch(w, at(9, 40)).kind, 'in');    // 다시 출근 가능
});

test('자정 직후 출근(00:06→00:30 올림)도 근무 중으로 표시', () => {
  const w = E.createWorker('가', 5, 10320);
  const r = E.applyPunch(w, new Date(2026, 10, 13, 0, 6, 0));
  assert.strictEqual(r.start, '00:30');
  assert.strictEqual(E.punchNext(w, new Date(2026, 10, 13, 0, 7, 0)), 'out');
  assert.strictEqual(E.autoCloseOpen([w], new Date(2026, 10, 13, 0, 8, 0)).length, 0);   // 오늘 출근은 무효 처리 안 됨
});

test('버전: 엔진 번들의 ALBA_VERSION이 package.json 버전과 같다', () => {
  const fs = require('fs'), path = require('path');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'engine.js'), 'utf8');
  assert.ok(src.indexOf("ALBA_VERSION = '" + pkg.version + "'") > 0);
  assert.ok(/^\d+\.\d+\.\d+$/.test(pkg.version));
});

console.log('\n총 ' + passed + '개 단위 테스트 통과!');
