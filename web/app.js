/*
 * web/app.js — 사장님 도우미 프론트엔드 UI
 *   - 서버 연결 시 /api/* 우선 사용, 미연결(GitHub Pages / file://) 시 window.AlbaEngine 으로 100% 동일 동작
 *   - 다크/라이트 모드 전환 (localStorage 저장)
 *   - 탭 1: 1초 알바 급여 & 표준 급여명세서 (일별/주차별/월총 근무시간 + 주휴수당 + 일정시간 이상 식대 추가지급)
 *   - 탭 2: 위생 점검 / 소방 안전 법정 체크리스트 + 일별 보관함 + PDF/엑셀 출력
 */
(function () {
  'use strict';

  var E = window.AlbaEngine;
  if (!E) {
    document.body.insertAdjacentHTML('afterbegin', '<div class="fatal">엔진(engine.js)을 불러오지 못했습니다.</div>');
    return;
  }

  var KEYS = {
    theme: 'alba.theme',
    roster: 'alba.roster.v1',
    archive: 'alba.archive.v1',
    store: 'alba.store.v1'
  };

  var state = {
    serverAvailable: false,
    payroll: null,
    checklist: null,
    roster: loadJson(KEYS.roster, []),
    archive: loadJson(KEYS.archive, [])
  };

  function $(id) { return document.getElementById(id); }

  function escHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function loadJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return Array.isArray(fallback) ? (Array.isArray(parsed) ? parsed : fallback) : (parsed || fallback);
    } catch (e) {
      return fallback;
    }
  }

  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }

  var toastTimer = null;
  function showToast(msg) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2400);
  }

  /* ---------- 테마 & 서버 연결 상태 배지 ---------- */
  function syncThemeBtn() {
    var cur = document.documentElement.getAttribute('data-theme') || 'light';
    var btn = $('themeToggle');
    if (btn) {
      btn.textContent = cur === 'dark' ? '☀️' : '🌙';
      btn.title = cur === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환';
    }
  }

  function toggleTheme() {
    var cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', cur);
    try { localStorage.setItem(KEYS.theme, cur); } catch (e) {}
    syncThemeBtn();
  }

  function setModeBadge(isServer) {
    state.serverAvailable = !!isServer;
    var badge = $('modeBadge');
    if (!badge) return;
    if (isServer) {
      badge.className = 'badge badge-server';
      badge.textContent = '🟢 서버 연결됨 (API + JS 엔진)';
      badge.title = '백엔드 API(/api/*)와 브라우저 JS 엔진이 함께 동작 중입니다.';
    } else {
      badge.className = 'badge badge-web';
      badge.textContent = '⚡ 웹 단독 실행 (100% 브라우저 엔진)';
      badge.title = '서버 없이 브라우저 내장 JS 엔진으로 100% 동일하게 동작 중입니다.';
    }
  }

  function checkServerHealth() {
    if (location.protocol === 'file:') {
      setModeBadge(false);
      return;
    }
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 1200) : null;
    fetch('./api/health', { method: 'GET', cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(); })
      .then(function (d) { setModeBadge(!!(d && d.ok)); })
      .catch(function () { setModeBadge(false); })
      .finally(function () { if (timer) clearTimeout(timer); });
  }

  /* ---------- 탭 전환 ---------- */
  function initTabs() {
    var tabs = document.querySelectorAll('.tabs .tab');
    tabs.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var target = btn.getAttribute('data-tab');
        tabs.forEach(function (b) {
          var active = b === btn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('.tab-panel').forEach(function (panel) {
          panel.classList.toggle('active', panel.id === 'tab-' + target);
        });
      });
    });
  }

  /* ---------- 엑셀 다운로드 유틸 (서버 우선, 폴백 순수 JS) ---------- */
  function triggerBlobDownload(bytes, filename) {
    var blob = new Blob([bytes], { type: E.XLSX_MIME });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  function downloadXlsx(apiPath, payload, localBuilder, filename) {
    if (state.serverAvailable) {
      fetch(apiPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
        .then(function (r) {
          if (!r.ok) throw new Error('status ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (buf) {
          triggerBlobDownload(new Uint8Array(buf), filename);
          showToast('📊 엑셀(.xlsx) 다운로드 완료: ' + filename);
        })
        .catch(function () {
          setModeBadge(false);
          var bytes = localBuilder();
          triggerBlobDownload(bytes, filename);
          showToast('📊 엑셀(.xlsx) 다운로드 완료: ' + filename);
        });
    } else {
      var bytes = localBuilder();
      triggerBlobDownload(bytes, filename);
      showToast('📊 엑셀(.xlsx) 다운로드 완료: ' + filename);
    }
  }

  /* ==========================================================
     탭 1: 1초 알바 급여 & 표준 급여명세서
     ========================================================== */
  function initDailyGrid() {
    var tbody = $('dailyGridBody');
    if (!tbody) return;
    var html = '';
    for (var w = 0; w < 4; w++) {
      html += '<tr>';
      html += '<td class="wk-label">' + (w + 1) + '주</td>';
      for (var d = 0; d < 7; d++) {
        var idx = w * 7 + d;
        var defVal = d < 5 ? 5 : 0; // 기본: 평일 5시간, 주말 0시간
        html += '<td id="dCell_' + idx + '">' +
          '<input id="pD_' + idx + '" class="daily-cell-input" type="number" min="0" max="24" step="0.5" value="' + defVal + '" aria-label="' + (w + 1) + '주 ' + E.DAY_NAMES[d] + '요일 시간">' +
          '</td>';
      }
      html += '<td id="dWkSum_' + w + '" class="wk-sum">25h</td>';
      html += '</tr>';
    }
    tbody.innerHTML = html;
  }

  function getSelectedMode() {
    var checked = document.querySelector('input[name="pMode"]:checked');
    return checked ? checked.value : 'daily';
  }

  function setSelectedMode(mode) {
    var el = document.querySelector('input[name="pMode"][value="' + mode + '"]');
    if (el) el.checked = true;
    $('pWeekMode').checked = mode === 'weekly';
  }

  function getSelectedTax() {
    var checked = document.querySelector('input[name="pTax"]:checked');
    return checked ? checked.value : '3.3';
  }

  function setSelectedTax(val) {
    var el = document.querySelector('input[name="pTax"][value="' + val + '"]');
    if (el) el.checked = true;
  }

  function readDailyHours() {
    var arr = [];
    for (var i = 0; i < 28; i++) {
      var el = $('pD_' + i);
      arr.push(el ? Math.max(0, E.toNumber(el.value, 0)) : 0);
    }
    return arr;
  }

  function writeDailyHours(arr) {
    for (var i = 0; i < 28; i++) {
      var el = $('pD_' + i);
      if (el && arr[i] !== undefined) el.value = arr[i];
    }
  }

  function readPayrollForm() {
    var mode = getSelectedMode();
    var w = [
      E.toNumber($('pW1').value, 0),
      E.toNumber($('pW2').value, 0),
      E.toNumber($('pW3').value, 0),
      E.toNumber($('pW4').value, 0)
    ];
    return {
      name: $('pName').value,
      payMonth: $('pMonth').value,
      hourlyWage: E.toNumber($('pWage').value, 0),
      mode: mode,
      totalHours: E.toNumber($('pTotal').value, 0),
      weekHours: w,
      dailyHours: readDailyHours(),
      lateMinutes: E.toNumber($('pLate').value, 0),
      includeWeekly: $('pWeekly').checked,
      includeMeal: $('pMeal').checked,
      mealMinHours: E.toNumber($('pMealMinHours').value, 4),
      mealAmount: E.toNumber($('pMealAmount').value, 8000),
      mealDays: mode === 'daily' ? null : E.toNumber($('pMealDays').value, 0),
      tax: getSelectedTax()
    };
  }

  function applyParsedToForm(parsed) {
    if (parsed.name) $('pName').value = parsed.name;
    if (parsed.hourlyWage) $('pWage').value = parsed.hourlyWage;
    if (parsed.mode === 'daily' && Array.isArray(parsed.dailyHours)) {
      setSelectedMode('daily');
      writeDailyHours(parsed.dailyHours);
    } else if (parsed.mode === 'weekly' && Array.isArray(parsed.weekHours)) {
      setSelectedMode('weekly');
      $('pW1').value = parsed.weekHours[0];
      $('pW2').value = parsed.weekHours[1];
      $('pW3').value = parsed.weekHours[2];
      $('pW4').value = parsed.weekHours[3];
      $('pTotal').value = parsed.totalHours;
    } else if (parsed.mode === 'total' && parsed.totalHours !== null) {
      setSelectedMode('total');
      $('pTotal').value = parsed.totalHours;
      var each = E.round2(parsed.totalHours / 4);
      $('pW1').value = each;
      $('pW2').value = each;
      $('pW3').value = each;
      $('pW4').value = each;
    }
    $('pLate').value = parsed.lateMinutes || 0;
    $('pWeekly').checked = parsed.includeWeekly !== false;
    if (parsed.includeMeal !== null && parsed.includeMeal !== undefined) {
      $('pMeal').checked = !!parsed.includeMeal;
    }
    if (parsed.mealMinHours) $('pMealMinHours').value = parsed.mealMinHours;
    if (parsed.mealAmount) $('pMealAmount').value = parsed.mealAmount;
    if (parsed.tax) setSelectedTax(parsed.tax);

    var box = $('parseResult');
    if (box) {
      box.innerHTML = (parsed.summary || []).map(function (s) {
        return '<span class="tag">' + escHtml(s) + '</span>';
      }).join('');
    }
    recalcPayroll();
  }

  function syncModeAndHighlights(r) {
    var mode = getSelectedMode();
    $('dailyGroup').hidden = mode !== 'daily';
    $('weeksGroup').hidden = mode !== 'weekly';
    $('totalGroup').hidden = mode !== 'total';
    $('mealDaysManualField').hidden = mode === 'daily';

    $('weeklyBox').classList.toggle('on', $('pWeekly').checked);
    $('mealBox').classList.toggle('on', $('pMeal').checked);
    $('mealConfig').hidden = !$('pMeal').checked;

    var sum = E.round2(
      E.toNumber($('pW1').value, 0) +
      E.toNumber($('pW2').value, 0) +
      E.toNumber($('pW3').value, 0) +
      E.toNumber($('pW4').value, 0)
    );
    $('weeksSum').textContent = E.formatNum(sum, 2);

    // 일별 그리드 셀 하이라이트 & 주별 합계 업데이트
    if (r && Array.isArray(r.days)) {
      r.days.forEach(function (d) {
        var td = $('dCell_' + d.index);
        if (td) {
          var highlight = $('pMeal').checked && d.mealEligible;
          td.classList.toggle('meal-ok', highlight);
          td.title = d.hours > 0
            ? (d.week + '주 ' + d.dayName + '요일: ' + d.hours + '시간' + (d.mealEligible ? ' (🍚 식대 지급 대상)' : ' (식대 기준 미달)'))
            : '';
        }
      });
      for (var w = 0; w < 4; w++) {
        var wkEl = $('dWkSum_' + w);
        if (wkEl && r.weeks[w]) {
          wkEl.textContent = E.formatNum(r.weeks[w].hours, 1) + 'h';
          wkEl.classList.toggle('eligible', r.weeks[w].eligible);
        }
      }
      $('dailyTotalHours').textContent = E.formatNum(r.totalHours, 2);
      $('dailyWorkDays').textContent = r.workDays;
      $('dailyMealDays').textContent = r.mealDays;
    }

    if (r) {
      $('mealSummaryText').textContent = r.includeMeal
        ? ('일 ' + E.formatNum(r.mealMinHours, 1) + '시간 이상 근무 ' + r.mealDays + '일 × ' + E.formatWon(r.mealAmount) + '원 = +' + E.formatWon(r.mealAllowance) + '원')
        : '체크 시 하루 기준시간 이상 근무한 날에 식대를 추가 지급합니다';
    }
  }

  function renderPayroll(r) {
    state.payroll = r;
    syncModeAndHighlights(r);

    $('bannerText').innerHTML =
      '<b>' + escHtml(r.name) + '</b>님 계좌로 <b class="money">' + E.formatWon(r.net) + '원</b> 입금하시면 됩니다.';

    $('slipName').textContent = r.name;
    $('slipMonth').textContent = r.payMonthLabel;
    $('slipWage').textContent = E.formatWon(r.hourlyWage) + '원';
    var modeLabel = r.mode === 'daily' ? ('일별 입력 · ' + r.workDays + '일') : (r.mode === 'weekly' ? '주차별 입력' : '4주 균등');
    $('slipHours').textContent = E.formatNum(r.totalHours, 2) + '시간 (' + modeLabel + ')';
    $('slipWeekly').innerHTML =
      '주휴 <span class="pill ' + (r.includeWeekly ? 'pill-ok' : 'pill-off') + '">' + (r.includeWeekly ? '포함' : '미포함') + '</span> ' +
      '· 식대 <span class="pill ' + (r.includeMeal ? 'pill-ok' : 'pill-off') + '">' + (r.includeMeal ? (r.mealDays + '일') : '미포함') + '</span>';
    $('slipTax').textContent = r.tax.label;

    $('slipBody').innerHTML = r.rows.map(function (row) {
      var cls = 'row-' + row.kind;
      var isPositiveBadge = row.badge && row.badge !== '미포함';
      var badge = row.badge
        ? ' <span class="pill ' + (isPositiveBadge ? 'pill-ok' : 'pill-off') + '">' + escHtml(row.badge) + '</span>'
        : '';
      var amtPrefix = row.sign < 0 && row.amount > 0 ? '-' : '';
      var detail = row.detail ? '<div class="detail">' + escHtml(row.detail) + '</div>' : '';
      return '<tr class="' + cls + '">' +
        '<td class="sec">' + escHtml(row.section) + '</td>' +
        '<td class="label">' + escHtml(row.label) + badge + '</td>' +
        '<td class="num">' + amtPrefix + E.formatWon(row.amount) + '원</td>' +
        '<td class="formula">' + escHtml(row.formula) + detail + '</td>' +
        '</tr>';
    }).join('');

    $('weekStrip').innerHTML = r.weeks.map(function (w) {
      var active = r.includeWeekly && w.eligible;
      var mealSub = r.includeMeal && r.mode === 'daily' ? (' · 🍚 식대 ' + w.mealDays + '일') : '';
      return '<div class="week-cell ' + (active ? 'yes' : 'no') + '">' +
        '<b>' + w.week + '주차 · ' + E.formatNum(w.hours, 2) + 'h' + mealSub + '</b>' +
        '<span class="w-amt">' + (r.includeWeekly
          ? (w.eligible ? '주휴 +' + E.formatWon(w.allowance) + '원' : '15h 미만 (주휴 0원)')
          : '주휴 미포함 (0원)') + '</span>' +
        '</div>';
    }).join('');
  }

  function recalcPayroll() {
    var inp = readPayrollForm();
    var r = E.calculatePayroll(inp);
    renderPayroll(r);
  }

  function renderRoster() {
    var results = state.roster.map(function (inp) { return E.calculatePayroll(inp); });
    var sum = E.summarizePayrolls(results);
    $('rosterCount').textContent = sum.count + '명';
    $('rosterTotal').textContent = E.formatWon(sum.totalNet) + '원';

    if (!results.length) {
      $('rosterBody').innerHTML = '<tr class="empty"><td colspan="11">아직 추가된 알바생이 없습니다. 위에서 [➕ 아래 정산 명단에 추가] 버튼을 눌러보세요.</td></tr>';
      $('rosterFoot').innerHTML = '';
      return;
    }

    $('rosterBody').innerHTML = results.map(function (r, idx) {
      return '<tr data-idx="' + idx + '">' +
        '<td>' + (idx + 1) + '</td>' +
        '<td><b>' + escHtml(r.name) + '</b></td>' +
        '<td>' + escHtml(r.payMonthLabel) + '</td>' +
        '<td class="num">' + E.formatNum(r.totalHours, 2) + 'h</td>' +
        '<td class="num">' + E.formatWon(r.hourlyWage) + '원</td>' +
        '<td class="num">' + E.formatWon(r.weeklyAllowance) + '원 <span class="pill ' + (r.includeWeekly ? 'pill-ok' : 'pill-off') + '">' + (r.includeWeekly ? '포함' : '미포함') + '</span></td>' +
        '<td class="num">' + E.formatWon(r.mealAllowance) + '원 <span class="pill ' + (r.includeMeal ? 'pill-ok' : 'pill-off') + '">' + (r.includeMeal ? (r.mealDays + '일') : '미포함') + '</span></td>' +
        '<td class="num">' + E.formatWon(r.gross) + '원</td>' +
        '<td class="num">' + (r.tax.total ? '-' + E.formatWon(r.tax.total) : '0') + '원 <small class="muted">(' + escHtml(r.tax.type === 'none' ? '0%' : (r.tax.type === '3.3' ? '3.3%' : '4대')) + ')</small></td>' +
        '<td class="num net">' + E.formatWon(r.net) + '원</td>' +
        '<td class="num"><button type="button" class="btn-del" data-del-roster="' + idx + '" title="삭제">✕</button></td>' +
        '</tr>';
    }).join('');

    $('rosterFoot').innerHTML =
      '<tr>' +
      '<td colspan="3">합계 (' + sum.count + '명)</td>' +
      '<td class="num">' + E.formatNum(sum.totalHours, 2) + 'h</td>' +
      '<td class="num">-</td>' +
      '<td class="num">' + E.formatWon(sum.totalWeekly) + '원</td>' +
      '<td class="num">' + E.formatWon(sum.totalMeal) + '원</td>' +
      '<td class="num">' + E.formatWon(sum.totalGross) + '원</td>' +
      '<td class="num">' + (sum.totalTax ? '-' + E.formatWon(sum.totalTax) : '0') + '원</td>' +
      '<td class="num">' + E.formatWon(sum.totalNet) + '원</td>' +
      '<td></td>' +
      '</tr>';
  }

  /* ==========================================================
     탭 2: 위생 점검 / 소방 안전 법정 체크리스트
     ========================================================== */
  function readChecklistForm() {
    return {
      store: $('cStore').value,
      date: $('cDate').value,
      inspector: $('cInspector').value,
      fridgeTemp: $('cFridge').value === '' ? null : E.toNumber($('cFridge').value, null),
      freezerTemp: $('cFreezer').value === '' ? null : E.toNumber($('cFreezer').value, null),
      memo: $('cMemo').value,
      check1: $('cCheck1').checked,
      check2: $('cCheck2').checked,
      check3: $('cCheck3').checked
    };
  }

  function renderChecklist(c) {
    state.checklist = c;

    var fh = $('fridgeHint');
    fh.className = 'temp-hint ' + (c.fridgeOk ? 'ok' : 'bad');
    fh.textContent = c.fridgeOk ? '✓ 적정 (0~5°C)' : '⚠ 기준 이탈 (0~5°C 유지 필요)';

    var fzh = $('freezerHint');
    fzh.className = 'temp-hint ' + (c.freezerOk ? 'ok' : 'bad');
    fzh.textContent = c.freezerOk ? '✓ 적정 (-18°C 이하)' : '⚠ 기준 이탈 (-18°C 이하 유지 필요)';

    var banner = $('chkBanner');
    banner.className = 'banner chk-banner ' + (c.allPass ? 'ok' : 'bad');
    $('chkBannerText').textContent = c.allPass
      ? '✅ 법정 9대 점검 항목 모두 적합합니다.'
      : '⚠️ 점검필요 항목이 ' + c.failCount + '건 있습니다. 좌측 체크박스 및 온도를 확인하세요.';
    $('chkScore').textContent = '적합 ' + c.passCount + '/' + c.total;

    $('chkStore').textContent = c.store;
    $('chkDate').textContent = c.date || '-';
    $('chkInspector').textContent = c.inspector;
    $('chkVerdict').innerHTML = '<span class="result ' + (c.allPass ? 'ok' : 'bad') + '">' + escHtml(c.verdict) + '</span>';
    $('chkFridge').textContent = (c.fridgeTemp === null ? '미입력' : E.formatNum(c.fridgeTemp, 1) + '°C') + (c.fridgeOk ? ' (적정)' : ' (이탈)');
    $('chkFreezer').textContent = (c.freezerTemp === null ? '미입력' : E.formatNum(c.freezerTemp, 1) + '°C') + (c.freezerOk ? ' (적정)' : ' (이탈)');
    $('chkMemo').textContent = c.memo || '특이사항 없음';
    $('chkSign').textContent = c.inspector !== '-' ? c.inspector : '________';

    var rowsHtml = '';
    c.groups.forEach(function (g) {
      g.items.forEach(function (it, idx) {
        rowsHtml += '<tr>';
        if (idx === 0) {
          rowsHtml += '<td class="group" rowspan="' + g.items.length + '">' + escHtml(g.title) + '</td>';
        }
        rowsHtml +=
          '<td class="no">' + it.no + '</td>' +
          '<td>' + escHtml(it.text) + '<span class="item-std">기준: ' + escHtml(it.standard) + '</span></td>' +
          '<td><span class="result ' + (it.ok ? 'ok' : 'bad') + '">' + escHtml(it.status) + '</span></td>' +
          '<td class="note">' + escHtml(it.note) + '</td>' +
          '</tr>';
      });
    });
    $('chkBody').innerHTML = rowsHtml;
  }

  function recalcChecklist() {
    var inp = readChecklistForm();
    saveJson(KEYS.store, { store: inp.store, inspector: inp.inspector });
    var c = E.buildChecklist(inp);
    renderChecklist(c);
  }

  function renderArchive() {
    var results = state.archive.map(function (inp) { return E.buildChecklist(inp); });
    $('archiveCount').textContent = results.length + '일';

    if (!results.length) {
      $('archiveBody').innerHTML = '<tr class="empty"><td colspan="10">저장된 일별 점검 기록이 없습니다. [🗂️ 보관함에 저장] 버튼을 눌러 누적해보세요.</td></tr>';
      return;
    }

    $('archiveBody').innerHTML = results.map(function (c, idx) {
      return '<tr>' +
        '<td>' + (idx + 1) + '</td>' +
        '<td>' + escHtml(c.date || '-') + '</td>' +
        '<td><b>' + escHtml(c.store) + '</b></td>' +
        '<td>' + escHtml(c.inspector) + '</td>' +
        '<td class="num">' + (c.fridgeTemp === null ? '-' : E.formatNum(c.fridgeTemp, 1) + '°C') + '</td>' +
        '<td class="num">' + (c.freezerTemp === null ? '-' : E.formatNum(c.freezerTemp, 1) + '°C') + '</td>' +
        '<td>' + c.passCount + '/' + c.total + '</td>' +
        '<td><span class="result ' + (c.allPass ? 'ok' : 'bad') + '">' + escHtml(c.verdict) + '</span></td>' +
        '<td class="memo-cell" title="' + escHtml(c.memo || '') + '">' + escHtml(c.memo || '-') + '</td>' +
        '<td class="num"><button type="button" class="btn-del" data-del-archive="' + idx + '" title="삭제">✕</button></td>' +
        '</tr>';
    }).join('');
  }

  /* ---------- 클립보드 복사 ---------- */
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }).catch(function () { return fallbackCopy(text); });
    }
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  /* ---------- 초기화 ---------- */
  function initDefaults() {
    var now = new Date();
    var yyyy = now.getFullYear();
    var mm = String(now.getMonth() + 1).padStart(2, '0');
    var dd = String(now.getDate()).padStart(2, '0');
    if (!$('pMonth').value) $('pMonth').value = yyyy + '-' + mm;
    if (!$('cDate').value) $('cDate').value = yyyy + '-' + mm + '-' + dd;

    var savedStore = loadJson(KEYS.store, null);
    if (savedStore) {
      if (savedStore.store) $('cStore').value = savedStore.store;
      if (savedStore.inspector) $('cInspector').value = savedStore.inspector;
    }
    if (!$('cStore').value) $('cStore').value = '행복분식 강남점';
    if (!$('cInspector').value) $('cInspector').value = '김사장';
    $('cCheck1').checked = true;
    $('cCheck2').checked = true;
    $('cCheck3').checked = true;
  }

  function bindEvents() {
    $('themeToggle').addEventListener('click', toggleTheme);

    // 한 줄 자연어 파서
    $('parseForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var text = $('parseInput').value.trim();
      if (!text) {
        showToast('한 줄 문장을 입력하거나 아래 예시 칩을 눌러보세요.');
        return;
      }
      var parsed = E.parseText(text);
      applyParsedToForm(parsed);
      showToast('⚡ 1초 정산 완료: ' + state.payroll.name + '님 실수령액 ' + E.formatWon(state.payroll.net) + '원');
    });

    document.querySelectorAll('.chip[data-example]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var ex = chip.getAttribute('data-example');
        $('parseInput').value = ex;
        var parsed = E.parseText(ex);
        applyParsedToForm(parsed);
        showToast('⚡ 예시 적용: ' + ex);
      });
    });

    // 일별 그리드 입력 및 빠른 채우기 버튼
    $('dailyGridBody').addEventListener('input', recalcPayroll);

    $('btnFillWeekday').addEventListener('click', function () {
      var val = Math.max(0, E.toNumber($('qWeekday').value, 0));
      for (var w = 0; w < 4; w++) {
        for (var d = 0; d < 5; d++) {
          $('pD_' + (w * 7 + d)).value = val;
        }
      }
      recalcPayroll();
      showToast('📅 평일(월~금) 일괄 ' + val + '시간 적용');
    });

    $('btnFillWeekend').addEventListener('click', function () {
      var val = Math.max(0, E.toNumber($('qWeekend').value, 0));
      for (var w = 0; w < 4; w++) {
        for (var d = 5; d < 7; d++) {
          $('pD_' + (w * 7 + d)).value = val;
        }
      }
      recalcPayroll();
      showToast('📅 주말(토·일) 일괄 ' + val + '시간 적용');
    });

    $('btnClearDaily').addEventListener('click', function () {
      for (var i = 0; i < 28; i++) $('pD_' + i).value = 0;
      recalcPayroll();
      showToast('📅 일별 시간을 모두 0시간으로 초기화했습니다.');
    });

    // 근무시간 모드 라디오 전환
    document.querySelectorAll('input[name="pMode"]').forEach(function (el) {
      el.addEventListener('change', recalcPayroll);
    });

    // 급여 폼 실시간 반응
    ['pName', 'pMonth', 'pWage', 'pTotal', 'pW1', 'pW2', 'pW3', 'pW4', 'pLate', 'pMealMinHours', 'pMealAmount', 'pMealDays'].forEach(function (id) {
      $(id).addEventListener('input', recalcPayroll);
    });
    ['pWeekMode', 'pWeekly', 'pMeal'].forEach(function (id) {
      $(id).addEventListener('change', recalcPayroll);
    });
    document.querySelectorAll('input[name="pTax"]').forEach(function (el) {
      el.addEventListener('change', recalcPayroll);
    });

    // 카톡 명세서 복사
    $('copyKakao').addEventListener('click', function () {
      if (!state.payroll) return;
      copyText(state.payroll.kakaoText).then(function (ok) {
        showToast(ok ? '💬 카카오톡용 급여명세서가 클립보드에 복사되었습니다!' : '복사에 실패했습니다.');
      });
    });

    // 급여 PDF / 엑셀 / 명단 추가
    $('btnPrintPay').addEventListener('click', function () { window.print(); });
    $('btnXlsxPay').addEventListener('click', function () {
      var r = state.payroll || E.calculatePayroll(readPayrollForm());
      downloadXlsx('./api/payroll/excel', { input: r.input }, function () { return E.payrollSlipXlsx(r); }, E.payrollFileName(r));
    });
    $('btnAddRoster').addEventListener('click', function () {
      var r = state.payroll || E.calculatePayroll(readPayrollForm());
      state.roster.push(r.input);
      saveJson(KEYS.roster, state.roster);
      renderRoster();
      showToast('➕ 정산 명단에 ' + r.name + '님(' + E.formatWon(r.net) + '원) 추가');
    });

    $('rosterBody').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-del-roster]');
      if (!btn) return;
      var idx = Number(btn.getAttribute('data-del-roster'));
      if (idx >= 0 && idx < state.roster.length) {
        state.roster.splice(idx, 1);
        saveJson(KEYS.roster, state.roster);
        renderRoster();
      }
    });

    $('btnRosterXlsx').addEventListener('click', function () {
      if (!state.roster.length) {
        showToast('정산 명단이 비어 있습니다. 먼저 명단에 알바생을 추가해주세요.');
        return;
      }
      var results = state.roster.map(function (inp) { return E.calculatePayroll(inp); });
      downloadXlsx('./api/payroll/excel', { roster: state.roster }, function () { return E.payrollRosterXlsx(results); }, E.rosterFileName(results));
    });

    $('btnRosterClear').addEventListener('click', function () {
      if (!state.roster.length) return;
      state.roster = [];
      saveJson(KEYS.roster, state.roster);
      renderRoster();
      showToast('정산 명단을 비웠습니다.');
    });

    // 체크리스트 실시간 반응
    ['cStore', 'cDate', 'cInspector', 'cFridge', 'cFreezer', 'cMemo'].forEach(function (id) {
      $(id).addEventListener('input', recalcChecklist);
    });
    ['cCheck1', 'cCheck2', 'cCheck3'].forEach(function (id) {
      $(id).addEventListener('change', recalcChecklist);
    });

    $('btnPrintChk').addEventListener('click', function () { window.print(); });
    $('btnXlsxChk').addEventListener('click', function () {
      var c = state.checklist || E.buildChecklist(readChecklistForm());
      downloadXlsx('./api/checklist/excel', { input: c.input }, function () { return E.checklistXlsx(c); }, E.checklistFileName(c));
    });
    $('btnAddArchive').addEventListener('click', function () {
      var c = state.checklist || E.buildChecklist(readChecklistForm());
      state.archive.push(c.input);
      saveJson(KEYS.archive, state.archive);
      renderArchive();
      showToast('🗂️ 점검 보관함에 ' + (c.date || '오늘') + ' 점검표 저장 (' + c.verdict + ')');
    });

    $('archiveBody').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-del-archive]');
      if (!btn) return;
      var idx = Number(btn.getAttribute('data-del-archive'));
      if (idx >= 0 && idx < state.archive.length) {
        state.archive.splice(idx, 1);
        saveJson(KEYS.archive, state.archive);
        renderArchive();
      }
    });

    $('btnArchiveXlsx').addEventListener('click', function () {
      if (!state.archive.length) {
        showToast('점검 보관함이 비어 있습니다. 먼저 보관함에 점검표를 저장해주세요.');
        return;
      }
      var results = state.archive.map(function (inp) { return E.buildChecklist(inp); });
      downloadXlsx('./api/checklist/excel', { archive: state.archive }, function () { return E.checklistArchiveXlsx(results); }, E.archiveFileName(results));
    });

    $('btnArchiveClear').addEventListener('click', function () {
      if (!state.archive.length) return;
      state.archive = [];
      saveJson(KEYS.archive, state.archive);
      renderArchive();
      showToast('점검 보관함을 비웠습니다.');
    });
  }

  syncThemeBtn();
  initTabs();
  initDailyGrid();
  initDefaults();
  bindEvents();
  recalcPayroll();
  recalcChecklist();
  renderRoster();
  renderArchive();
  checkServerHealth();
})();
