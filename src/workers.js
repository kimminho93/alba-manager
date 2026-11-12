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
      var pn = cleanPunch(raw.punch);
      if (pn) item.punch = pn;
      out.push(item);
    });
    return out;
  }

  /* ---------- 출퇴근 찍기 (매장 기기에서 알바생이 이름 → 비밀번호) ---------- */
  var PUNCH_MAX_MIN = 16 * 60;   // 출근 후 이 시간 안에 찍으면 '퇴근', 넘으면 퇴근을 안 찍은 것으로 보고 새 '출근'

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function ymdOf(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function hmOf(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function toMin(t) { var a = String(t).split(':'); return Number(a[0]) * 60 + Number(a[1]); }

  /* 출근 중인 기록 { date:'YYYY-MM-DD', time:'HH:MM' } 검사 */
  function cleanPunch(raw) {
    if (!isObj(raw)) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.date)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.time))) return null;
    var o = { date: raw.date, time: raw.time };
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(raw.at))) o.at = raw.at;   // 실제로 찍은 시각(올림 전)
    return o;
  }

  /** 출근 시각은 30분 단위로 올림: 09:00 → 09:00, 09:01 → 09:30, 09:31 → 10:00 (자정을 넘기면 23:59로 제한) */
  function roundUp30(hm) {
    var m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
    var r = Math.ceil(m / 30) * 30;
    if (r >= 1440) return '23:59';
    return ('0' + Math.floor(r / 60)).slice(-2) + ':' + ('0' + (r % 60)).slice(-2);
  }

  function punchIsOpen(worker) { return !!(worker && cleanPunch(worker.punch)); }

  /**
   * 알바생이 비밀번호를 맞게 입력한 뒤 부르는 함수.
   *  - 출근 중이 아니면 → 출근 (지금 시각 기록)
   *  - 출근 중이고 16시간 안이면 → 퇴근 (그 날 달력 칸에 출근~퇴근 시각을 그대로 넣음)
   *  - 출근한 지 16시간이 넘었으면 → 퇴근 누락으로 보고 이전 기록은 버리고 새 출근
   * 같은 날 두 번 일하면 한 칸에 합치고 사이 시간은 휴게시간으로 뺀다.
   * 반환: { kind:'in'|'out'|'too_soon', date, start, end, note }
   */
  function applyPunch(worker, now) {
    var open = cleanPunch(worker.punch);
    var today = ymdOf(now), time = hmOf(now);
    var note = '';
    if (open) {
      var inMs = new Date(open.date + 'T' + (open.at || open.time) + ':00').getTime();
      var elapsed = (now.getTime() - inMs) / 60000;
      if (elapsed >= 0 && elapsed <= PUNCH_MAX_MIN) {
        if (elapsed < 1) return { kind: 'too_soon', date: open.date, start: open.time, end: time, note: '' };
        if (today === open.date && toMin(time) < toMin(open.time)) {
          // 올림한 출근 시각(예: 09:30)보다 일찍 퇴근 → 근무 시간 0, 기록은 남기지 않고 출근만 취소
          delete worker.punch;
          return { kind: 'out', date: open.date, start: open.time, end: open.time, note: '출근 시각(' + open.time + ') 전에 퇴근해서 근무 시간은 0시간이에요', empty: true };
        }
        return clockOut(worker, open, time);
      }
      note = '이전 출근(' + open.date + ' ' + open.time + ')은 퇴근 기록이 없어 무시하고 새로 출근 처리';
    }
    var rounded = roundUp30(time);
    worker.punch = { date: today, time: rounded, at: time };
    return { kind: 'in', date: today, start: rounded, end: '', note: note };
  }

  function clockOut(worker, open, end) {
    var pm = open.date.slice(0, 7);
    var idx = Number(open.date.slice(8)) - 1;
    var shifts = workerShifts(worker, pm);
    var cur = shifts[idx];
    var start = open.time, breakMin = 0, merged = false;
    if (cur && !cur.off && toMin(cur.end) > toMin(cur.start) && toMin(end) > toMin(start) && toMin(start) >= toMin(cur.end)) {
      // 같은 날 앞선 근무가 있으면 한 칸으로 합치고 사이 시간은 휴게로
      breakMin = (cur.breakMinutes || 0) + (toMin(start) - toMin(cur.end));
      start = cur.start;
      merged = true;
    }
    if (idx >= 0 && idx < shifts.length) {
      shifts[idx] = { off: false, start: start, end: end, breakMinutes: breakMin };
      var s = workerSettings(worker, pm);
      setRecord(worker, pm, {
        wage: s.wage, contractDays: s.contractDays, includeWeekly: s.includeWeekly, includeMeal: s.includeMeal,
        mealMinHours: s.mealMinHours, mealAmount: s.mealAmount, tax: s.tax,
        dailyShifts: shifts, weekExcuse: workerExcuse(worker, pm)
      });
    }
    delete worker.punch;
    return { kind: 'out', date: open.date, start: start, end: end, note: merged ? '같은 날 앞선 근무와 합쳐 사이 시간을 휴게로 처리' : '' };
  }


  /**
   * 자정까지 퇴근을 안 찍은 사람은 그 출근을 무효로 하고 그 날은 휴무(근무 없음)로 둔다.
   * (달력 칸은 퇴근을 찍어야 채워지므로, 출근 중 표시만 지우면 된다. 그 날 앞서 끝난 근무가 있으면 그대로 남는다.)
   * 앱을 켜 둔 동안은 자정이 지나면, 꺼져 있었다면 다음에 열 때 처리한다.
   * 반환: 무효 처리된 사람 목록 [{worker, date, start, ts(자정 시각)}]
   */
  function autoCloseOpen(workers, now) {
    var today = ymdOf(now), out = [];
    (workers || []).forEach(function (w) {
      var open = cleanPunch(w.punch);
      if (!open || open.date >= today) return;
      var y = Number(open.date.slice(0, 4)), m = Number(open.date.slice(5, 7)), d = Number(open.date.slice(8, 10));
      delete w.punch;
      out.push({ worker: w, date: open.date, start: open.time, ts: new Date(y, m - 1, d + 1, 0, 0, 0) });
    });
    return out;
  }

  function parseLogTs(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(str || '').trim());
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  }

  /**
   * 시트 '출퇴근기록' 장부로 상태 복구: 불러온 데이터(afterMs 시각 저장분)보다 나중에 찍힌 출근/퇴근 기록을
   * 시간순으로 다시 적용한다. rows 한 줄 = [기록시각, 고유코드, 이름, 구분, 입력방식, 처리결과, 메모]
   * 반환: 적용한 줄 수
   */
  function replayPunchLog(workers, rows, afterMs) {
    var n = 0;
    (rows || []).forEach(function (row) {
      if (!row || row.length < 4) return;
      var ts = parseLogTs(row[0]);
      if (!ts || ts.getTime() <= afterMs) return;
      var kind = String(row[3] || '').trim();
      if (String(row[5] || '').indexOf('정상') !== 0) return;
      if (String(row[4] || '').indexOf('자동') === 0) { n += autoCloseOpen(workers, ts).length ? 1 : 0; return; }
      if (kind !== '출근' && kind !== '퇴근') return;
      var code = String(row[1] || '').trim();
      var w = (workers || []).filter(function (x) { return x.code === code; })[0];
      if (!w) return;
      var r = applyPunch(w, ts);
      if (r.kind === 'in' || r.kind === 'out') n++;
    });
    return n;
  }

  /** 지금 찍으면 어떤 처리가 되는지: 'in'(출근) | 'out'(퇴근) */
  function punchNext(worker, now) {
    var open = cleanPunch(worker && worker.punch);
    if (!open) return 'in';
    var elapsed = (now.getTime() - new Date(open.date + 'T' + (open.at || open.time) + ':00').getTime()) / 60000;   // 올림 전(실제 찍은) 시각 기준
    return elapsed >= 0 && elapsed <= PUNCH_MAX_MIN ? 'out' : 'in';
  }

  /** 이번 달(payMonth) 일한 일수·누적 근무시간 (퇴근까지 끝난 날만) */
  function monthSummary(worker, payMonth) {
    var r = P.calculatePayroll(workerPayrollInput(worker, payMonth));
    return { workDays: r.workDays || 0, totalHours: r.totalHours || 0 };
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
    punchIsOpen: punchIsOpen,
    applyPunch: applyPunch,
    punchNext: punchNext,
    autoCloseOpen: autoCloseOpen,
    replayPunchLog: replayPunchLog,
    monthSummary: monthSummary,
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
