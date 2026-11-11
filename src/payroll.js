/*
 * src/payroll.js — 급여·주휴수당·식대·세금 정산 엔진 (표준 급여명세서 데이터 생성)
 *
 *  근무시간 모드  : 'total'(월 총 시간) | 'weekly'(1~4주차별) | 'daily'(매일 28일 시간표)
 *  주휴수당(주별)  = 주 근무시간 >= 15h 인 주에 대해 round((min(주시간,40) / 40) × 8 × 시급)
 *  식대(일별조건)  = 일 근무시간 >= 기준시간(기본 4h) 인 날 수 × 1일 식대(기본 8,000원)
 *  지각/조퇴 차감 = round((지각분 / 60) × 시급)
 *  세전 지급총액  = 기본급 − 지각차감 + 주휴수당 + 식대
 *  세금(10원 미만 절사)
 *    3.3%   : 소득세 floor(세전×0.03/10)×10 + 지방소득세 floor(소득세×0.1/10)×10
 *    4대보험 : 국민연금 4.5% + 건강보험 3.545% + 장기요양(건보의 12.95%) + 고용보험 0.9%
 *    미적용  : 0원
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
  var TOTAL_DAYS = WEEKS * DAYS_PER_WEEK; // 28일 (4주 × 월~일)
  var DAY_NAMES = ['월', '화', '수', '목', '금', '토', '일'];
  var WEEKLY_MIN_HOURS = 15;
  var WEEKLY_CAP_HOURS = 40;
  var WEEKLY_PAID_HOURS = 8;
  var DEFAULT_MEAL_MIN_HOURS = 4;
  var DEFAULT_MEAL_AMOUNT = 8000;

  var TAX_TYPES = {
    '3.3': '3.3% (사업소득세)',
    '4ins': '4대보험 (근로자 부담분)',
    'none': '미적용 (0%)'
  };

  var won = M.formatWon;
  function fmtH(h) { return M.formatNum(h, 2); }

  function toBool(v, def) {
    if (v === undefined || v === null) return def;
    if (typeof v === 'boolean') return v;
    if (v === 'false' || v === '0' || v === 0) return false;
    if (v === 'true' || v === '1' || v === 1) return true;
    return def;
  }

  function normalizePayrollInput(raw) {
    raw = raw || {};
    var wh = Array.isArray(raw.weekHours) ? raw.weekHours : [];
    var weekHours = [0, 1, 2, 3].map(function (i) { return Math.max(0, M.toNumber(wh[i], 0)); });

    var dh = Array.isArray(raw.dailyHours) ? raw.dailyHours : [];
    var dailyHours = [];
    for (var d = 0; d < TOTAL_DAYS; d++) {
      dailyHours.push(Math.max(0, M.clamp(M.toNumber(dh[d], 0), 0, 24)));
    }

    var mode = raw.mode === 'daily' ? 'daily' : (raw.mode === 'weekly' ? 'weekly' : 'total');
    var payMonth = typeof raw.payMonth === 'string' && /^\d{4}-\d{2}$/.test(raw.payMonth) ? raw.payMonth : '';

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
      totalHours: Math.max(0, M.toNumber(raw.totalHours, 0)),
      weekHours: weekHours,
      dailyHours: dailyHours,
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
    if (type === '3.3') {
      var income = M.rateTrunc10(gross, 3000);
      var local = M.rateTrunc10(income, 10000);
      lines.push({ key: 'incomeTax', label: '소득세 (3%)', amount: income, formula: won(gross) + '원 × 3% → 10원 미만 절사' });
      lines.push({ key: 'localTax', label: '지방소득세 (소득세의 10%)', amount: local, formula: won(income) + '원 × 10% → 10원 미만 절사' });
    } else if (type === '4ins') {
      var pension = M.rateTrunc10(gross, 4500);
      var health = M.rateTrunc10(gross, 3545);
      var care = M.rateTrunc10(health, 12950);
      var employ = M.rateTrunc10(gross, 900);
      lines.push({ key: 'pension', label: '국민연금 (4.5%)', amount: pension, formula: won(gross) + '원 × 4.5% → 10원 미만 절사' });
      lines.push({ key: 'health', label: '건강보험 (3.545%)', amount: health, formula: won(gross) + '원 × 3.545% → 10원 미만 절사' });
      lines.push({ key: 'care', label: '장기요양보험 (건보의 12.95%)', amount: care, formula: won(health) + '원 × 12.95% → 10원 미만 절사' });
      lines.push({ key: 'employment', label: '고용보험 (0.9%)', amount: employ, formula: won(gross) + '원 × 0.9% → 10원 미만 절사' });
    } else {
      lines.push({ key: 'none', label: '세금 공제', amount: 0, formula: '세금 미적용 (0%) → 0원' });
    }
    var total = lines.reduce(function (s, l) { return s + l.amount; }, 0);
    return { type: type, label: TAX_TYPES[type], lines: lines, total: total };
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
        (r.mode === 'daily' ? ' (총 ' + r.workDays + '일 근무)' : '')
    });

    var weeklyDetail = '';
    if (r.includeWeekly) {
      var elig = r.weeks.filter(function (w) { return w.eligible; });
      weeklyDetail = elig.length
        ? r.weeks.map(function (w) {
            return w.week + '주 ' + fmtH(w.hours) + 'h' + (w.eligible ? ' → ' + won(w.allowance) + '원' : ' (15h 미만 제외)');
          }).join(' / ')
        : '주 15시간 이상 근무한 주가 없어 0원';
    }
    rows.push({
      kind: 'pay', section: '지급', label: '주휴수당', amount: r.weeklyAllowance, sign: 1,
      badge: r.includeWeekly ? '포함' : '미포함',
      formula: r.includeWeekly
        ? '주 15h 이상인 주: (min(주시간, 40) ÷ 40) × 8시간 × ' + won(r.hourlyWage) + '원'
        : '주휴수당 미포함으로 정산 → 0원',
      detail: weeklyDetail
    });

    var mealFormula = r.includeMeal
      ? '일 ' + fmtH(r.mealMinHours) + '시간 이상 근무 ' + r.mealDays + '일 × ' + won(r.mealAmount) + '원'
      : '식대 미포함으로 정산 → 0원';
    var mealDetail = '';
    if (r.includeMeal && r.mode === 'daily') {
      mealDetail = r.weeks.map(function (w) {
        return w.week + '주 ' + w.mealDays + '일';
      }).join(' / ') + ' (총 ' + r.mealDays + '일 지급)';
    }
    rows.push({
      kind: 'pay', section: '지급', label: '식대 (식비)', amount: r.mealAllowance, sign: 1,
      badge: r.includeMeal ? (r.mealDays + '일 지급') : '미포함',
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
      formula: r.tax.type === 'none' ? '공제 없음' : r.tax.lines.map(function (l) { return won(l.amount); }).join(' + ')
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
      L.push('▪ 식대: ' + won(r.mealAllowance) + '원 (일 ' + fmtH(r.mealMinHours) + 'h↑ ' + r.mealDays + '일 × ' + won(r.mealAmount) + '원)');
    }
    if (r.lateMinutes > 0) L.push('▪ 지각·조퇴 차감: -' + won(r.lateDeduction) + '원 (' + r.lateMinutes + '분)');
    L.push('▪ 세전 지급총액: ' + won(r.gross) + '원');
    L.push('▪ 공제 [' + r.tax.label + ']: -' + won(r.tax.total) + '원');
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

    var weekHours;
    var daysDetail = [];
    var workDays = 0;
    var dailyMealDays = 0;

    for (var w = 0; w < WEEKS; w++) {
      for (var d = 0; d < DAYS_PER_WEEK; d++) {
        var idx = w * DAYS_PER_WEEK + d;
        var h = inp.dailyHours[idx] || 0;
        var mealEligible = h > 0 && h >= minMealH;
        if (h > 0) workDays++;
        if (mealEligible) dailyMealDays++;
        daysDetail.push({
          index: idx,
          week: w + 1,
          dayIndex: d,
          dayName: DAY_NAMES[d],
          hours: M.round2(h),
          mealEligible: mealEligible
        });
      }
    }

    if (inp.mode === 'daily') {
      weekHours = [0, 1, 2, 3].map(function (w) {
        var s = 0;
        for (var d = 0; d < DAYS_PER_WEEK; d++) s += inp.dailyHours[w * DAYS_PER_WEEK + d] || 0;
        return M.round2(s);
      });
    } else if (inp.mode === 'weekly') {
      weekHours = inp.weekHours.slice();
    } else {
      weekHours = [0, 1, 2, 3].map(function () { return inp.totalHours / WEEKS; });
    }

    var totalHours = inp.mode === 'total' ? inp.totalHours : M.round2(M.sum(weekHours));
    var basePay = Math.round(totalHours * wage);

    var weeks = weekHours.map(function (h, i) {
      var eligible = h >= WEEKLY_MIN_HOURS;
      var wMealDays = 0;
      for (var d = 0; d < DAYS_PER_WEEK; d++) {
        var dh = inp.dailyHours[i * DAYS_PER_WEEK + d] || 0;
        if (dh > 0 && dh >= minMealH) wMealDays++;
      }
      return {
        week: i + 1,
        hours: M.round2(h),
        eligible: eligible,
        allowance: inp.includeWeekly && eligible ? weeklyAllowanceFor(h, wage) : 0,
        mealDays: wMealDays
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
    var tax = calcTax(inp.tax, gross);
    var net = gross - tax.total;

    var r = {
      input: inp,
      name: inp.name,
      payMonth: inp.payMonth,
      payMonthLabel: payMonthLabel(inp.payMonth),
      hourlyWage: wage,
      mode: inp.mode,
      totalHours: M.round2(totalHours),
      workDays: workDays,
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
    normalizePayrollInput: normalizePayrollInput,
    weeklyAllowanceFor: weeklyAllowanceFor,
    lateDeductionFor: lateDeductionFor,
    calcTax: calcTax,
    calculatePayroll: calculatePayroll
  };
});
