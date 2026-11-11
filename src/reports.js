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

  function fmtTemp(t) {
    return t === null || t === undefined ? '미입력' : M.formatNum(t, 1) + '°C';
  }

  function safeFilePart(s) {
    return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 30) || '미입력';
  }

  /* ---------------- 급여 ---------------- */

  function payrollSlipSheet(r, name) {
    var rows = [];
    var merges = ['A1:D1', 'A2:D2'];
    rows.push([TITLE('표준 급여명세서 (임금명세서)')]);
    rows.push([P('근로기준법 제48조 제2항 · 같은 법 시행령 제27조의2 기재사항 기준')]);
    rows.push([]);
    rows.push([H('성명'), T(r.name), H('지급월'), T(r.payMonthLabel)]);
    rows.push([H('시급'), W(r.hourlyWage), H('총 근무시간'), N(r.totalHours)]);
    rows.push([
      H('주휴수당 / 식대'),
      T('주휴 ' + (r.includeWeekly ? '포함' : '미포함') + ' / 식대 ' + (r.includeMeal ? (r.mealDays + '일 지급') : '미포함')),
      H('세금 방식'),
      T(r.tax.label)
    ]);
    rows.push([]);
    rows.push([H('구분'), H('항목'), H('금액(원)'), H('산출식 (계산 방법)')]);
    r.rows.forEach(function (row) {
      var strong = row.kind === 'total' || row.kind === 'subtotal';
      var amount = row.sign < 0 && row.amount ? -row.amount : row.amount;
      var label = row.label + (row.badge ? ' [' + row.badge + ']' : '');
      rows.push([
        T(row.section),
        strong ? B(label) : T(label),
        strong ? WB(amount) : W(amount),
        T(row.formula + (row.detail ? '\n' + row.detail : ''))
      ]);
    });
    rows.push([]);
    rows.push([H('주차'), H('근무시간(h)'), H('주휴 대상 (15h↑) / 식대 일수'), H('주휴수당(원)')]);
    r.weeks.forEach(function (w) {
      var subText = (w.eligible ? '주휴 대상' : '주휴 미대상') +
        (r.includeMeal ? ' · 식대 ' + (w.mealDays || 0) + '일' : '');
      rows.push([T(w.week + '주차'), N(w.hours), T(subText), W(w.allowance)]);
    });

    if (r.mode === 'daily' && Array.isArray(r.days) && r.days.length === 28) {
      rows.push([]);
      rows.push([H('주차'), H('월~금 일별 시간(h)'), H('토·일 시간(h)'), H('주 합계 / 식대 대상일')]);
      for (var wIdx = 0; wIdx < 4; wIdx++) {
        var slice = r.days.slice(wIdx * 7, wIdx * 7 + 7);
        var wkdayStr = slice.slice(0, 5).map(function (d) { return d.dayName + ':' + d.hours; }).join('  ');
        var wkendStr = slice.slice(5, 7).map(function (d) { return d.dayName + ':' + d.hours; }).join('  ');
        var wkObj = r.weeks[wIdx];
        rows.push([
          T((wIdx + 1) + '주차'),
          T(wkdayStr),
          T(wkendStr),
          T('합계 ' + wkObj.hours + 'h · 식대 대상 ' + (wkObj.mealDays || 0) + '일')
        ]);
      }
    }

    rows.push([]);
    rows.push([B(r.message), B(''), B(''), B('')]);
    merges.push('A' + rows.length + ':D' + rows.length);
    return { name: name || '급여명세서', rows: rows, colWidths: [14, 34, 22, 72], merges: merges };
  }

  function payrollRosterSheet(results) {
    var s = M.summarizePayrolls(results);
    var rows = [];
    rows.push([TITLE('알바 급여 정산 명단')]);
    rows.push([P('총 ' + s.count + '명 · 총 입금액 ' + M.formatWon(s.totalNet) + '원')]);
    rows.push([]);
    rows.push([H('No'), H('성명'), H('지급월'), H('시급'), H('근무시간(h)'), H('기본급'), H('주휴수당'),
      H('식대'), H('지각차감'), H('세전총액'), H('세금 방식'), H('공제합계'), H('실수령액')]);
    results.forEach(function (r, i) {
      rows.push([N(i + 1), T(r.name), T(r.payMonthLabel), W(r.hourlyWage), N(r.totalHours), W(r.basePay),
        W(r.weeklyAllowance), W(r.mealAllowance || 0), W(r.lateDeduction ? -r.lateDeduction : 0), W(r.gross), T(r.tax.label),
        W(r.tax.total ? -r.tax.total : 0), WB(r.net)]);
    });
    rows.push([B('합계'), B(s.count + '명'), B(''), B(''), N(s.totalHours), WB(s.totalBase), WB(s.totalWeekly),
      WB(s.totalMeal || 0), WB(s.totalLate ? -s.totalLate : 0), WB(s.totalGross), B(''), WB(s.totalTax ? -s.totalTax : 0), WB(s.totalNet)]);
    return {
      name: '정산 명단',
      rows: rows,
      colWidths: [6, 12, 13, 10, 11, 13, 12, 12, 11, 13, 22, 12, 14],
      merges: ['A1:M1', 'A2:M2']
    };
  }

  function payrollSlipXlsx(r) {
    return M.buildXlsx([payrollSlipSheet(r)]);
  }

  function payrollRosterXlsx(results) {
    var sheets = [payrollRosterSheet(results)];
    results.forEach(function (r, i) { sheets.push(payrollSlipSheet(r, (i + 1) + '_' + r.name)); });
    return M.buildXlsx(sheets);
  }

  function payrollFileName(r) {
    return '급여명세서_' + safeFilePart(r.name) + (r.payMonth ? '_' + r.payMonth : '') + '.xlsx';
  }

  function rosterFileName(results) {
    var pm = results.length && results[0].payMonth ? '_' + results[0].payMonth : '';
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
    payrollSlipSheet: payrollSlipSheet,
    payrollRosterSheet: payrollRosterSheet,
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
