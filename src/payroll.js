/*
 * src/payroll.js — 급여·주휴수당·식대·세금 정산 엔진 (표준 급여명세서 데이터 생성)
 *
 *  근무시간 모드  :
 *    - 'daily'  : 지급월(YYYY-MM) 실제 달력(28~31일, 4~6주차) 기반 출퇴근 시각(HH:MM ~ HH:MM) 입력
 *                 (하위호환: 숫자 배열 dailyHours만 전달된 경우 4주×7일 숫자 모드로 동작)
 *    - 'weekly' : 월별 주차(1~N주) 시간 직접 입력
 *    - 'total'  : 월 총 근무시간 입력 (4주 균등 분할)
 *  주휴수당(주별)  = 주 근무시간 >= 15h 인 주에 대해 round((min(주시간,40) / 40) × 8 × 시급)
 *  식대(일별조건)  = 일 근무시간 >= 기준시간(기본 4h) 인 날 수 × 1일 식대(기본 8,000원)
 *  지각/조퇴 차감 = round((지각분 / 60) × 시급)
 *  세전 지급총액  = 기본급 − 지각차감 + 주휴수당 + 식대
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(Object.assign({}, require('./math_ops.js'), require('./stats.js')));
  } else {
    root.AlbaEngine = root.AlbaEngine || {};
    Object.assign(root.AlbaEngine, factory(root.AlbaEngine));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  var WEEKS = 4;
  var DAYS_PER_WEEK = 7;
  var TOTAL_DAYS = WEEKS * DAYS_PER_WEEK;
  var DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];
  var WEEKLY_MIN_HOURS = 15;
  var WEEKLY_CAP_HOURS = 40;
  var WEEKLY_PAID_HOURS = 8;
  var DEFAULT_MEAL_MIN_HOURS = 4;
  var DEFAULT_CONTRACT_DAYS = 5; // 주 소정근로일 기본값 (주휴수당 개근 판정용)
  var DEFAULT_MEAL_AMOUNT = 8000;

  var TAX_TYPES = {
    '3.3': '3.3% (사업소득세)',
    '4ins': '4대보험 (근로자 부담분)',
    'none': '미적용 (0%)'
  };

  /* 세율·보험료율 (%) — 해마다 바뀔 수 있어 앱의 [설정] 탭에서 고칠 수 있다 */
  var DEFAULT_RATES = { incomeTax: 3, localTax: 10, pension: 4.5, health: 3.545, care: 12.95, employment: 0.9 };
  var RATES = Object.assign({}, DEFAULT_RATES);

  /** 입력값을 검사해 정상 범위(0~100%, 소수 3자리)의 숫자만 남긴 세율 객체를 돌려준다 */
  function sanitizeRates(raw) {
    var out = Object.assign({}, DEFAULT_RATES);
    if (raw && typeof raw === 'object') {
      Object.keys(DEFAULT_RATES).forEach(function (k) {
        var v = raw[k];
        if (v === '' || v === null || v === undefined) return;
        v = Number(v);
        if (isFinite(v) && v >= 0 && v <= 100) out[k] = Math.round(v * 1000) / 1000;
      });
    }
    return out;
  }
  function setRates(raw) { RATES = sanitizeRates(raw); return Object.assign({}, RATES); }
  function getRates() { return Object.assign({}, RATES); }
  function pct(v) { return String(Math.round(v * 1000) / 1000); }
  function bp(v) { return Math.round(v * 1000); }   // % → rateTrunc10 단위(1% = 1000)

  /* 점심/저녁 식사 시간대 — 이 시간대에 1시간 이상 겹쳐 일하면 그 끼니 식대가 자동으로 체크된다 */
  var DEFAULT_MEAL_TIMES = { lunchStart: '11:00', lunchEnd: '14:00', dinnerStart: '17:00', dinnerEnd: '20:00' };
  var MEAL_TIMES = Object.assign({}, DEFAULT_MEAL_TIMES);
  var MEAL_OVERLAP_MIN = 60;

  function sanitizeMealTimes(raw) {
    var out = Object.assign({}, DEFAULT_MEAL_TIMES);
    if (raw && typeof raw === 'object') {
      [['lunchStart', 'lunchEnd'], ['dinnerStart', 'dinnerEnd']].forEach(function (pair) {
        var a = typeof raw[pair[0]] === 'string' ? parseTimeMinutes(raw[pair[0]]) : null;
        var b = typeof raw[pair[1]] === 'string' ? parseTimeMinutes(raw[pair[1]]) : null;
        if (a !== null && b !== null && a < b && b <= 1440) {
          out[pair[0]] = minutesToTime(a);
          out[pair[1]] = b === 1440 ? '24:00' : minutesToTime(b);
        }
      });
    }
    return out;
  }
  function setMealTimes(raw) { MEAL_TIMES = sanitizeMealTimes(raw); return Object.assign({}, MEAL_TIMES); }
  function getMealTimes() { return Object.assign({}, MEAL_TIMES); }

  function overlapMinutes(a1, a2, b1, b2) { return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1)); }

  /**
   * 하루 근무에 대한 식대 판정.
   *  - 자동: 기준시간(mealMinHours) 이상 일했고, 점심/저녁 시간대와 1시간 이상 겹치면 그 끼니 체크
   *          (어느 시간대와도 안 겹치면 한 번은 지급: 야간 근무 등은 저녁, 이른 근무는 점심)
   *  - 직접 고침: shift.meals = ['L','D'] 중 체크한 것 (자동 결과를 덮어씀)
   */
  function mealsForShift(sh, minMealH) {
    var none = { lunch: false, dinner: false, auto: { lunch: false, dinner: false }, manual: false };
    if (!sh || sh.off) return none;
    var h = calcShiftHours(sh.start, sh.end, sh.breakMinutes);
    if (!(h > 0)) return none;
    var auto = { lunch: false, dinner: false };
    if (h >= minMealH) {
      var s = parseTimeMinutes(sh.start);
      var e = parseTimeMinutes(sh.end);
      var overnight = e <= s;
      var end = overnight ? e + 1440 : e;
      var T = MEAL_TIMES;
      function hit(a, b) {
        var A = parseTimeMinutes(a), B = b === '24:00' ? 1440 : parseTimeMinutes(b);
        return overlapMinutes(s, end, A, B) >= MEAL_OVERLAP_MIN || overlapMinutes(s, end, A + 1440, B + 1440) >= MEAL_OVERLAP_MIN;
      }
      auto.lunch = hit(T.lunchStart, T.lunchEnd);
      auto.dinner = hit(T.dinnerStart, T.dinnerEnd);
      if (!auto.lunch && !auto.dinner) {
        if (overnight || s >= 20 * 60) auto.dinner = true; else auto.lunch = true;
      }
    }
    if (Array.isArray(sh.meals)) {
      return { lunch: sh.meals.indexOf('L') >= 0, dinner: sh.meals.indexOf('D') >= 0, auto: auto, manual: true };
    }
    return { lunch: auto.lunch, dinner: auto.dinner, auto: auto, manual: false };
  }

  var won = M.formatWon;
  function fmtH(h) { return M.formatNum(h, 2); }

  function toBool(v, def) {
    if (v === undefined || v === null) return def;
    if (typeof v === 'boolean') return v;
    if (v === 'false' || v === '0' || v === 0) return false;
    if (v === 'true' || v === '1' || v === 1) return true;
    return def;
  }

  /** "09:30" → 570 (분). 형식이 잘못되면 null 반환 */
  function parseTimeMinutes(t) {
    if (typeof t !== 'string') return null;
    var m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
    if (!m) return null;
    var hh = parseInt(m[1], 10);
    var mm = parseInt(m[2], 10);
    if (hh < 0 || hh > 24 || mm < 0 || mm > 59) return null;
    if (hh === 24 && mm > 0) return null;
    return hh * 60 + mm;
  }

  /** 분(0~1440) → "HH:MM" */
  function minutesToTime(mins) {
    var m = ((Math.round(mins) % 1440) + 1440) % 1440;
    var hh = String(Math.floor(m / 60)).padStart(2, '0');
    var mm = String(m % 60).padStart(2, '0');
    return hh + ':' + mm;
  }

  /**
   * 출근 시각 ~ 퇴근 시각 (휴게시간 분 차감) → 근무시간(h)
   * 퇴근이 출근보다 같거나 이르면 익일(야간) 근무로 간주 (+24h)
   */
  function calcShiftHours(start, end, breakMinutes) {
    var s = parseTimeMinutes(start);
    var e = parseTimeMinutes(end);
    if (s === null || e === null) return 0;
    if (s === e) return 0;
    var diff = e > s ? (e - s) : (1440 - s + e);
    var brk = Math.max(0, M.toNumber(breakMinutes, 0));
    var workMins = Math.max(0, diff - brk);
    return M.round2(workMins / 60);
  }

  /**
   * 지급월("YYYY-MM")의 실제 달력 및 주차(월~일 기준) 계산
   */
  function buildMonthCalendar(payMonth) {
    var y = 2026, m = 11;
    if (typeof payMonth === 'string' && /^(\d{4})-(\d{2})$/.test(payMonth)) {
      var parts = payMonth.split('-');
      y = parseInt(parts[0], 10);
      m = parseInt(parts[1], 10);
    } else {
      var now = new Date();
      y = now.getFullYear();
      m = now.getMonth() + 1;
    }
    var daysInMonth = new Date(y, m, 0).getDate();
    // JS getDay(): 0=일..6=토 -> 월요일 시작 인덱스(0=월..5=토, 6=일)로 변환
    var firstJsDay = new Date(y, m - 1, 1).getDay();
    var firstDow = (firstJsDay + 6) % 7;
    var weekCount = Math.ceil((firstDow + daysInMonth) / 7);

    var days = [];
    for (var d = 1; d <= daysInMonth; d++) {
      var offset = firstDow + (d - 1);
      var dow = offset % 7;
      var weekIdx = Math.floor(offset / 7); // 0 .. weekCount-1
      days.push({
        date: d,
        dateStr: y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0'),
        dow: dow,
        dayName: DAY_NAMES[dow],
        isWeekend: dow >= 5,
        week: weekIdx + 1,
        weekIndex: weekIdx
      });
    }
    return {
      year: y,
      month: m,
      payMonth: y + '-' + String(m).padStart(2, '0'),
      daysInMonth: daysInMonth,
      firstDow: firstDow,
      weekCount: weekCount,
      days: days
    };
  }

  function normalizeShift(s) {
    if (!s || typeof s !== 'object') {
      return { off: true, start: '09:00', end: '14:00', breakMinutes: 0 };
    }
    var off = toBool(s.off, false);
    var start = typeof s.start === 'string' && parseTimeMinutes(s.start) !== null ? s.start.trim() : '09:00';
    var end = typeof s.end === 'string' && parseTimeMinutes(s.end) !== null ? s.end.trim() : '14:00';
    var brk = Math.max(0, Math.round(M.toNumber(s.breakMinutes, 0)));
    var out = { off: off, start: start, end: end, breakMinutes: brk };
    if (Array.isArray(s.meals)) {
      out.meals = ['L', 'D'].filter(function (k) { return s.meals.indexOf(k) >= 0; });   // 직접 고친 식대(점심 L / 저녁 D)
    }
    return out;
  }

  function normalizePayrollInput(raw) {
    raw = raw || {};
    var payMonth = typeof raw.payMonth === 'string' && /^\d{4}-\d{2}$/.test(raw.payMonth) ? raw.payMonth : '';
    var cal = buildMonthCalendar(payMonth);

    var wh = Array.isArray(raw.weekHours) ? raw.weekHours : [];
    var weekCountForWeekly = Math.max(WEEKS, wh.length || WEEKS);
    var weekHours = [];
    for (var wi = 0; wi < weekCountForWeekly; wi++) {
      weekHours.push(Math.max(0, M.toNumber(wh[wi], 0)));
    }

    var hasDailyShifts = Array.isArray(raw.dailyShifts) && raw.dailyShifts.length > 0;
    var dailyShifts = null;
    if (hasDailyShifts) {
      dailyShifts = [];
      for (var d = 0; d < cal.daysInMonth; d++) {
        dailyShifts.push(normalizeShift(raw.dailyShifts[d]));
      }
    }

    var dh = Array.isArray(raw.dailyHours) ? raw.dailyHours : [];
    var dailyHours = [];
    var dhLen = Math.max(TOTAL_DAYS, dh.length);
    for (var i = 0; i < dhLen; i++) {
      dailyHours.push(Math.max(0, M.clamp(M.toNumber(dh[i], 0), 0, 24)));
    }

    var mode = raw.mode === 'daily' ? 'daily' : (raw.mode === 'weekly' ? 'weekly' : 'total');

    // 주휴수당 개근 조건: 주 소정근로일(약속한 출근 일수). 이보다 적게 출근한 주는 주휴수당 없음
    var contractDays = Math.min(7, Math.max(1, Math.round(M.toNumber(raw.contractDays, DEFAULT_CONTRACT_DAYS))));
    // weekAbsent: (주차별/월합계 모드) 주별 "결근 있음" 수동 체크 / weekExcuse: 결근이 있어도 그 주는 주휴 지급(공휴일·사장님 사정 등)
    var weekAbsent = [];
    var weekExcuse = [];
    for (var wb = 0; wb < 6; wb++) {
      weekAbsent.push(Array.isArray(raw.weekAbsent) ? toBool(raw.weekAbsent[wb], false) : false);
      weekExcuse.push(Array.isArray(raw.weekExcuse) ? toBool(raw.weekExcuse[wb], false) : false);
    }

    var mealMinHours = raw.mealMinHours === undefined || raw.mealMinHours === null || raw.mealMinHours === ''
      ? DEFAULT_MEAL_MIN_HOURS
      : Math.max(0, M.toNumber(raw.mealMinHours, DEFAULT_MEAL_MIN_HOURS));
    var mealAmount = raw.mealAmount === undefined || raw.mealAmount === null || raw.mealAmount === ''
      ? DEFAULT_MEAL_AMOUNT
      : Math.max(0, Math.round(M.toNumber(raw.mealAmount, DEFAULT_MEAL_AMOUNT)));
    var mealDays = raw.mealDays === undefined || raw.mealDays === null || raw.mealDays === ''
      ? null
      : Math.max(0, Math.round(M.toNumber(raw.mealDays, 0)));

    return {
      name: String(raw.name === null || raw.name === undefined ? '' : raw.name).trim().slice(0, 20) || '알바생',
      payMonth: payMonth,
      hourlyWage: Math.max(0, Math.round(M.toNumber(raw.hourlyWage, 0))),
      mode: mode,
      contractDays: contractDays,
      weekAbsent: weekAbsent,
      weekExcuse: weekExcuse,
      totalHours: Math.max(0, M.toNumber(raw.totalHours, 0)),
      weekHours: weekHours,
      dailyHours: dailyHours,
      dailyShifts: dailyShifts,
      lateMinutes: Math.max(0, Math.round(M.toNumber(raw.lateMinutes, 0))),
      includeWeekly: toBool(raw.includeWeekly, true),
      includeMeal: toBool(raw.includeMeal, false),
      mealMinHours: mealMinHours,
      mealAmount: mealAmount,
      mealDays: mealDays,
      tax: Object.prototype.hasOwnProperty.call(TAX_TYPES, raw.tax) ? raw.tax : '3.3'
    };
  }

  function weeklyAllowanceFor(hours, wage) {
    if (hours < WEEKLY_MIN_HOURS) return 0;
    return Math.round((Math.min(hours, WEEKLY_CAP_HOURS) * WEEKLY_PAID_HOURS * wage) / WEEKLY_CAP_HOURS);
  }

  function lateDeductionFor(minutes, wage) {
    return Math.round((minutes * wage) / 60);
  }

  function calcTax(type, gross) {
    var lines = [];
    var R = RATES;
    if (type === '3.3') {
      var income = M.rateTrunc10(gross, bp(R.incomeTax));
      var local = M.rateTrunc10(income, bp(R.localTax));
      lines.push({ key: 'incomeTax', label: '소득세 (' + pct(R.incomeTax) + '%)', amount: income, formula: won(gross) + '원 × ' + pct(R.incomeTax) + '% → 10원 미만 절사' });
      lines.push({ key: 'localTax', label: '지방소득세 (소득세의 ' + pct(R.localTax) + '%)', amount: local, formula: won(income) + '원 × ' + pct(R.localTax) + '% → 10원 미만 절사' });
    } else if (type === '4ins') {
      var pension = M.rateTrunc10(gross, bp(R.pension));
      var health = M.rateTrunc10(gross, bp(R.health));
      var care = M.rateTrunc10(health, bp(R.care));
      var employ = M.rateTrunc10(gross, bp(R.employment));
      lines.push({ key: 'pension', label: '국민연금 (' + pct(R.pension) + '%)', amount: pension, formula: won(gross) + '원 × ' + pct(R.pension) + '% → 10원 미만 절사' });
      lines.push({ key: 'health', label: '건강보험 (' + pct(R.health) + '%)', amount: health, formula: won(gross) + '원 × ' + pct(R.health) + '% → 10원 미만 절사' });
      lines.push({ key: 'care', label: '장기요양보험 (건보의 ' + pct(R.care) + '%)', amount: care, formula: won(health) + '원 × ' + pct(R.care) + '% → 10원 미만 절사' });
      lines.push({ key: 'employment', label: '고용보험 (' + pct(R.employment) + '%)', amount: employ, formula: won(gross) + '원 × ' + pct(R.employment) + '% → 10원 미만 절사' });
    } else {
      lines.push({ key: 'none', label: '세금 공제', amount: 0, formula: '세금 미적용 (0%) → 0원' });
    }
    var total = lines.reduce(function (s, l) { return s + l.amount; }, 0);
    var label = type === '3.3' ? pct(Math.round(R.incomeTax * (1 + R.localTax / 100) * 1000) / 1000) + '% (사업소득세)' : TAX_TYPES[type];
    return { type: type, label: label, lines: lines, total: total };
  }

  function payMonthLabel(pm) {
    if (!pm) return '-';
    var p = pm.split('-');
    return p[0] + '년 ' + Number(p[1]) + '월';
  }

  function buildRows(r) {
    var rows = [];
    rows.push({
      kind: 'pay', section: '지급', label: '기본급', amount: r.basePay, sign: 1,
      formula: fmtH(r.totalHours) + '시간 × ' + won(r.hourlyWage) + '원' +
        (r.mode === 'daily' ? ' (총 ' + r.workDays + '일 출근 · ' + r.weeks.length + '개 주차)' : '')
    });

    var weeklyDetail = '';
    if (r.includeWeekly) {
      var elig = r.weeks.filter(function (w) { return w.eligible; });
      weeklyDetail = elig.length
        ? r.weeks.map(function (w) {
            return w.week + '주 ' + fmtH(w.hours) + 'h' + (w.eligible
              ? ' → ' + won(w.allowance) + '원' + (w.excused ? ' (결근 있으나 지급)' : '')
              : (!w.hoursOk ? ' (15h 미만 제외)' : ' (결근 제외' + (w.workDays !== null ? ': ' + w.workDays + '/' + w.contractDays + '일 출근' : '') + ')'));
          }).join(' / ')
        : '주 15시간 이상 개근한 주가 없어 0원';
    }
    rows.push({
      kind: 'pay', section: '지급', label: '주휴수당', amount: r.weeklyAllowance, sign: 1,
      badge: r.includeWeekly ? '포함' : '미포함',
      formula: r.includeWeekly
        ? '주 15h 이상 + 약속한 출근일 개근한 주: (min(주시간, 40) ÷ 40) × 8시간 × ' + won(r.hourlyWage) + '원'
        : '주휴수당 미포함으로 정산 → 0원',
      detail: weeklyDetail
    });

    var mealFormula = r.includeMeal
      ? '점심·저녁 식사 ' + r.mealDays + '회 × ' + won(r.mealAmount) + '원'
      : '식대 미포함으로 정산 → 0원';
    var mealDetail = '';
    if (r.includeMeal && r.mode === 'daily') {
      mealDetail = r.weeks.map(function (w) {
        return w.week + '주 ' + w.mealDays + '회';
      }).join(' / ') + ' (총 ' + r.mealDays + '회 지급)';
    }
    rows.push({
      kind: 'pay', section: '지급', label: '식대 (식비)', amount: r.mealAllowance, sign: 1,
      badge: r.includeMeal ? (r.mealDays + '회 지급') : '미포함',
      formula: mealFormula,
      detail: mealDetail
    });

    rows.push({
      kind: 'deduct', section: '근태', label: '지각·조퇴 차감', amount: r.lateDeduction, sign: -1,
      formula: '(' + r.lateMinutes + '분 ÷ 60) × ' + won(r.hourlyWage) + '원 → 원 단위 반올림'
    });
    rows.push({
      kind: 'subtotal', section: '합계', label: '세전 지급총액', amount: r.gross, sign: 1,
      formula: '기본급 ' + won(r.basePay) + ' − 지각차감 ' + won(r.lateDeduction) +
        ' + 주휴수당 ' + won(r.weeklyAllowance) +
        (r.mealAllowance > 0 || r.includeMeal ? ' + 식대 ' + won(r.mealAllowance) : '')
    });
    r.tax.lines.forEach(function (l) {
      rows.push({ kind: 'deduct', section: '공제', label: l.label, amount: l.amount, sign: -1, formula: l.formula });
    });
    rows.push({
      kind: 'subtotal', section: '공제', label: '공제 합계 (' + r.tax.label + ')', amount: r.tax.total, sign: -1,
      formula: r.tax.type === 'none' ? '공제 없음' : r.tax.lines.map(function (l) { return won(l.amount); }).join(' + ') +
        (r.mealAllowance > 0 ? '  ※ 식대(실비) ' + won(r.mealAllowance) + '원은 제외한 ' + won(r.taxBase) + '원 기준' : '')
    });
    rows.push({
      kind: 'total', section: '실지급', label: '실수령액 (차인지급액)', amount: r.net, sign: 1,
      formula: '세전 지급총액 ' + won(r.gross) + ' − 공제 합계 ' + won(r.tax.total)
    });
    return rows;
  }

  function buildKakaoText(r) {
    var L = [];
    L.push('[급여명세서] ' + r.name + '님' + (r.payMonth ? ' · ' + r.payMonthLabel : ''));
    L.push('━━━━━━━━━━━━━━');
    L.push('▪ 근무시간: ' + fmtH(r.totalHours) + '시간 × 시급 ' + won(r.hourlyWage) + '원');
    L.push('▪ 기본급: ' + won(r.basePay) + '원');
    L.push('▪ 주휴수당: ' + won(r.weeklyAllowance) + '원 (' + (r.includeWeekly ? '포함' : '미포함') + ')');
    if (r.includeMeal || r.mealAllowance > 0) {
      L.push('▪ 식대(실비): ' + won(r.mealAllowance) + '원 (' + r.mealDays + '회 × ' + won(r.mealAmount) + '원)');
    }
    if (r.lateMinutes > 0) L.push('▪ 지각·조퇴 차감: -' + won(r.lateDeduction) + '원 (' + r.lateMinutes + '분)');
    L.push('▪ 세전 지급총액: ' + won(r.gross) + '원');
    L.push('▪ 공제 [' + r.tax.label + ']: -' + won(r.tax.total) + '원' + (r.tax.type !== 'none' && r.mealAllowance > 0 ? ' (식대 제외 ' + won(r.taxBase) + '원 기준)' : ''));
    if (r.tax.type !== 'none') {
      r.tax.lines.forEach(function (l) { L.push('   · ' + l.label + ' ' + won(l.amount) + '원'); });
    }
    L.push('━━━━━━━━━━━━━━');
    L.push('💰 실수령액: ' + won(r.net) + '원');
    L.push(r.message);
    return L.join('\n');
  }

  /** 급여 정산 메인 함수 */
  function calculatePayroll(raw) {
    var inp = normalizePayrollInput(raw);
    var wage = inp.hourlyWage;
    var minMealH = inp.mealMinHours;
    var cal = buildMonthCalendar(inp.payMonth);

    var weekHours = [];
    var weekMealDays = [];
    var daysDetail = [];
    var workDays = 0;
    var dailyMealDays = 0;
    var weekWorkDays = [];  // 주차별 실제 출근일 수 (일별 모드)
    var weekCalDays = [];   // 주차별로 해당 월에 포함된 날짜 수 (7일 미만이면 월 경계 주)

    if (inp.dailyShifts && inp.dailyShifts.length > 0) {
      // 실제 월별 달력(28~31일, 4~6주차) + 출퇴근 시각(start~end) 기반 계산
      for (var w = 0; w < cal.weekCount; w++) {
        weekHours.push(0);
        weekMealDays.push(0);
        weekWorkDays.push(0);
        weekCalDays.push(0);
      }
      cal.days.forEach(function (cd, idx) {
        var sh = inp.dailyShifts[idx] || { off: true, start: '09:00', end: '14:00', breakMinutes: 0 };
        var h = sh.off ? 0 : calcShiftHours(sh.start, sh.end, sh.breakMinutes);
        var ml = mealsForShift(sh, minMealH);
        var mealCount = (ml.lunch ? 1 : 0) + (ml.dinner ? 1 : 0);
        var mealEligible = mealCount > 0;
        if (h > 0) {
          workDays++;
          weekWorkDays[cd.weekIndex] += 1;
        }
        weekCalDays[cd.weekIndex] += 1;
        dailyMealDays += mealCount;           // 식대는 끼니 수(점심·저녁 각각 1회)로 센다
        weekMealDays[cd.weekIndex] += mealCount;
        weekHours[cd.weekIndex] = M.round2(weekHours[cd.weekIndex] + h);
        daysDetail.push({
          index: idx,
          date: cd.date,
          dateStr: cd.dateStr,
          week: cd.week,
          weekIndex: cd.weekIndex,
          dayIndex: cd.dow,
          dayName: cd.dayName,
          isWeekend: cd.isWeekend,
          off: sh.off || h <= 0,
          start: sh.start,
          end: sh.end,
          breakMinutes: sh.breakMinutes,
          hours: M.round2(h),
          mealEligible: mealEligible,
          mealCount: mealCount,
          meals: { lunch: ml.lunch, dinner: ml.dinner },
          mealAuto: ml.auto,
          mealManual: ml.manual
        });
      });
    } else {
      // 하위 호환: dailyHours 숫자 배열 (4주×7일)
      for (var w2 = 0; w2 < WEEKS; w2++) {
        var wSum = 0;
        var wMeals = 0;
        var wDays2 = 0;
        for (var d2 = 0; d2 < DAYS_PER_WEEK; d2++) {
          var idx2 = w2 * DAYS_PER_WEEK + d2;
          var h2 = inp.dailyHours[idx2] || 0;
          var mealElig2 = h2 > 0 && h2 >= minMealH;
          if (h2 > 0) { workDays++; wDays2++; }
          if (mealElig2) {
            dailyMealDays++;
            wMeals++;
          }
          wSum += h2;
          daysDetail.push({
            index: idx2,
            date: idx2 + 1,
            week: w2 + 1,
            weekIndex: w2,
            dayIndex: d2,
            dayName: DAY_NAMES[d2],
            isWeekend: d2 >= 5,
            off: h2 <= 0,
            start: '09:00',
            end: minutesToTime(9 * 60 + Math.round(h2 * 60)),
            breakMinutes: 0,
            hours: M.round2(h2),
            mealEligible: mealElig2,
            mealCount: mealElig2 ? 1 : 0,
            meals: { lunch: mealElig2, dinner: false },
            mealAuto: { lunch: mealElig2, dinner: false },
            mealManual: false
          });
        }
        weekHours.push(M.round2(wSum));
        weekMealDays.push(wMeals);
        weekWorkDays.push(wDays2);
        weekCalDays.push(DAYS_PER_WEEK);
      }
    }

    var activeWeekHours;
    if (inp.mode === 'daily') {
      activeWeekHours = weekHours;
    } else if (inp.mode === 'weekly') {
      activeWeekHours = inp.weekHours.slice();
    } else {
      activeWeekHours = [0, 1, 2, 3].map(function () { return inp.totalHours / WEEKS; });
    }

    var totalHours = inp.mode === 'total' ? inp.totalHours : M.round2(M.sum(activeWeekHours));
    var basePay = Math.round(totalHours * wage);

    var weeks = activeWeekHours.map(function (h, i) {
      var hoursOk = h >= WEEKLY_MIN_HOURS;
      var partial = inp.mode === 'daily' && (weekCalDays[i] || DAYS_PER_WEEK) < DAYS_PER_WEEK;
      var absent;
      if (inp.mode === 'daily') {
        // 월 경계의 7일 미만 주는 소정근로일 판단이 어려워 결근 판정에서 제외 (15시간 조건만 적용)
        absent = !partial && (weekWorkDays[i] || 0) < inp.contractDays;
      } else {
        absent = !!inp.weekAbsent[i];
      }
      var excused = absent && !!inp.weekExcuse[i];
      var eligible = hoursOk && (!absent || excused);
      return {
        week: i + 1,
        hours: M.round2(h),
        eligible: eligible,
        hoursOk: hoursOk,
        absent: absent,
        excused: excused,
        partial: partial,
        workDays: inp.mode === 'daily' ? (weekWorkDays[i] || 0) : null,
        contractDays: inp.contractDays,
        allowance: inp.includeWeekly && eligible ? weeklyAllowanceFor(h, wage) : 0,
        mealDays: weekMealDays[i] || 0
      };
    });

    var weeklyAllowance = weeks.reduce(function (s, w) { return s + w.allowance; }, 0);

    var mealDays;
    if (inp.mode === 'daily') {
      mealDays = dailyMealDays;
    } else if (inp.mealDays !== null) {
      mealDays = inp.mealDays;
    } else {
      mealDays = dailyMealDays;
    }
    var mealAllowance = inp.includeMeal ? Math.round(mealDays * inp.mealAmount) : 0;

    var lateDeduction = lateDeductionFor(inp.lateMinutes, wage);
    var gross = Math.max(0, basePay - lateDeduction + weeklyAllowance + mealAllowance);
    // 식대는 실비로 보고 세금·보험료 계산에서 뺀다
    var taxBase = Math.max(0, gross - mealAllowance);
    var tax = calcTax(inp.tax, taxBase);
    var net = gross - tax.total;

    var r = {
      input: inp,
      calendar: cal,
      name: inp.name,
      payMonth: inp.payMonth,
      payMonthLabel: payMonthLabel(inp.payMonth),
      hourlyWage: wage,
      mode: inp.mode,
      totalHours: M.round2(totalHours),
      workDays: workDays,
      contractDays: inp.contractDays,
      days: daysDetail,
      weeks: weeks,
      basePay: basePay,
      includeWeekly: inp.includeWeekly,
      weeklyAllowance: weeklyAllowance,
      includeMeal: inp.includeMeal,
      mealMinHours: minMealH,
      mealAmount: inp.mealAmount,
      mealDays: mealDays,
      mealAllowance: mealAllowance,
      lateMinutes: inp.lateMinutes,
      lateDeduction: lateDeduction,
      gross: gross,
      taxBase: taxBase,
      tax: tax,
      net: net
    };
    r.message = r.name + '님 계좌로 ' + won(net) + '원 입금하시면 됩니다.';
    r.rows = buildRows(r);
    r.kakaoText = buildKakaoText(r);
    return r;
  }

  return {
    DAY_NAMES: DAY_NAMES,
    TAX_TYPES: TAX_TYPES,
    parseTimeMinutes: parseTimeMinutes,
    minutesToTime: minutesToTime,
    calcShiftHours: calcShiftHours,
    buildMonthCalendar: buildMonthCalendar,
    normalizePayrollInput: normalizePayrollInput,
    weeklyAllowanceFor: weeklyAllowanceFor,
    lateDeductionFor: lateDeductionFor,
    calcTax: calcTax,
    DEFAULT_MEAL_TIMES: DEFAULT_MEAL_TIMES,
    sanitizeMealTimes: sanitizeMealTimes,
    setMealTimes: setMealTimes,
    getMealTimes: getMealTimes,
    mealsForShift: mealsForShift,
    DEFAULT_RATES: DEFAULT_RATES,
    sanitizeRates: sanitizeRates,
    setRates: setRates,
    getRates: getRates,
    calculatePayroll: calculatePayroll
  };
});
