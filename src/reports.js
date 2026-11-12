/*
 * src/reports.js — 급여명세서 / 정산 명단 / 점검표 / 점검 보관함 엑셀 시트 구성
 *   계산 결과(payroll/checklist) → xlsx 시트 정의 → buildXlsx() 바이너리
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(Object.assign({}, require('./math_ops.js'), require('./stats.js'), require('./xlsx.js')));
  } else {
    root.AlbaEngine = root.AlbaEngine || {};
    Object.assign(root.AlbaEngine, factory(root.AlbaEngine));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  function H(v) { return { v: v, s: 'header' }; }
  function T(v) { return { v: v === null || v === undefined ? '' : String(v), s: 'text' }; }
  function B(v) { return { v: String(v), s: 'textBold' }; }
  function N(v) { return { v: v, s: 'num' }; }
  function W(v) { return { v: v, s: 'money' }; }
  function WB(v) { return { v: v, s: 'moneyBold' }; }
  function TITLE(v) { return { v: v, s: 'title' }; }
  function P(v) { return { v: v, s: 'plain' }; }
  function S(style, v) { return { v: v === null || v === undefined ? '' : v, s: style }; }
  function fill(n, style) { var a = []; for (var i = 0; i < n; i++) a.push(S(style, '')); return a; }
  function won(v) { return M.formatWon(v); }
  function md(dateStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    return m ? (Number(m[2]) + '/' + Number(m[3])) : '';
  }

  function fmtTemp(t) {
    return t === null || t === undefined ? '미입력' : M.formatNum(t, 1) + '°C';
  }

  function safeFilePart(s) {
    return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30) || '미입력';
  }

  /* ---------------- 급여 ---------------- */

  // 주 판정 문구/스타일 (엑셀용)
  function weekVerdict(r, w) {
    if (!r.includeWeekly) return { text: '주휴 미포함', style: 'cText' };
    if (w.eligible && !w.excused) return { text: '대상 (개근)', style: 'okC' };
    if (w.excused) return { text: '지급 (결근 있으나 인정)', style: 'warn' };
    if (!w.hoursOk) return { text: '제외 (15시간 미만)', style: 'badC' };
    return { text: '제외 (결근)', style: 'badC' };
  }

  function weekPeriod(r, w) {
    var ds = (r.days || []).filter(function (d) { return d.week === w.week && d.dateStr; });
    if (!ds.length) return '-';
    return md(ds[0].dateStr) + ' ~ ' + md(ds[ds.length - 1].dateStr);
  }

  /* ① 요약: 한눈에 보는 정산서 */
  function payrollSummarySheet(r, name) {
    var rows = [];
    var merges = [];
    var heights = {};
    var eligibleWeeks = r.weeks.filter(function (w) { return r.includeWeekly && w.eligible; }).length;
    var absentWeeks = r.weeks.filter(function (w) { return w.absent && !w.excused; }).length;
    var isDaily = r.mode === 'daily';

    rows.push([S('band', '급여 정산서  ·  ' + r.name)].concat(fill(5, 'band')));
    merges.push('A1:F1'); heights[0] = 40;
    rows.push([S('sub', r.name + '님 · ' + r.payMonthLabel + ' · 시급 ' + won(r.hourlyWage) + '원 · 주 ' + r.contractDays + '일 근무 약속 · 세금 ' + r.tax.label)].concat(fill(5, 'sub')));
    merges.push('A2:F2'); heights[1] = 24;
    rows.push([]);

    rows.push([S('section', '■ 이번 달 지급액')].concat(fill(5, 'section')));
    merges.push('A4:F4');
    rows.push([S('bigLabel', '실수령액 (입금하실 금액)'), S('bigLabel', ''), S('bigLabel', ''), S('bigMoney', r.net), S('bigMoney', ''), S('bigMoney', '')]);
    merges.push('A5:C5', 'D5:F5'); heights[4] = 48;
    rows.push([]);

    rows.push([S('section', '■ 근무 요약')].concat(fill(5, 'section')));
    merges.push('A7:F7');
    rows.push([S('label', '총 근무시간'), S('hours', r.totalHours), S('label', '출근일수'), isDaily ? S('cText', r.workDays + '일') : S('cText', '-'),
      S('label', '주 약속일수'), S('cText', '주 ' + r.contractDays + '일')]);
    rows.push([S('label', '식대 지급일'), S('cText', r.includeMeal ? r.mealDays + '일' : '미포함'), S('label', '주휴 대상 주'),
      S('cText', r.includeWeekly ? (eligibleWeeks + ' / ' + r.weeks.length + '주') : '미포함'),
      S('label', '결근으로 제외된 주'), S(absentWeeks ? 'badC' : 'okC', absentWeeks + '주')]);
    rows.push([]);

    rows.push([S('section', '■ 급여 내역')].concat(fill(5, 'section')));
    merges.push('A11:F11');
    rows.push([H('항목'), H(''), H('금액(원)'), H('계산 방법'), H(''), H('')]);
    merges.push('A12:B12', 'D12:F12');
    function line(label, amount, note, strong) {
      rows.push([S('label', label), S('label', ''), S(strong ? 'moneyCBold' : 'moneyC', amount), S('value', note), S('value', ''), S('value', '')]);
      var n = rows.length;
      merges.push('A' + n + ':B' + n, 'D' + n + ':F' + n);
    }
    line('기본급', r.basePay, M.formatNum(r.totalHours, 2) + '시간 × ' + won(r.hourlyWage) + '원');
    line('주휴수당', r.weeklyAllowance, r.includeWeekly ? (eligibleWeeks + '주 대상 (15시간 이상 + 약속 출근일 개근)') : '미포함');
    line('식대', r.mealAllowance || 0, r.includeMeal ? (r.mealDays + '일 × ' + won(r.mealAmount) + '원 (하루 ' + M.formatNum(r.mealMinHours, 1) + '시간 이상 근무한 날)') : '미포함');
    if (r.lateDeduction) line('지각·조퇴 차감', -r.lateDeduction, r.lateMinutes + '분');
    line('세전 총액', r.gross, '기본급 + 주휴수당 + 식대', true);
    line('공제 합계', r.tax.total ? -r.tax.total : 0, r.tax.label);
    line('실수령액', r.net, '세전 총액 − 공제 합계', true);
    rows.push([]);
    rows.push([S('sub', '※ 본 정산서는 참고용입니다. 실제 신고·납부는 세무·노무 전문가에게 확인하세요.')].concat(fill(5, 'sub')));
    merges.push('A' + rows.length + ':F' + rows.length);

    return { name: name || '요약', rows: rows, colWidths: [16, 16, 16, 18, 16, 20], merges: merges,
      tabColor: 'FF1F3A8A', hideGrid: true, rowHeights: heights };
  }

  /* ② 급여명세서 (근로기준법 임금명세서 양식) */
  function payrollSlipSheet(r, name) {
    var rows = [];
    var merges = ['A1:D1', 'A2:D2'];
    rows.push([S('band', '표준 급여명세서 (임금명세서)')].concat(fill(3, 'band')));
    rows.push([S('sub', '근로기준법 제48조 제2항 · 같은 법 시행령 제27조의2 기재사항 기준')].concat(fill(3, 'sub')));
    rows.push([]);
    rows.push([S('label', '성명'), S('value', r.name), S('label', '지급월'), S('value', r.payMonthLabel)]);
    rows.push([S('label', '시급'), S('moneyC', r.hourlyWage), S('label', '총 근무시간'), S('hours', r.totalHours)]);
    rows.push([
      S('label', '주휴수당 / 식대'),
      S('value', '주휴 ' + (r.includeWeekly ? '포함' : '미포함') + ' / 식대 ' + (r.includeMeal ? (r.mealDays + '일 지급') : '미포함')),
      S('label', '세금 방식'),
      S('value', r.tax.label)
    ]);
    rows.push([]);
    rows.push([H('구분'), H('항목'), H('금액(원)'), H('산출식 (계산 방법)')]);
    r.rows.forEach(function (row) {
      var strong = row.kind === 'total' || row.kind === 'subtotal';
      var amount = row.sign < 0 && row.amount ? -row.amount : row.amount;
      var label = row.label + (row.badge ? ' [' + row.badge + ']' : '');
      rows.push([
        S('cText', row.section),
        strong ? S('label', label) : S('value', label),
        S(strong ? 'moneyCBold' : 'moneyC', amount),
        S('value', row.formula + (row.detail ? '\n' + row.detail : ''))
      ]);
    });
    rows.push([]);
    rows.push([S('label', r.message)].concat(fill(3, 'label')));
    merges.push('A' + rows.length + ':D' + rows.length);
    return { name: name || '급여명세서', rows: rows, colWidths: [14, 30, 18, 76], merges: merges,
      tabColor: 'FF3563F0', hideGrid: true, rowHeights: { 0: 40, 1: 24 } };
  }

  /* ③ 출퇴근 기록: 날짜별 출근/퇴근/근무시간/식대 */
  function payrollAttendanceSheet(r, name) {
    var rows = [];
    var merges = ['A1:J1', 'A2:J2'];
    var COLS = 10;
    rows.push([S('band', '출퇴근 기록  ·  ' + r.name + ' (' + r.payMonthLabel + ')')].concat(fill(COLS - 1, 'band')));
    rows.push([S('sub', '출근·퇴근 시각, 휴게시간을 뺀 근무시간, 식대 지급 여부를 날짜별로 정리했습니다.  ' +
      (r.includeMeal ? '식대: 하루 ' + M.formatNum(r.mealMinHours, 1) + '시간 이상 근무한 날 ' + won(r.mealAmount) + '원' : ''))].concat(fill(COLS - 1, 'sub')));
    rows.push([]);
    rows.push([H('날짜'), H('요일'), H('주차'), H('출근'), H('퇴근'), H('휴게(분)'), H('근무시간(h)'), H('식대 지급'), H('식대(원)'), H('비고')]);

    var workDays = 0, totalH = 0, mealDaysN = 0, mealSum = 0;
    (r.days || []).forEach(function (d) {
      var off = d.off || d.hours <= 0;
      var dow = d.dayName || '';
      var isSat = d.dayIndex === 5, isSun = d.dayIndex === 6;
      var dateStyle = off ? 'cOff' : (isSun ? 'cSun' : (isSat ? 'cSat' : 'cText'));
      var meal = r.includeMeal && d.mealEligible;
      var note = '';
      if (off) note = '휴무';
      else if (r.includeMeal && !meal) note = '식대 기준(' + M.formatNum(r.mealMinHours, 1) + '시간) 미달';
      if (!off) { workDays++; totalH += d.hours; }
      if (meal) { mealDaysN++; mealSum += r.mealAmount; }
      rows.push([
        S(dateStyle, d.dateStr ? md(d.dateStr) : (d.date ? d.date + '일' : '')),
        S(dateStyle, dow),
        S(off ? 'cOff' : 'cText', d.week + '주차'),
        S(off ? 'cOff' : 'cText', off ? '-' : d.start),
        S(off ? 'cOff' : 'cText', off ? '-' : d.end),
        off ? S('cOff', '-') : S('cText', d.breakMinutes || 0),
        off ? S('cOff', '-') : S('hours', d.hours),
        r.includeMeal ? (meal ? S('okC', '지급') : S(off ? 'cOff' : 'cText', '-')) : S(off ? 'cOff' : 'cText', '미포함'),
        meal ? S('moneyC', r.mealAmount) : S(off ? 'cOff' : 'cText', '-'),
        S(off ? 'cOff' : 'value', note)
      ]);
    });
    rows.push([S('tot', '합계'), S('tot', workDays + '일 출근'), S('tot', ''), S('tot', ''), S('tot', ''), S('tot', ''),
      S('hoursTot', M.round2(totalH)), S('tot', r.includeMeal ? mealDaysN + '일' : '-'),
      S('moneyCBold', r.includeMeal ? mealSum : 0), S('tot', '')]);

    return { name: name || '출퇴근 기록', rows: rows, colWidths: [10, 8, 9, 10, 10, 10, 13, 11, 12, 30], merges: merges,
      tabColor: 'FF10915A', freezeRows: 4, landscape: false, rowHeights: { 0: 40, 1: 36 } };
  }

  /* ④ 주차별 요약: 약속 출근일수 · 출근일수 · 주휴 판정 */
  function payrollWeeklySheet(r, name) {
    var rows = [];
    var COLS = 9;
    var merges = ['A1:I1', 'A2:I2'];
    rows.push([S('band', '주차별 요약  ·  ' + r.name + ' (' + r.payMonthLabel + ')')].concat(fill(COLS - 1, 'band')));
    rows.push([S('sub', '약속한 출근일수(주 ' + r.contractDays + '일)와 실제 출근일수를 비교해 주휴수당 지급 여부를 판정했습니다.')].concat(fill(COLS - 1, 'sub')));
    rows.push([]);
    rows.push([H('주차'), H('기간'), H('약속 출근일수'), H('실제 출근일수'), H('근무시간(h)'), H('식대 지급일'), H('식대(원)'), H('주휴 판정'), H('주휴수당(원)')]);

    var isDaily = r.mode === 'daily';
    var totH = 0, totMeal = 0, totMealWon = 0, totAllow = 0;
    r.weeks.forEach(function (w) {
      var v = weekVerdict(r, w);
      var mealN = isDaily ? (w.mealDays || 0) : null;
      var ok = isDaily ? w.workDays >= w.contractDays || w.partial : !w.absent;
      totH += w.hours; totAllow += w.allowance;
      if (isDaily && r.includeMeal) { totMeal += mealN; totMealWon += mealN * r.mealAmount; }
      rows.push([
        S('cText', w.week + '주차'),
        S('cText', isDaily ? weekPeriod(r, w) : '-'),
        S('cText', w.partial ? '월 경계 주' : w.contractDays + '일'),
        isDaily ? S(w.partial ? 'cText' : (w.absent && !w.excused ? 'badC' : (ok ? 'okC' : 'cText')), w.workDays + '일') : S(w.absent ? 'badC' : 'cText', w.absent ? '결근 있음' : '-'),
        S('hours', w.hours),
        r.includeMeal ? (isDaily ? S('cText', mealN + '일') : S('cText', '-')) : S('cText', '미포함'),
        r.includeMeal && isDaily ? S('moneyC', mealN * r.mealAmount) : S('cText', '-'),
        S(v.style, v.text),
        S('moneyC', w.allowance)
      ]);
    });
    rows.push([S('tot', '합계'), S('tot', ''), S('tot', ''), S('tot', isDaily ? r.workDays + '일' : '-'),
      S('hoursTot', M.round2(totH)),
      S('tot', r.includeMeal ? (isDaily ? totMeal + '일' : r.mealDays + '일') : '-'),
      S('moneyCBold', r.includeMeal ? (isDaily ? totMealWon : r.mealAllowance) : 0), S('tot', ''), S('moneyCBold', totAllow)]);
    rows.push([]);
    rows.push([S('sub', '※ 주휴수당 조건: 주 15시간 이상 + 약속한 출근일을 모두 출근한 주. 공휴일·사업주 사정으로 쉰 주는 사업주가 "지급"으로 인정하면 지급됩니다.')].concat(fill(COLS - 1, 'sub')));
    merges.push('A' + rows.length + ':I' + rows.length);
    return { name: name || '주차별 요약', rows: rows, colWidths: [10, 16, 14, 14, 13, 12, 12, 24, 15], merges: merges,
      tabColor: 'FFB7791F', freezeRows: 4, rowHeights: { 0: 40, 1: 24, [rows.length - 1]: 34 } };
  }

  // 한 사람의 엑셀 탭 묶음 (날짜별 입력일 때만 출퇴근 기록 탭 포함)
  function payrollSheets(r, prefix) {
    var pre = prefix || '';
    var sheets = [payrollSummarySheet(r, pre + '요약'), payrollSlipSheet(r, pre + '급여명세서')];
    if (r.mode === 'daily' && Array.isArray(r.days) && r.days.length) sheets.push(payrollAttendanceSheet(r, pre + '출퇴근 기록'));
    sheets.push(payrollWeeklySheet(r, pre + '주차별 요약'));
    return sheets;
  }

  /* ---------------- 정산 명단(여러 명·여러 달) ----------------
   * 사람 수가 늘어도 탭이 늘지 않도록 "월" 단위로 묶는다.
   *   [전체 요약] + 월마다 [정산] [근무기록] [주휴판정] 3개 탭
   */
  function monthKey(r) { return r.payMonth || '월 미지정'; }
  function monthTitle(key) {
    var m = /^(\d{4})-(\d{2})$/.exec(key);
    return m ? (m[1] + '년 ' + Number(m[2]) + '월') : key;
  }

  function groupByMonth(results) {
    var map = {};
    results.forEach(function (r) { (map[monthKey(r)] = map[monthKey(r)] || []).push(r); });
    return Object.keys(map).sort().map(function (k) { return { key: k, title: monthTitle(k), list: map[k] }; });
  }

  // 한 사람이 그 달에 출근한 날수 (날짜별 입력이 아니면 null)
  function dayCount(r) { return r.mode === 'daily' ? r.workDays : null; }

  function sumDays(list) {
    return list.reduce(function (s, r) { return s + (dayCount(r) || 0); }, 0);
  }

  /* [전체 요약] 월별 인원·총 근무일수·총 근무시간·인건비 */
  function payrollOverviewSheet(groups) {
    var COLS = 10;
    var rows = [];
    var all = [];
    groups.forEach(function (g) { all = all.concat(g.list); });
    rows.push([S('band', '알바 급여 정산  ·  전체 요약')].concat(fill(COLS - 1, 'band')));
    rows.push([S('sub', '월별 인원, 총 근무일수(출근 연인원), 총 근무시간, 급여 합계입니다. 자세한 내용은 각 월의 [정산] [근무기록] [주휴판정] 탭에서 확인하세요.')].concat(fill(COLS - 1, 'sub')));
    rows.push([]);
    rows.push([H('월'), H('인원'), H('총 근무일수'), H('총 근무시간(h)'), H('기본급'), H('주휴수당'), H('식대'), H('세전 총액'), H('공제 합계'), H('실수령액 합계')]);
    var T0 = { n: 0, d: 0, h: 0, base: 0, wk: 0, meal: 0, gross: 0, tax: 0, net: 0 };
    groups.forEach(function (g) {
      var s = M.summarizePayrolls(g.list);
      var days = sumDays(g.list);
      T0.n += s.count; T0.d += days; T0.h += s.totalHours; T0.base += s.totalBase; T0.wk += s.totalWeekly;
      T0.meal += s.totalMeal || 0; T0.gross += s.totalGross; T0.tax += s.totalTax || 0; T0.net += s.totalNet;
      rows.push([S('cText', g.title), S('cText', s.count + '명'), S('cText', days + '일'), S('hours', s.totalHours), S('moneyC', s.totalBase),
        S('moneyC', s.totalWeekly), S('moneyC', s.totalMeal || 0), S('moneyC', s.totalGross),
        S('moneyC', s.totalTax ? -s.totalTax : 0), S('moneyCBold', s.totalNet)]);
    });
    rows.push([S('tot', '전체 합계'), S('tot', ''), S('tot', T0.d + '일'), S('hoursTot', M.round2(T0.h)), S('moneyCBold', T0.base),
      S('moneyCBold', T0.wk), S('moneyCBold', T0.meal), S('moneyCBold', T0.gross), S('moneyCBold', T0.tax ? -T0.tax : 0), S('moneyCBold', T0.net)]);
    rows.push([]);
    rows.push([S('sub', '※ 총 근무일수는 "날짜별" 입력 방식으로 정산한 사람의 출근일수만 합산합니다 (주차별·월 합계 입력은 출근일을 알 수 없어 제외).')].concat(fill(COLS - 1, 'sub')));
    return { name: '전체 요약', rows: rows, colWidths: [14, 8, 13, 15, 14, 13, 13, 14, 13, 16],
      merges: ['A1:J1', 'A2:J2', 'A' + rows.length + ':J' + rows.length],
      tabColor: 'FF1F3A8A', hideGrid: true, freezeRows: 4, rowHeights: { 0: 40, 1: 36 } };
  }

  /* [월 정산] 한 줄에 1명 + 총 근무일수/근무시간 합계 */
  function payrollMonthSettleSheet(g) {
    var COLS = 14;
    var s = M.summarizePayrolls(g.list);
    var rows = [];
    rows.push([S('band', g.title + ' 급여 정산')].concat(fill(COLS - 1, 'band')));
    rows.push([S('sub', '총 ' + s.count + '명 · 총 근무일수 ' + sumDays(g.list) + '일 · 총 근무시간 ' + M.formatNum(s.totalHours, 2) + '시간 · 총 입금액 ' + won(s.totalNet) + '원')].concat(fill(COLS - 1, 'sub')));
    rows.push([]);
    rows.push([H('No'), H('성명'), H('시급'), H('주 약속일수'), H('근무일수'), H('근무시간(h)'), H('기본급'), H('주휴수당'),
      H('식대'), H('지각차감'), H('세전총액'), H('세금 방식'), H('공제합계'), H('실수령액')]);
    g.list.forEach(function (r, i) {
      rows.push([S('cText', i + 1), S('cText', r.name), S('moneyC', r.hourlyWage), S('cText', '주 ' + r.contractDays + '일'),
        S('cText', dayCount(r) === null ? '-' : dayCount(r) + '일'), S('hours', r.totalHours), S('moneyC', r.basePay),
        S('moneyC', r.weeklyAllowance), S('moneyC', r.mealAllowance || 0), S('moneyC', r.lateDeduction ? -r.lateDeduction : 0),
        S('moneyC', r.gross), S('cText', r.tax.label), S('moneyC', r.tax.total ? -r.tax.total : 0), S('moneyCBold', r.net)]);
    });
    rows.push([S('tot', '합계'), S('tot', s.count + '명'), S('tot', ''), S('tot', ''), S('tot', sumDays(g.list) + '일'),
      S('hoursTot', s.totalHours), S('moneyCBold', s.totalBase), S('moneyCBold', s.totalWeekly), S('moneyCBold', s.totalMeal || 0),
      S('moneyCBold', s.totalLate ? -s.totalLate : 0), S('moneyCBold', s.totalGross), S('tot', ''),
      S('moneyCBold', s.totalTax ? -s.totalTax : 0), S('moneyCBold', s.totalNet)]);
    return { name: g.key + ' 정산', rows: rows, colWidths: [6, 12, 10, 12, 11, 12, 13, 12, 12, 11, 13, 22, 12, 15],
      merges: ['A1:N1', 'A2:N2'], tabColor: 'FF3563F0', freezeRows: 4, landscape: true, rowHeights: { 0: 40, 1: 24 } };
  }

  /* [월 근무기록] 날짜 순으로 그날 출근한 사람의 출근·퇴근·근무시간·식대 + 그 사람의 누적 근무일수/시간
   *  (사람별 총합은 [정산] 탭에 있으므로 이 탭에는 별도 합계 목록을 두지 않고, 누적 열의 마지막 값이 개인별 총합) */
  function payrollMonthAttendanceSheet(g) {
    var COLS = 12;
    var recs = [];
    var skipped = [];
    g.list.forEach(function (r, ri) {
      if (r.mode !== 'daily' || !Array.isArray(r.days) || !r.days.length) { skipped.push(r.name); return; }
      r.days.forEach(function (d) {
        if (d.off || d.hours <= 0) return;
        recs.push({ r: r, ri: ri, d: d, key: d.dateStr || String(d.index + 1).padStart(3, '0') });
      });
    });
    recs.sort(function (a, b) { return a.key < b.key ? -1 : (a.key > b.key ? 1 : (a.r.name < b.r.name ? -1 : (a.r.name > b.r.name ? 1 : 0))); });

    var perDate = {};
    recs.forEach(function (x) { perDate[x.key] = (perDate[x.key] || 0) + 1; });

    var rows = [];
    rows.push([S('band', g.title + ' 근무기록  (날짜별 출근한 사람)')].concat(fill(COLS - 1, 'band')));
    rows.push([S('sub', '날짜 순으로 그날 출근한 사람의 출근·퇴근 시각, 근무시간, 식대를 정리했습니다. "누적" 열은 그 사람이 그날까지 일한 일수·시간이며, 마지막 값이 그 사람의 총 근무일수·시간입니다 ([정산] 탭에도 있습니다). 제목 행 ▼ 버튼으로 이름·날짜별로 걸러볼 수 있습니다.')].concat(fill(COLS - 1, 'sub')));
    rows.push([]);
    rows.push([H('날짜'), H('요일'), H('이름'), H('출근'), H('퇴근'), H('휴게(분)'), H('근무시간(h)'), H('누적 근무일수'), H('누적 근무시간(h)'), H('식대 지급'), H('식대(원)'), H('그날 출근 인원')]);
    var headerRow = rows.length;
    var lastKey = null, zebra = false;
    var cum = {};
    recs.forEach(function (x) {
      var d = x.d, r = x.r;
      var first = x.key !== lastKey;
      if (first) { zebra = !zebra; lastKey = x.key; }
      var z = zebra ? 'Z' : '';
      var cT = zebra ? 'cTextZ' : 'cText';
      var meal = r.includeMeal && d.mealEligible;
      var c = cum[x.ri] = cum[x.ri] || { days: 0, hours: 0 };
      c.days += 1; c.hours = M.round2(c.hours + d.hours);
      var dateStyle = d.dayIndex === 6 ? 'cSun' : (d.dayIndex === 5 ? 'cSat' : cT);
      rows.push([
        S(dateStyle, d.dateStr ? md(d.dateStr) : ''), S(dateStyle, d.dayName || ''), S(cT, r.name),
        S(cT, d.start), S(cT, d.end), S(cT, d.breakMinutes || 0), S('hours' + z, d.hours),
        S(cT, c.days + '일'), S('hours' + z, c.hours),
        r.includeMeal ? (meal ? S('okC', '지급') : S(cT, '기준 미달')) : S(cT, '미포함'),
        meal ? S('moneyC' + z, r.mealAmount) : S(cT, '-'),
        first ? S(cT, perDate[x.key] + '명') : S(cT, '')
      ]);
    });
    var lastData = rows.length;
    var merges = ['A1:L1', 'A2:L2'];
    if (skipped.length) {
      rows.push([]);
      rows.push([S('sub', '※ 날짜별 기록이 없는 입력 방식(주차별·월 합계)이라 제외된 사람: ' + skipped.join(', '))].concat(fill(COLS - 1, 'sub')));
      merges.push('A' + rows.length + ':L' + rows.length);
    }
    return { name: g.key + ' 근무기록', rows: rows, colWidths: [10, 8, 12, 10, 10, 10, 13, 14, 16, 11, 11, 14],
      merges: merges, tabColor: 'FF10915A', freezeRows: headerRow, rowHeights: { 0: 40, 1: 52 },
      autoFilter: 'A' + headerRow + ':L' + lastData };
  }

  /* [월 주휴판정] 사람별·주차별 약속일수/출근일수/판정 */
  function payrollMonthWeeklySheet(g) {
    var COLS = 9;
    var rows = [];
    rows.push([S('band', g.title + ' 주휴수당 판정')].concat(fill(COLS - 1, 'band')));
    rows.push([S('sub', '주 15시간 이상 + 약속한 출근일을 모두 출근한 주에 주휴수당이 지급됩니다. 공휴일·사업주 사정으로 쉰 주는 사업주가 "지급"으로 인정하면 지급됩니다.')].concat(fill(COLS - 1, 'sub')));
    rows.push([]);
    rows.push([H('이름'), H('주차'), H('기간'), H('약속 출근일수'), H('실제 출근일수'), H('근무시간(h)'), H('주휴 판정'), H('주휴수당(원)'), H('식대 지급일')]);
    var headerRow = rows.length;
    var totH = 0, totA = 0;
    g.list.forEach(function (r) {
      var isDaily = r.mode === 'daily';
      r.weeks.forEach(function (w) {
        var v = weekVerdict(r, w);
        totH += w.hours; totA += w.allowance;
        rows.push([
          S('cText', r.name), S('cText', w.week + '주차'), S('cText', isDaily ? weekPeriod(r, w) : '-'),
          S('cText', w.partial ? '월 경계 주' : w.contractDays + '일'),
          isDaily ? S(w.partial ? 'cText' : (w.absent && !w.excused ? 'badC' : 'okC'), w.workDays + '일') : S(w.absent ? 'badC' : 'cText', w.absent ? '결근 있음' : '-'),
          S('hours', w.hours), S(v.style, v.text), S('moneyC', w.allowance),
          S('cText', r.includeMeal && isDaily ? (w.mealDays || 0) + '일' : '-')
        ]);
      });
    });
    var lastData = rows.length;
    rows.push([S('tot', '합계'), S('tot', ''), S('tot', ''), S('tot', ''), S('tot', sumDays(g.list) + '일'), S('hoursTot', M.round2(totH)),
      S('tot', ''), S('moneyCBold', totA), S('tot', '')]);
    return { name: g.key + ' 주휴판정', rows: rows, colWidths: [12, 9, 16, 14, 14, 13, 24, 15, 12],
      merges: ['A1:I1', 'A2:I2'], tabColor: 'FFB7791F', freezeRows: headerRow, rowHeights: { 0: 40, 1: 36 },
      autoFilter: 'A' + headerRow + ':I' + lastData };
  }

  function payrollRosterSheets(results) {
    var groups = groupByMonth(results);
    var sheets = [payrollOverviewSheet(groups)];
    groups.forEach(function (g) {
      sheets.push(payrollMonthSettleSheet(g), payrollMonthAttendanceSheet(g), payrollMonthWeeklySheet(g));
    });
    return sheets;
  }

  function payrollSlipXlsx(r) {
    return M.buildXlsx(payrollSheets(r));
  }

  function payrollRosterXlsx(results) {
    return M.buildXlsx(payrollRosterSheets(results));
  }

  function payrollFileName(r) {
    return '급여명세서_' + safeFilePart(r.name) + (r.payMonth ? '_' + r.payMonth : '') + '.xlsx';
  }

  function rosterFileName(results) {
    var months = groupByMonth(results).map(function (g) { return g.key; });
    var pm = months.length === 1 ? '_' + months[0] : (months.length > 1 ? '_' + months[0] + '~' + months[months.length - 1] : '');
    return '알바_정산명단' + pm + '_' + results.length + '명.xlsx';
  }

  /* ---------------- 위생·소방 점검 ---------------- */

  function checklistSheet(c, name) {
    var rows = [];
    rows.push([TITLE('위생 점검 / 소방 안전 법정 체크리스트')]);
    rows.push([P('식품위생법 · 화재예방법 · 액화석유가스법 기준 자율 점검표')]);
    rows.push([]);
    rows.push([H('매장명(상호)'), T(c.store), T(''), H('점검일자'), T(c.date || '-'), T('')]);
    rows.push([H('점검자'), T(c.inspector), T(''), H('종합 결과'), { v: '적합 ' + c.passCount + '/' + c.total + ' · ' + c.verdict, s: c.allPass ? 'ok' : 'bad' }, { v: '', s: c.allPass ? 'ok' : 'bad' }]);
    rows.push([H('냉장 온도'), T(fmtTemp(c.fridgeTemp) + ' (기준 0~5°C)'), T(''), H('냉동 온도'), T(fmtTemp(c.freezerTemp) + ' (기준 -18°C 이하)'), T('')]);
    rows.push([]);
    rows.push([H('분류'), H('No'), H('점검 항목'), H('기준'), H('결과'), H('비고')]);
    var merges = ['A1:F1', 'A2:F2', 'B4:C4', 'E4:F4', 'B5:C5', 'E5:F5', 'B6:C6', 'E6:F6'];
    c.groups.forEach(function (g) {
      var start = rows.length + 1;
      g.items.forEach(function (it, idx) {
        rows.push([idx === 0 ? B(g.title) : B(''), N(it.no), T(it.text), T(it.standard),
          { v: it.status, s: it.ok ? 'ok' : 'bad' }, T(it.note)]);
      });
      merges.push('A' + start + ':A' + (start + g.items.length - 1));
    });
    rows.push([]);
    rows.push([H('특이사항'), T(c.memo || '-'), T(''), T(''), T(''), T('')]);
    merges.push('B' + rows.length + ':F' + rows.length);
    rows.push([H('점검자 확인'), T(c.inspector + '  (서명)'), T(''), T(''), T(''), T('')]);
    merges.push('B' + rows.length + ':F' + rows.length);
    return { name: name || '점검표', rows: rows, colWidths: [16, 6, 50, 20, 14, 28], merges: merges };
  }

  function checklistArchiveSheet(results) {
    var s = M.summarizeChecklists(results);
    var rows = [];
    rows.push([TITLE('일별 위생·소방 점검 보관함')]);
    rows.push([P('총 ' + s.count + '일 · 전 항목 적합 ' + s.allPassDays + '일 · 평균 적합률 ' + s.avgPassRate + '%')]);
    rows.push([]);
    rows.push([H('No'), H('점검일자'), H('매장명'), H('점검자'), H('냉장(°C)'), H('냉동(°C)'), H('적합 항목'), H('결과'), H('점검필요 항목'), H('특이사항')]);
    results.forEach(function (c, i) {
      var fails = c.items.filter(function (it) { return !it.ok; }).map(function (it) { return it.no + '. ' + it.text; }).join('\n');
      rows.push([N(i + 1), T(c.date || '-'), T(c.store), T(c.inspector),
        c.fridgeTemp === null ? T('미입력') : N(c.fridgeTemp), c.freezerTemp === null ? T('미입력') : N(c.freezerTemp),
        T(c.passCount + ' / ' + c.total), { v: c.verdict, s: c.allPass ? 'ok' : 'bad' }, T(fails || '-'), T(c.memo || '-')]);
    });
    return {
      name: '점검 보관함',
      rows: rows,
      colWidths: [6, 12, 18, 10, 10, 10, 10, 14, 46, 30],
      merges: ['A1:J1', 'A2:J2']
    };
  }

  function checklistXlsx(c) {
    return M.buildXlsx([checklistSheet(c)]);
  }

  function checklistArchiveXlsx(results) {
    var sheets = [checklistArchiveSheet(results)];
    results.forEach(function (c, i) { sheets.push(checklistSheet(c, (i + 1) + '_' + (c.date || '점검'))); });
    return M.buildXlsx(sheets);
  }

  function checklistFileName(c) {
    return '위생소방점검표_' + safeFilePart(c.input && c.input.store ? c.input.store : '매장') + (c.date ? '_' + c.date : '') + '.xlsx';
  }

  function archiveFileName(results) {
    return '위생소방_점검보관함_' + results.length + '일.xlsx';
  }

  return {
    payrollSheets: payrollSheets,
    payrollSummarySheet: payrollSummarySheet,
    payrollAttendanceSheet: payrollAttendanceSheet,
    payrollWeeklySheet: payrollWeeklySheet,
    payrollSlipSheet: payrollSlipSheet,
    payrollRosterSheets: payrollRosterSheets,
    payrollOverviewSheet: payrollOverviewSheet,
    payrollMonthSettleSheet: payrollMonthSettleSheet,
    payrollMonthAttendanceSheet: payrollMonthAttendanceSheet,
    payrollMonthWeeklySheet: payrollMonthWeeklySheet,
    payrollSlipXlsx: payrollSlipXlsx,
    payrollRosterXlsx: payrollRosterXlsx,
    payrollFileName: payrollFileName,
    rosterFileName: rosterFileName,
    checklistSheet: checklistSheet,
    checklistArchiveSheet: checklistArchiveSheet,
    checklistXlsx: checklistXlsx,
    checklistArchiveXlsx: checklistArchiveXlsx,
    checklistFileName: checklistFileName,
    archiveFileName: archiveFileName
  };
});
