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
    module.exports = factory(Object.assign({}, require('./i18n.js'), require('./payroll.js')));
  } else {
    root.AlbaEngine = root.AlbaEngine || {};
    Object.assign(root.AlbaEngine, factory(root.AlbaEngine));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P) {
  'use strict';

  var RETAIN_MONTHS = 60;          // 구글 시트의 월별 탭 보관 기간(5년)
  var MAX_WORKERS = 200;
  var MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  var BAD_ID = Object.create(null); BAD_ID['__proto__'] = BAD_ID.constructor = BAD_ID.prototype = 1;

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
      name: cleanName(name) || P.t('알바생'),
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
    var seen = Object.create(null);
    var seenCode = Object.create(null);
    (Array.isArray(list) ? list : []).slice(0, MAX_WORKERS).forEach(function (raw) {
      if (!isObj(raw)) return;
      var name = cleanName(raw.name);
      if (!name) return;
      var id = typeof raw.id === 'string' && /^[^|\s]{1,64}$/.test(raw.id) && !BAD_ID[raw.id] && !seen[raw.id] ? raw.id : newId();   // '|'는 확인 필요 항목의 열쇠 구분자라 못 씀
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
      if (Array.isArray(raw.pendingDone)) item.pendingDone = cleanDone(raw.pendingDone);
      if (Array.isArray(raw.pending)) item.pending = notDone(item, cleanPending(raw.pending));   // 빈 목록도 남김 (다른 기기와 합칠 때 '확인 끝남'을 알 수 있게)
      var hc = cleanHealth(raw.health);
      if (hc) item.health = hc;
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(raw.lastTs))) { item.lastTs = raw.lastTs; if (/^(in|out|auto)$/.test(String(raw.lastKind))) item.lastKind = raw.lastKind; }
      out.push(item);
    });
    return out;
  }

  /* ---------- 보건증(건강진단결과서) 만료 관리 ----------
   * 「식품위생 분야 종사자의 건강진단 규칙」 제2조: 유효기간 1년, 직전 유효기간 만료일 다음 날부터 기산,
   * 다음 검진은 만료일 전후 각 30일 이내. 1년 기간의 끝은 시작일 전날 (민법: 해당일이 없으면 그 달 말일) */
  var YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  var HEALTH_URGENT = 7;   // 이 날 수 이하로 남으면 '임박'(빨강)
  var HEALTH_WARN = [7, 14, 30];
  function validYmd(s) {
    var m = YMD_RE.exec(String(s));
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    return y >= 2000 && y <= 2100 && mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(y, mo, 0).getDate();
  }
  function ymdNums(s) { var m = YMD_RE.exec(s); return [+m[1], +m[2], +m[3]]; }
  function addDaysYmd(s, n) { var p = ymdNums(s); return ymdOf(new Date(p[0], p[1] - 1, p[2] + n)); }
  function daysBetween(a, b) {   // b - a (날 수, 시간대와 무관)
    var pa = ymdNums(a), pb = ymdNums(b);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }
  /** start 날부터 1년 유효할 때의 만료일 (예: 2026-05-10 → 2027-05-09, 2024-02-29 → 2025-02-28) */
  function yearEnd(start) {
    var p = ymdNums(start);
    if (p[1] === 2 && p[2] === 29) return (p[0] + 1) + '-02-28';
    return addDaysYmd(ymdOf(new Date(p[0] + 1, p[1] - 1, p[2])), -1);
  }
  /** 보건증 { exam?: 검진일, expire: 만료일, off?: 알림 끔 } 검사. 만료일이 없으면 검진일로 계산 */
  function cleanHealth(raw) {
    if (!isObj(raw)) return null;
    var o = {};
    if (validYmd(raw.exam)) o.exam = raw.exam;
    if (validYmd(raw.expire)) o.expire = raw.expire;
    else if (o.exam) o.expire = yearEnd(o.exam);
    if (raw.off === true) o.off = true;
    return o.expire || o.off ? o : null;
  }
  /**
   * 새로 검진했을 때의 새 만료일. 기존 만료일 전후 30일 안에 검진했으면 '기존 만료일 다음 날부터 1년',
   * 아니면(처음이거나 한참 지난 뒤) '검진일부터 1년'
   */
  function renewHealthExpire(health, exam) {
    if (!validYmd(exam)) return '';
    var old = health && validYmd(health.expire) ? health.expire : '';
    if (old && Math.abs(daysBetween(old, exam)) <= 30) return yearEnd(addDaysYmd(old, 1));
    return yearEnd(exam);
  }
  function cleanWarnDays(v) { v = Math.round(Number(v)); return HEALTH_WARN.indexOf(v) >= 0 ? v : 30; }
  /** 한 사람의 보건증 상태: off(알림 끔) | missing(미등록) | expired(만료) | urgent(7일 이내) | soon(warnDays 이내) | ok */
  function healthStatus(worker, today, warnDays) {
    var h = worker && worker.health;
    if (h && h.off) return { state: 'off' };
    if (!h || !validYmd(h.expire) || !validYmd(today)) return { state: 'missing' };
    var d = daysBetween(today, h.expire);
    var warn = cleanWarnDays(warnDays);
    return { state: d < 0 ? 'expired' : d <= HEALTH_URGENT ? 'urgent' : d <= warn ? 'soon' : 'ok', days: d, expire: h.expire };
  }
  /** 알림 목록 (만료 → 임박 → 곧 만료 → 미등록 순, 같은 단계는 남은 날 적은 순) */
  function healthAlerts(workers, today, warnDays) {
    var rank = { expired: 0, urgent: 1, soon: 2, missing: 3 };
    var out = [];
    (workers || []).forEach(function (w) {
      var st = healthStatus(w, today, warnDays);
      if (rank[st.state] === undefined) return;
      out.push({ id: w.id, name: w.name, state: st.state, days: st.days, expire: st.expire });
    });
    out.sort(function (a, b) { return rank[a.state] - rank[b.state] || (a.days || 0) - (b.days || 0) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
    return out;
  }

  /* ---------- 손님용 계좌 안내 (QR) ---------- */
  /** { bank: 은행, number: 계좌번호(숫자·하이픈), holder: 예금주 } — 하나라도 잘못되면 null */
  function cleanBank(raw) {
    if (!isObj(raw)) return null;
    var bank = String(raw.bank || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
    var number = String(raw.number || '').replace(/\s+/g, '').replace(/[^0-9-]/g, '');
    var holder = String(raw.holder || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 20);
    var digits = number.replace(/-/g, '').length;
    if (!bank || !holder || digits < 8 || digits > 20 || number.length > 30 || /^-|-$|--/.test(number)) return null;
    return { bank: bank, number: number, holder: holder };
  }
  function bankKey(b) { b = cleanBank(b); return b ? b.bank + '|' + b.number + '|' + b.holder : ''; }
  function b64url(bytes) {
    var A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_', out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + (i + 1 < bytes.length ? A[(n >> 6) & 63] : '') + (i + 2 < bytes.length ? A[n & 63] : '');
    }
    return out;
  }
  function utf8Bytes(s) {
    var e = encodeURIComponent(s), out = [];
    for (var i = 0; i < e.length; i++) {
      if (e[i] === '%') { out.push(parseInt(e.substr(i + 1, 2), 16)); i += 2; } else out.push(e.charCodeAt(i));
    }
    return out;
  }
  /**
   * 손님 휴대폰이 여는 안내 페이지 주소. 정보는 # 뒤에 담아 서버로 전송되지 않음
   * 형식: pay.html#d=<base64url(JSON [1, 은행, 계좌번호, 예금주, 매장명])>
   */
  function payUrl(base, bank, store) {
    var b = cleanBank(bank);
    if (!b) return '';
    var st = String(store || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 30);
    return String(base) + '#d=' + b64url(utf8Bytes(JSON.stringify([1, b.bank, b.number, b.holder, st])));
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

  /* 퇴근을 안 찍어 자동 퇴근된 근무: 기록은 하지 않고 '확인 필요'로 남김 { date, start, at, cut:'YYYY-MM-DD HH:MM' } */
  var HM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
  function cleanPending(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [], seen = {};
    raw.forEach(function (x) {
      if (!isObj(x) || !/^\d{4}-\d{2}-\d{2}$/.test(String(x.date)) || !HM_RE.test(String(x.start))) return;
      var k = x.date + ' ' + x.start;
      if (seen[k]) return;
      seen[k] = true;
      var o = { id: k, date: x.date, start: x.start };   // id: 기기끼리 합칠 때 같은 항목을 맞추는 열쇠
      if (HM_RE.test(String(x.at))) o.at = x.at;
      if (HM_RE.test(String(x.end))) o.end = x.end;   // 찍었지만 달력에 못 넣은 퇴근 시각 (사장님 확인용)
      if (/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(String(x.cut))) o.cut = x.cut;
      out.push(o);
    });
    return out.slice(-30);
  }
  /* 사장님이 이미 처리한(퇴근 기록·근무 없음) 확인 필요 항목의 id 목록. 다른 기기가 늦게 같은 자동 퇴근을 만들어도 되살아나지 않게 */
  var PEND_ID_RE = /^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/;
  function cleanDone(raw) {
    if (!Array.isArray(raw)) return [];
    var out = [], seen = {};
    raw.forEach(function (x) { x = String(x); if (PEND_ID_RE.test(x) && !seen[x]) { seen[x] = true; out.push(x); } });
    out.sort();   // 날짜·시각 순 (기기마다 같은 순서)
    return out.slice(-200);
  }
  function markDone(w, id) {
    var d = cleanDone(w.pendingDone);
    if (d.indexOf(id) < 0) d.push(id);
    w.pendingDone = cleanDone(d);
  }
  function notDone(w, list) {
    var d = cleanDone(w.pendingDone);
    return list.filter(function (p) { return d.indexOf(p.id) < 0; });
  }

  /* 자동 퇴근(영업 마감) 시각: 이 시각까지 퇴근을 안 찍으면 퇴근 처리하고 '확인 필요'로 남김. 기본 자정 */
  var AUTO_OUT_CHOICES = ['20:00', '21:00', '22:00', '23:00', '00:00', '01:00', '02:00', '03:00', '04:00', '05:00', '06:00'];
  var DEFAULT_AUTO_OUT = '00:00';
  function cleanAutoOut(v) { return AUTO_OUT_CHOICES.indexOf(String(v)) >= 0 ? String(v) : DEFAULT_AUTO_OUT; }
  /** 출근(실제 찍은 시각) 뒤 처음 돌아오는 자동 퇴근 시각 */
  function autoOutDeadline(open, cut) {
    cut = cleanAutoOut(cut);
    var y = Number(open.date.slice(0, 4)), m = Number(open.date.slice(5, 7)) - 1, d = Number(open.date.slice(8, 10));
    var t = open.at || open.time;
    var inAt = new Date(y, m, d, Number(t.slice(0, 2)), Number(t.slice(3)), 0);
    var dl = new Date(y, m, d, Number(cut.slice(0, 2)), Number(cut.slice(3)), 0);
    if (dl.getTime() <= inAt.getTime()) dl = new Date(y, m, d + 1, Number(cut.slice(0, 2)), Number(cut.slice(3)), 0);
    return dl;
  }

  var PUNCH_UNITS = [1, 5, 10, 15, 20, 30, 60];   // 출퇴근 시각을 끊는 단위(분). 1 = 끊지 않음
  var DEFAULT_PUNCH_UNIT = 30;
  function cleanUnit(u) {
    u = Number(u);
    return PUNCH_UNITS.indexOf(u) >= 0 ? u : DEFAULT_PUNCH_UNIT;
  }
  function hmFromMin(r) { return ('0' + Math.floor(r / 60)).slice(-2) + ':' + ('0' + (r % 60)).slice(-2); }

  /** 출근 시각: 단위로 올림. 유예(grace)가 있으면 정각 뒤 grace분까지는 정시로 봐줌.
   *  30분 단위: 08:59→09:00, 09:03→09:30 (유예 5분이면 09:00), 09:11→09:30 (자정을 넘기면 23:59로 제한) */
  function roundUpUnit(hm, unit, grace) {
    unit = cleanUnit(unit);
    grace = cleanGrace(grace, unit);
    var m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
    var r = Math.max(0, Math.ceil((m - grace) / unit) * unit);
    if (r >= 1440) return '23:59';
    return hmFromMin(r);
  }
  /** 퇴근 시각: 단위로 내림. 유예가 있으면 정각 grace분 전부터는 정시로 봐줌.
   *  30분 단위: 09:59→09:30 (유예 5분이면 10:00), 10:00 이후→10:00 */
  function roundDownUnit(hm, unit, grace) {
    unit = cleanUnit(unit);
    grace = cleanGrace(grace, unit);
    var m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
    var r = Math.floor((m + grace) / unit) * unit;
    if (r >= 1440) return '23:59';
    return hmFromMin(r);
  }
  /** 유예는 0·5·10·15분, 그리고 단위의 절반 이하만 (30분 단위면 15분까지, 10분 단위면 5분까지) */
  var GRACE_CHOICES = [0, 5, 10, 15];
  function graceChoices(unit) {
    unit = cleanUnit(unit);
    return GRACE_CHOICES.filter(function (g) { return g <= Math.floor(unit / 2); });
  }
  function cleanGrace(g, unit) {
    g = Number(g);
    var ok = graceChoices(unit), best = 0;
    ok.forEach(function (x) { if (x <= g) best = x; });
    return best;
  }
  /** 출퇴근 규칙 옵션 정리. 숫자만 주면(예전 방식) 그 단위로 올림·내림, 1이면 찍은 그대로 */
  function punchOpts(x) {
    if (x === undefined || x === null) x = {};
    if (typeof x !== 'object') x = { unit: x };
    var unit = cleanUnit(x.unit === undefined ? DEFAULT_PUNCH_UNIT : x.unit);
    var inMode = x.inMode === 'exact' ? 'exact' : 'round';
    var outMode = x.outMode === 'exact' ? 'exact' : 'round';
    if (unit === 1) { unit = 1; inMode = 'exact'; outMode = 'exact'; }
    return { unit: unit, inMode: inMode, outMode: outMode, graceIn: cleanGrace(x.graceIn, unit), graceOut: cleanGrace(x.graceOut, unit) };
  }
  /** 규칙에 따라 출근/퇴근 시각을 계산 */
  function ruleIn(hm, o) { return o.inMode === 'exact' ? hm : roundUpUnit(hm, o.unit, o.graceIn); }
  function ruleOut(hm, o) { return o.outMode === 'exact' ? hm : roundDownUnit(hm, o.unit, o.graceOut); }

  function roundUp30(hm) { return roundUpUnit(hm, 30); }

  function punchIsOpen(worker) { return !!(worker && cleanPunch(worker.punch)); }

  /**
   * 알바생이 비밀번호를 맞게 입력한 뒤 부르는 함수.
   *  - 출근 중이 아니면 → 출근 (지금 시각 기록)
   *  - 출근 중이고 16시간 안이면 → 퇴근 (그 날 달력 칸에 출근~퇴근 시각을 그대로 넣음)
   *  - 출근한 지 16시간이 넘었으면 → 퇴근 누락으로 보고 이전 기록은 버리고 새 출근
   * 같은 날 두 번 일하면 한 칸에 합치고 사이 시간은 휴게시간으로 뺀다.
   * 반환: { kind:'in'|'out'|'too_soon', date, start, end, note }
   */
  function applyPunch(worker, now, opts) {
    var r = applyPunch0(worker, now, opts);
    if (r.kind === 'in' || r.kind === 'out') markTs(worker, now, r.kind);
    return r;
  }
  function applyPunch0(worker, now, opts) {
    var o = punchOpts(opts);
    var open = cleanPunch(worker.punch);
    var today = ymdOf(now), time = hmOf(now);
    var note = '';
    if (open && opts && typeof opts === 'object' && opts.autoOut !== undefined && now.getTime() >= autoOutDeadline(open, opts.autoOut).getTime()) {
      // 자동 퇴근 시각이 이미 지났는데 아직 처리 전이면(앱이 꺼져 있었음 등) 먼저 퇴근 처리 → 확인 필요로 남기고 새 출근
      closeAsPending(worker, open, autoOutDeadline(open, opts.autoOut));
      open = null;
      note = P.t('이전 출근은 퇴근을 안 찍어 자동 퇴근, 확인 필요로 남김');
    }
    if (open) {
      var inMs = new Date(open.date + 'T' + (open.at || open.time) + ':00').getTime();
      var elapsed = (now.getTime() - inMs) / 60000;
      if (elapsed >= 0 && elapsed <= PUNCH_MAX_MIN) {
        if (elapsed < 1) return { kind: 'too_soon', date: open.date, start: open.time, end: time, note: '' };
        var endT = ruleOut(time, o);   // 퇴근: 내림(+유예) 또는 찍은 그대로
        if (o.inMode !== 'exact' && open.time === '23:59' && today !== open.date) {
          // 자정 직전 출근을 올림하면 다음 날 00:00 출근 → 다음 날 칸에 00:00부터 기록 (23:59~00:00 1분 근무가 생기지 않게)
          open = { date: today, time: '00:00', at: open.at };
        }
        if (today === open.date && toMin(endT) <= toMin(open.time)) {
          // 올림한 출근 시각(예: 09:30)보다 일찍, 또는 같은 시각으로 끊기면 근무 시간 0 → 기록은 남기지 않고 출근만 취소
          delete worker.punch;
          return { kind: 'out', date: open.date, start: open.time, end: open.time, note: P.t('출근 시각({t}) 전에 퇴근해서 근무 시간은 0시간이에요', { t: open.time }), empty: true };
        }
        var co = clockOut(worker, open, endT);
        if (co.unmerged) {
          // 같은 날 앞선 근무와 합치면 24시간이 넘음 → 앞선 근무는 그대로 두고, 이번 근무는 퇴근 시각과 함께 '확인 필요'로 남김
          delete worker.punch;
          var pp = cleanPending(worker.pending);
          pp.push({ date: open.date, start: open.time, at: open.at || open.time, end: endT, cut: today + ' ' + time });
          worker.pending = notDone(worker, cleanPending(pp));
          return { kind: 'out', date: open.date, start: open.time, end: endT, empty: true, held: true, note: P.t('같은 날 다른 근무와 합칠 수 없어 확인 필요로 남겼어요') };
        }
        return co;
      }
      note = P.t('이전 출근({d})은 퇴근 기록이 없어 무시하고 새로 출근 처리', { d: open.date + ' ' + open.time });
    }
    var rounded = ruleIn(time, o);   // 출근: 올림(+유예) 또는 찍은 그대로
    worker.punch = { date: today, time: rounded, at: time };
    return { kind: 'in', date: today, start: rounded, end: '', note: note };
  }

  function clockOut(worker, open, end) {
    var pm = open.date.slice(0, 7);
    var idx = Number(open.date.slice(8)) - 1;
    var shifts = workerShifts(worker, pm);
    var cur = shifts[idx];
    var start = open.time, breakMin = 0, merged = false;
    var s0 = toMin(start), e0 = toMin(end);
    if (e0 <= s0) e0 += 1440;   // 밤을 넘겨 퇴근
    if (cur && !cur.off && cur.start && cur.end && cur.start !== cur.end) {
      var cs = toMin(cur.start), ce = toMin(cur.end);
      if (ce <= cs) ce += 1440;
      var lo = Math.min(s0, cs), hi = Math.max(e0, ce);
      if (hi - lo < 1440) {
        // 같은 날 앞선 근무와 한 칸으로 합침: 사이 시간은 휴게, 겹치면 겹친 만큼은 한 번만 (앞선 근무를 지우지 않음)
        var gap = Math.max(0, Math.max(s0, cs) - Math.min(e0, ce));
        breakMin = (cur.breakMinutes || 0) + gap;
        start = pad2(Math.floor(lo / 60) % 24) + ':' + pad2(lo % 60);
        end = pad2(Math.floor(hi / 60) % 24) + ':' + pad2(hi % 60);
        merged = true;
      } else {
        // 앞선 근무와 합치면 24시간이 넘음 → 한 칸에 담을 수 없으니 앞선 근무를 지우지 않고 그대로 둠 (부른 쪽이 확인 필요로 남김)
        return { kind: 'out', unmerged: true, date: open.date, start: open.time, end: end };
      }
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
    return { kind: 'out', date: open.date, start: start, end: end, note: merged ? P.t('같은 날 앞선 근무와 합쳐 사이 시간을 휴게로 처리') : '' };
  }



  /**
   * 자정까지 퇴근을 안 찍은 사람은 그 출근을 무효로 하고 그 날은 휴무(근무 없음)로 둔다.
   * (달력 칸은 퇴근을 찍어야 채워지므로, 출근 중 표시만 지우면 된다. 그 날 앞서 끝난 근무가 있으면 그대로 남는다.)
   * 앱을 켜 둔 동안은 자정이 지나면, 꺼져 있었다면 다음에 열 때 처리한다.
   * 반환: 무효 처리된 사람 목록 [{worker, date, start, ts(자정 시각)}]
   */
  function closeAsPending(w, open, ts) {
    delete w.punch;
    markTs(w, ts, 'auto');
    var p = cleanPending(w.pending);
    p.push({ date: open.date, start: open.time, at: open.at || open.time, cut: ymdOf(ts) + ' ' + hmOf(ts) });
    w.pending = notDone(w, cleanPending(p));
    return { worker: w, date: open.date, start: open.time, ts: ts };
  }
  /**
   * 자동 퇴근 시각(기본 자정)까지 퇴근을 안 찍은 사람은 퇴근 처리하고, 근무 기록은 넣지 않고 '확인 필요'(pending)로 남긴다.
   * 사장님이 퇴근 시각을 넣으면(resolvePending) 그때 달력에 기록된다.
   * 반환: 처리한 사람 목록 [{worker, date, start, ts(자동 퇴근 시각)}]
   */
  function autoCloseOpen(workers, now, cut) {
    var out = [];
    (workers || []).forEach(function (w) {
      var open = cleanPunch(w.punch);
      if (!open) return;
      var dl = autoOutDeadline(open, cut);
      if (now.getTime() < dl.getTime()) return;
      out.push(closeAsPending(w, open, dl));
    });
    return out;
  }
  /** 확인 필요 근무에 사장님이 퇴근 시각을 넣음 → 그 날 달력에 기록 (지금 근무 중 상태는 그대로 둠) */
  function resolvePending(worker, i, end) {
    var p = cleanPending(worker.pending);
    var item = p[i];
    if (!item) return { ok: false, error: P.t('확인할 기록이 없어요.') };
    if (!HM_RE.test(String(end))) return { ok: false, error: P.t('퇴근 시각을 HH:MM 으로 넣어 주세요.') };
    if (end === item.start) return { ok: false, error: P.t('퇴근 시각이 출근 시각과 같아요.') };
    var keep = worker.punch;
    var r = clockOut(worker, { date: item.date, time: item.start, at: item.at }, end);
    if (keep) worker.punch = keep; else delete worker.punch;
    if (r.unmerged) return { ok: false, error: P.t('이 날에 이미 다른 근무가 있어 합치면 24시간이 넘어요. 달력에서 직접 고치거나 [근무 없음]으로 정리해 주세요.') };
    p.splice(i, 1);
    markDone(worker, item.id);
    worker.pending = p;
    return { ok: true, result: r };
  }
  /** 확인 필요 근무를 '근무 없음'으로 정리 */
  function dismissPending(worker, i) {
    var p = cleanPending(worker.pending);
    if (!p[i]) return false;
    markDone(worker, p[i].id);
    p.splice(i, 1);
    worker.pending = p;
    return true;
  }


  function tsStrOf(d) { return ymdOf(d) + ' ' + hmOf(d) + ':' + pad2(d.getSeconds()); }
  /* 이 알바생에게 마지막으로 반영한 출퇴근 기록 시각 → 장부를 다시 맞출 때 이미 반영한 줄은 건너뜀 (기기 시계가 달라도 같은 줄은 같은 시각 문자열) */
  function markTs(w, d, kind) { var t = tsStrOf(d); if (!w.lastTs || t >= w.lastTs) { w.lastTs = t; w.lastKind = kind; } }
  function rowKind(row) { return String(row[4] || '').indexOf('자동') === 0 ? 'auto' : (String(row[3] || '').trim() === '출근' ? 'in' : 'out'); }
  function parseLogTs(str) {
    var m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(str || '').trim());
    return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  }

  /**
   * 시트 '출퇴근기록' 장부로 상태 복구: 불러온 데이터(afterMs 시각 저장분)보다 나중에 찍힌 출근/퇴근 기록을
   * 시간순으로 다시 적용한다. rows 한 줄 = [기록시각, 고유코드, 이름, 구분, 입력방식, 처리결과, 메모]
   * 반환: 적용한 줄 수
   */
  function replayPunchLog(workers, rows, afterMs, opts) {
    var n = 0;
    // 기록시각 순서로 (오프라인이던 기기가 나중에 올린 줄이 시트 아래에 붙어도 시간순으로 적용). 같은 시각은 원래 순서 유지
    var list = (rows || []).map(function (row, i) { return { row: row, i: i, k: row && row[0] !== undefined ? String(row[0]).trim() : '' }; });
    list.sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : a.i - b.i; });
    list.forEach(function (it) {
      var row = it.row;
      if (!row || row.length < 4) return;
      var ts = parseLogTs(row[0]);
      if (!ts || ts.getTime() <= afterMs) return;
      var kind = String(row[3] || '').trim();
      if (String(row[5] || '').indexOf('정상') !== 0) return;
      var code = String(row[1] || '').trim();
      var w = (workers || []).filter(function (x) { return x.code === code; })[0];
      if (w && w.lastTs) {   // 이미 반영한 줄은 건너뜀 (같은 줄을 두 번 적용하지 않음). 같은 초에 다른 종류(자동 퇴근 직후 출근)는 반영
        var rt = String(row[0]).trim();
        if (rt < w.lastTs || (rt === w.lastTs && rowKind(row) === w.lastKind)) return;
      }
      var cut = opts && typeof opts === 'object' ? opts.autoOut : undefined;
      var closed = autoCloseOpen(workers, ts, cut);   // 그 사이 지난 자동 퇴근 시각 먼저 처리
      if (String(row[4] || '').indexOf('자동') === 0) {
        var op = w && cleanPunch(w.punch);
        if (op) { closeAsPending(w, op, ts); n++; }
        else if (closed.some(function (c) { return c.worker === w; })) n++;
        return;
      }
      if (kind !== '출근' && kind !== '퇴근') return;
      if (!w) return;
      var r = applyPunch(w, ts, opts);
      if (r.kind === 'in' || r.kind === 'out') n++;
    });
    return n;
  }

  /** 근무 중인 사람 모두 한꺼번에 퇴근 처리. 반환: [{worker, result}] (방금 출근해 too_soon 인 사람은 빠짐) */
  function applyPunchAll(workers, now, opts) {
    var out = [];
    (workers || []).forEach(function (w) {
      if (punchNext(w, now) !== 'out') return;
      // 자동 퇴근 시각이 이미 지난 사람은 일괄 퇴근에서 빼고(새 출근이 찍히지 않게) 자동 마감 처리에 맡김
      if (opts && typeof opts === 'object' && opts.autoOut !== undefined && now.getTime() >= autoOutDeadline(cleanPunch(w.punch), opts.autoOut).getTime()) return;
      var r = applyPunch(w, now, opts);
      if (r.kind === 'out') out.push({ worker: w, result: r });
    });
    return out;
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
    var byName = Object.create(null);
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
    var prev = worker.months[payMonth];
    worker.months[payMonth] = rec;
    var later = Object.keys(worker.months).filter(function (k) { return k > payMonth; });
    if (!later.length) {
      // 가장 최근 달: 알바생 기본값(시급·근무일·설정)도 이 달 기준으로
      worker.wage = rec.wage;
      worker.contractDays = rec.contractDays;
      worker.defaults = cleanDefaults(rec);
    } else if (prev && prev.wage !== rec.wage) {
      // 지난 달의 시급을 직접 바꾼 경우에만 이후 달·기본 시급에도 반영
      // (지난 달 근무 칸 수정·퇴근 확인·자정 넘긴 퇴근 등으로 다시 저장할 때 이번 달 인상분을 옛 시급으로 덮지 않게)
      later.forEach(function (k) { worker.months[k].wage = rec.wage; });
      worker.wage = rec.wage;
    }
    return rec;
  }

  /** 기록이 있는 달 목록 (오름차순) */
  function recordMonths(workers) {
    var set = Object.create(null);
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
    var pu = (function () {
      var r = raw || {};
      var legacyExact = Number(r.punchUnit) === 1;   // 예전 '끊지 않음' → 단위 30분 + 출근·퇴근 '찍은 그대로'
      return punchOpts({
        unit: legacyExact ? DEFAULT_PUNCH_UNIT : r.punchUnit,
        inMode: legacyExact ? 'exact' : r.punchInMode,
        outMode: legacyExact ? 'exact' : r.punchOutMode,
        graceIn: r.punchGraceIn,
        graceOut: r.punchGraceOut
      });
    })();
    raw = isObj(raw) ? raw : {};
    var mw = Math.round(Number(raw.minWage));
    return {
      minWage: isFinite(mw) && mw > 0 && mw < 1000000 ? mw : DEFAULT_MIN_WAGE,
      rates: P.sanitizeRates(raw.rates),
      mealTimes: P.sanitizeMealTimes(raw.mealTimes),
      punchUnit: pu.unit,
      punchInMode: pu.inMode,
      punchOutMode: pu.outMode,
      punchGraceIn: pu.graceIn,
      punchGraceOut: pu.graceOut,
      autoOutTime: cleanAutoOut((raw || {}).autoOutTime),
      healthWarnDays: cleanWarnDays(raw.healthWarnDays),
      bank: cleanBank(raw.bank)
    };
  }

  return {
    DEFAULT_MIN_WAGE: DEFAULT_MIN_WAGE,
    sanitizeSettings: sanitizeSettings,
    cleanHealth: cleanHealth,
    healthYearEnd: function (s) { return validYmd(s) ? yearEnd(s) : ''; },
    renewHealthExpire: renewHealthExpire,
    healthStatus: healthStatus,
    healthAlerts: healthAlerts,
    validYmd: validYmd,
    cleanBank: cleanBank,
    bankKey: bankKey,
    payUrl: payUrl,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    RETAIN_MONTHS: RETAIN_MONTHS,
    emptyShifts: emptyShifts,
    createWorker: createWorker,
    newWorkerCode: newCode,
    cleanPassword: cleanPassword,
    punchIsOpen: punchIsOpen,
    applyPunch: applyPunch,
    applyPunchAll: applyPunchAll,
    PUNCH_UNITS: PUNCH_UNITS,
    DEFAULT_PUNCH_UNIT: DEFAULT_PUNCH_UNIT,
    punchOpts: punchOpts,
    punchOptions: function (st) { st = st || {}; return punchOpts({ unit: st.punchUnit, inMode: st.punchInMode, outMode: st.punchOutMode, graceIn: st.punchGraceIn, graceOut: st.punchGraceOut }); },
    graceChoices: graceChoices,
    roundUpUnit: roundUpUnit,
    roundDownUnit: roundDownUnit,
    punchNext: punchNext,
    autoCloseOpen: autoCloseOpen,
    resolvePending: resolvePending,
    dismissPending: dismissPending,
    autoOutDeadline: autoOutDeadline,
    AUTO_OUT_CHOICES: AUTO_OUT_CHOICES,
    DEFAULT_AUTO_OUT: DEFAULT_AUTO_OUT,
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
