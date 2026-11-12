/*
 * src/workers.js — 알바생 중심 기록 모델
 *
 *  알바생 한 명 = { id, name, contractDays, wage, months: { 'YYYY-MM': 월 기록 } }
 *  월 기록       = { wage, contractDays, includeWeekly, includeMeal, mealMinHours, mealAmount, tax,
 *                    dailyShifts:[{off,start,end,breakMinutes}...], weekExcuse:[6개] }
 *
 *  - 기록이 없는 달은 "빈 달력"(전부 휴무 0시간)이고, 설정(시급·식대·세금)은 가장 가까운 지난 달 것을 이어받는다.
 *  - 시급을 바꾸면 그 달부터 이후 달에 적용되고, 지난 달 기록은 그대로 둔다.
 *  - 예전 형식(정산 명단 = 이름+달 한 줄씩)은 migrateRoster 로 알바생별 월 기록으로 바꾼다.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./payroll.js'));
  } else {
    root.AlbaEngine = root.AlbaEngine || {};
    Object.assign(root.AlbaEngine, factory(root.AlbaEngine));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P) {
  'use strict';

  var RETAIN_MONTHS = 60;          // 구글 시트의 월별 탭 보관 기간(5년)
  var MAX_WORKERS = 200;
  var MONTH_RE = /^\d{4}-\d{2}$/;

  var DEFAULT_SETTINGS = {
    wage: 10320,
    contractDays: 5,
    includeWeekly: true,
    includeMeal: true,
    mealMinHours: 4,
    mealAmount: 8000,
    tax: '3.3'
  };

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

  function emptyShifts(payMonth) {
    var n = P.buildMonthCalendar(payMonth).daysInMonth;
    var out = [];
    for (var i = 0; i < n; i++) out.push({ off: true, start: '09:00', end: '14:00', breakMinutes: 0 });
    return out;
  }

  function newId() {
    return 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  /* 알바생 고유 코드: 출퇴근 QR 등에서 이름 대신 쓰는 값 (헷갈리는 글자 0/O/1/I 제외, 8자리) */
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function newCode() {
    var out = '';
    var buf = null;
    try {
      var c = (typeof crypto !== 'undefined' && crypto.getRandomValues) ? crypto : (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
      if (c && c.getRandomValues) { buf = new Uint8Array(8); c.getRandomValues(buf); }
    } catch (e) { buf = null; }
    for (var i = 0; i < 8; i++) {
      var r = buf ? buf[i] : Math.floor(Math.random() * 256);
      out += CODE_CHARS.charAt(r % CODE_CHARS.length);
    }
    return out;
  }
  var CODE_RE = /^[A-Z0-9]{6,16}$/;

  /* 한 달 기록 정리 (payroll 엔진의 입력 검사를 그대로 활용) */
  function normalizeRecord(raw, payMonth) {
    raw = isObj(raw) ? raw : {};
    var n = P.normalizePayrollInput({
      name: 'x', payMonth: payMonth, hourlyWage: raw.wage !== undefined ? raw.wage : raw.hourlyWage,
      mode: 'daily', dailyShifts: Array.isArray(raw.dailyShifts) && raw.dailyShifts.length ? raw.dailyShifts : emptyShifts(payMonth),
      contractDays: raw.contractDays, weekExcuse: raw.weekExcuse,
      includeWeekly: raw.includeWeekly, includeMeal: raw.includeMeal === undefined ? true : raw.includeMeal,
      mealMinHours: raw.mealMinHours, mealAmount: raw.mealAmount, tax: raw.tax
    });
    return {
      wage: n.hourlyWage,
      contractDays: n.contractDays,
      includeWeekly: n.includeWeekly,
      includeMeal: n.includeMeal,
      mealMinHours: n.mealMinHours,
      mealAmount: n.mealAmount,
      tax: n.tax,
      dailyShifts: n.dailyShifts.map(function (s) {
        var o = { off: !!s.off, start: s.start, end: s.end, breakMinutes: s.breakMinutes };
        if (Array.isArray(s.meals)) o.meals = s.meals.slice();
        return o;
      }),
      weekExcuse: n.weekExcuse.slice(0, 6)
    };
  }

  function cleanName(s) {
    return String(s === null || s === undefined ? '' : s).trim().slice(0, 20);
  }

  /* 출퇴근 QR을 볼 때 알바생이 입력하는 비밀번호 (선택, 20자까지) */
  function cleanPassword(s) {
    return String(s === null || s === undefined ? '' : s).trim().slice(0, 20);
  }

  /** 알바생 한 명 만들기 (이름·주 계약일수·시급) */
  function createWorker(name, contractDays, wage, defaults) {
    var cd = Math.min(7, Math.max(1, Math.round(Number(contractDays) || DEFAULT_SETTINGS.contractDays)));
    var w = Math.max(0, Math.round(Number(wage)));
    var worker = {
      id: newId(),
      code: newCode(),
      name: cleanName(name) || '알바생',
      contractDays: cd,
      wage: isFinite(w) && String(wage) !== '' ? w : DEFAULT_SETTINGS.wage,
      months: {}
    };
    var d = cleanDefaults(defaults);
    if (d) worker.defaults = d;
    return worker;
  }

  /* 식대·주휴·세금 기본값 (새 달에 이어받을 기록이 없을 때 사용) */
  function cleanDefaults(raw) {
    if (!isObj(raw)) return null;
    var n = P.normalizePayrollInput({
      name: 'x', includeWeekly: raw.includeWeekly, includeMeal: raw.includeMeal === undefined ? true : raw.includeMeal,
      mealMinHours: raw.mealMinHours, mealAmount: raw.mealAmount, tax: raw.tax
    });
    return { includeWeekly: n.includeWeekly, includeMeal: n.includeMeal, mealMinHours: n.mealMinHours, mealAmount: n.mealAmount, tax: n.tax };
  }

  /** 저장된 알바생 목록 검사·정리 (깨진 항목은 버림) */
  function normalizeWorkers(list) {
    var out = [];
    var seen = {};
    var seenCode = {};
    (Array.isArray(list) ? list : []).slice(0, MAX_WORKERS).forEach(function (raw) {
      if (!isObj(raw)) return;
      var name = cleanName(raw.name);
      if (!name) return;
      var id = typeof raw.id === 'string' && raw.id && !seen[raw.id] ? raw.id : newId();
      seen[id] = true;
      var months = {};
      if (isObj(raw.months)) {
        Object.keys(raw.months).forEach(function (k) {
          if (!MONTH_RE.test(k)) return;
          try { months[k] = normalizeRecord(raw.months[k], k); } catch (e) { /* 깨진 달은 건너뜀 */ }
        });
      }
      var cd = Math.min(7, Math.max(1, Math.round(Number(raw.contractDays) || DEFAULT_SETTINGS.contractDays)));
      var wage = Math.max(0, Math.round(Number(raw.wage)));
      var code = typeof raw.code === 'string' && CODE_RE.test(raw.code) && !seenCode[raw.code] ? raw.code : newCode();
      while (seenCode[code]) code = newCode();
      seenCode[code] = true;
      var item = { id: id, code: code, name: name, contractDays: cd, wage: isFinite(wage) ? wage : DEFAULT_SETTINGS.wage, months: months };
      var pw = cleanPassword(raw.password);
      if (pw) item.password = pw;
      var dflt = cleanDefaults(raw.defaults);
      if (dflt) item.defaults = dflt;
      out.push(item);
    });
    return out;
  }

  /** 예전 정산 명단(이름+달 한 줄씩) → 알바생별 월 기록 */
  function migrateRoster(entries) {
    var byName = {};
    var order = [];
    (Array.isArray(entries) ? entries : []).forEach(function (e) {
      if (!isObj(e)) return;
      var name = cleanName(e.name);
      var pm = typeof e.payMonth === 'string' && MONTH_RE.test(e.payMonth) ? e.payMonth : '';
      if (!name || !pm) return;
      var rec;
      try {
        rec = normalizeRecord({
          wage: e.hourlyWage, contractDays: e.contractDays, weekExcuse: e.weekExcuse,
          includeWeekly: e.includeWeekly, includeMeal: e.includeMeal,
          mealMinHours: e.mealMinHours, mealAmount: e.mealAmount, tax: e.tax,
          dailyShifts: e.dailyShifts
        }, pm);
      } catch (err) { return; }
      if (!byName[name]) { byName[name] = { name: name, months: {} }; order.push(name); }
      byName[name].months[pm] = rec;   // 같은 달이 여러 번이면 마지막 것
    });
    return normalizeWorkers(order.map(function (n) {
      var b = byName[n];
      var keys = Object.keys(b.months).sort();
      var last = b.months[keys[keys.length - 1]];
      return { name: n, contractDays: last.contractDays, wage: last.wage, months: b.months };
    }));
  }

  /** 그 달에 쓸 설정: 그 달 기록 → 가장 가까운 지난 달 → 가장 가까운 이후 달 → 알바생 기본값 */
  function workerSettings(worker, payMonth) {
    var months = (worker && worker.months) || {};
    var src = months[payMonth];
    if (!src) {
      var keys = Object.keys(months).sort();
      var prev = keys.filter(function (k) { return k < payMonth; });
      var next = keys.filter(function (k) { return k > payMonth; });
      var pick = prev.length ? prev[prev.length - 1] : (next.length ? next[0] : '');
      src = pick ? months[pick] : null;
    }
    var base = {
      wage: worker && isFinite(worker.wage) ? worker.wage : DEFAULT_SETTINGS.wage,
      contractDays: worker && worker.contractDays ? worker.contractDays : DEFAULT_SETTINGS.contractDays,
      includeWeekly: DEFAULT_SETTINGS.includeWeekly,
      includeMeal: DEFAULT_SETTINGS.includeMeal,
      mealMinHours: DEFAULT_SETTINGS.mealMinHours,
      mealAmount: DEFAULT_SETTINGS.mealAmount,
      tax: DEFAULT_SETTINGS.tax
    };
    if (worker && worker.defaults) {
      ['includeWeekly', 'includeMeal', 'mealMinHours', 'mealAmount', 'tax'].forEach(function (k) { base[k] = worker.defaults[k]; });
    }
    if (src) {
      ['wage', 'contractDays', 'includeWeekly', 'includeMeal', 'mealMinHours', 'mealAmount', 'tax'].forEach(function (k) { base[k] = src[k]; });
    }
    return base;
  }

  /** 그 달 근무 기록 (없으면 빈 달력) */
  function workerShifts(worker, payMonth) {
    var rec = worker && worker.months && worker.months[payMonth];
    if (rec && Array.isArray(rec.dailyShifts) && rec.dailyShifts.length) return rec.dailyShifts.map(function (s) { return Object.assign({}, s); });
    return emptyShifts(payMonth);
  }

  function workerExcuse(worker, payMonth) {
    var rec = worker && worker.months && worker.months[payMonth];
    return rec && Array.isArray(rec.weekExcuse) ? rec.weekExcuse.slice(0, 6) : [];
  }

  /** 급여 계산 엔진에 넣을 입력 */
  function workerPayrollInput(worker, payMonth) {
    var s = workerSettings(worker, payMonth);
    return {
      name: worker.name,
      payMonth: payMonth,
      hourlyWage: s.wage,
      mode: 'daily',
      dailyShifts: workerShifts(worker, payMonth),
      lateMinutes: 0,
      contractDays: s.contractDays,
      weekExcuse: workerExcuse(worker, payMonth),
      includeWeekly: s.includeWeekly,
      includeMeal: s.includeMeal,
      mealMinHours: s.mealMinHours,
      mealAmount: s.mealAmount,
      mealDays: null,
      tax: s.tax
    };
  }

  /** 그 달 기록 저장. 시급은 이후 달 기록에도 적용(지난 달은 그대로). */
  function setRecord(worker, payMonth, raw) {
    var rec = normalizeRecord(raw, payMonth);
    worker.months = worker.months || {};
    worker.months[payMonth] = rec;
    Object.keys(worker.months).forEach(function (k) {
      if (k > payMonth) worker.months[k].wage = rec.wage;
    });
    worker.wage = rec.wage;
    worker.contractDays = rec.contractDays;
    worker.defaults = cleanDefaults(rec);
    return rec;
  }

  /** 기록이 있는 달 목록 (오름차순) */
  function recordMonths(workers) {
    var set = {};
    (workers || []).forEach(function (w) { Object.keys(w.months || {}).forEach(function (k) { set[k] = true; }); });
    return Object.keys(set).sort();
  }

  /** 구글 시트에 남길 가장 오래된 달 (이번 달 포함 60개월) */
  function retentionCutoff(now) {
    var d = new Date(now === undefined ? Date.now() : now);
    var t = new Date(d.getFullYear(), d.getMonth() - (RETAIN_MONTHS - 1), 1);
    return t.getFullYear() + '-' + (t.getMonth() + 1 < 10 ? '0' : '') + (t.getMonth() + 1);
  }

  /** 설정(세율·보험료율·최저시급) 검사: 이상한 값은 기본값으로 */
  var DEFAULT_MIN_WAGE = 10320;
  function sanitizeSettings(raw) {
    raw = isObj(raw) ? raw : {};
    var mw = Math.round(Number(raw.minWage));
    return {
      minWage: isFinite(mw) && mw > 0 && mw < 1000000 ? mw : DEFAULT_MIN_WAGE,
      rates: P.sanitizeRates(raw.rates),
      mealTimes: P.sanitizeMealTimes(raw.mealTimes)
    };
  }

  return {
    DEFAULT_MIN_WAGE: DEFAULT_MIN_WAGE,
    sanitizeSettings: sanitizeSettings,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    RETAIN_MONTHS: RETAIN_MONTHS,
    emptyShifts: emptyShifts,
    createWorker: createWorker,
    newWorkerCode: newCode,
    cleanPassword: cleanPassword,
    normalizeWorkers: normalizeWorkers,
    migrateRoster: migrateRoster,
    workerSettings: workerSettings,
    workerShifts: workerShifts,
    workerExcuse: workerExcuse,
    workerPayrollInput: workerPayrollInput,
    setRecord: setRecord,
    recordMonths: recordMonths,
    retentionCutoff: retentionCutoff
  };
});
