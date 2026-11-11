/*
 * src/stats.js — 합계/평균/최대·최소 및 명단(보관함) 요약 통계
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./math_ops.js'));
  } else {
    root.AlbaEngine = root.AlbaEngine || {};
    Object.assign(root.AlbaEngine, factory(root.AlbaEngine));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  function nums(list) {
    return (list || []).map(function (x) { return M.toNumber(x, 0); });
  }
  function sum(list) {
    return nums(list).reduce(function (s, x) { return s + x; }, 0);
  }
  function mean(list) {
    return list && list.length ? sum(list) / list.length : 0;
  }
  function minOf(list) {
    return list && list.length ? Math.min.apply(null, nums(list)) : 0;
  }
  function maxOf(list) {
    return list && list.length ? Math.max.apply(null, nums(list)) : 0;
  }
  function pluck(list, key) {
    return (list || []).map(function (x) { return x ? x[key] : 0; });
  }

  /** 급여 정산 결과 배열 요약 (정산 명단 합계) */
  function summarizePayrolls(results) {
    var r = results || [];
    var nets = pluck(r, 'net');
    return {
      count: r.length,
      totalHours: M.round2(sum(pluck(r, 'totalHours'))),
      totalBase: sum(pluck(r, 'basePay')),
      totalWeekly: sum(pluck(r, 'weeklyAllowance')),
      totalMeal: sum(pluck(r, 'mealAllowance')),
      totalLate: sum(pluck(r, 'lateDeduction')),
      totalGross: sum(pluck(r, 'gross')),
      totalTax: sum(r.map(function (x) { return x && x.tax ? x.tax.total : 0; })),
      totalNet: sum(nets),
      avgNet: Math.round(mean(nets)),
      maxNet: maxOf(nets),
      minNet: minOf(nets)
    };
  }

  /** 일별 점검 결과 배열 요약 (점검 보관함 합계) */
  function summarizeChecklists(results) {
    var r = results || [];
    return {
      count: r.length,
      allPassDays: r.filter(function (x) { return x && x.allPass; }).length,
      totalFails: sum(pluck(r, 'failCount')),
      avgPassRate: Math.round(mean(r.map(function (x) { return x && x.total ? (x.passCount / x.total) * 100 : 0; })))
    };
  }

  return {
    sum: sum,
    mean: mean,
    minOf: minOf,
    maxOf: maxOf,
    summarizePayrolls: summarizePayrolls,
    summarizeChecklists: summarizeChecklists
  };
});
