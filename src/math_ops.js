/*
 * src/math_ops.js — 공통 수학 유틸 (원 단위 반올림 / 10원 미만 절사 / 숫자 파싱 / 포맷)
 * Node(require)와 브라우저(window.AlbaEngine) 양쪽에서 동일하게 동작하는 UMD 모듈입니다.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AlbaEngine = root.AlbaEngine || {};
    Object.assign(root.AlbaEngine, factory());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var ENGINE_VERSION = '1.2.1';

  /** "10,000원", " 62 " 같은 값을 숫자로 변환. 실패 시 def 반환 */
  function toNumber(v, def) {
    if (def === undefined) def = 0;
    if (typeof v === 'number') return isFinite(v) ? v : def;
    if (v === null || v === undefined || typeof v === 'boolean') return def;
    var s = String(v).replace(/[,\s원]/g, '');
    if (s === '' || s === '-' || s === '.') return def;
    var n = Number(s);
    return isFinite(n) ? n : def;
  }

  /** 원 단위 반올림 */
  function roundWon(x) {
    var r = Math.round(toNumber(x, 0));
    return r === 0 ? 0 : r; // -0 방지
  }

  /** 10원 미만 절사 */
  function floor10(x) {
    return Math.floor(toNumber(x, 0) / 10) * 10;
  }

  /**
   * amount × (ratePer100k / 100000) 결과를 10원 미만 절사.
   * 부동소수점 오차를 피하려고 정수 비율(10만분율)로 계산합니다.
   *   예) 3%   → 3000,  4.5% → 4500, 3.545% → 3545, 12.95% → 12950, 0.9% → 900, 10% → 10000
   *   floor(amount × rate / 10) × 10  ==  floor(amount × ratePer100k / 1,000,000) × 10
   */
  function rateTrunc10(amount, ratePer100k) {
    var a = Math.round(toNumber(amount, 0));
    if (a <= 0) return 0;
    return Math.floor((a * ratePer100k) / 1000000) * 10;
  }

  function clamp(x, lo, hi) {
    return Math.min(hi, Math.max(lo, x));
  }

  function round2(x) {
    var r = Math.round(toNumber(x, 0) * 100) / 100;
    return r === 0 ? 0 : r;
  }

  function addCommas(intStr) {
    return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  /** 1234567 → "1,234,567" (원 단위 반올림) */
  function formatWon(n) {
    var v = Math.round(toNumber(n, 0));
    var neg = v < 0;
    return (neg ? '-' : '') + addCommas(String(Math.abs(v)));
  }

  /** 15.5 → "15.5", 62 → "62", 1234.567 → "1,234.57" */
  function formatNum(x, maxDec) {
    if (maxDec === undefined || maxDec === null) maxDec = 2;
    var p = Math.pow(10, maxDec);
    var r = Math.round(toNumber(x, 0) * p) / p;
    var neg = r < 0;
    var parts = Math.abs(r).toFixed(maxDec).split('.');
    var dec = parts[1] ? parts[1].replace(/0+$/, '') : '';
    return (neg ? '-' : '') + addCommas(parts[0]) + (dec ? '.' + dec : '');
  }

  return {
    ENGINE_VERSION: ENGINE_VERSION,
    toNumber: toNumber,
    roundWon: roundWon,
    floor10: floor10,
    rateTrunc10: rateTrunc10,
    clamp: clamp,
    round2: round2,
    formatWon: formatWon,
    formatNum: formatNum
  };
});

