/*
 * web/app.js — 사장님 도우미 프론트엔드 UI
 *   - 서버 연결 시 /api/* 우선 사용, 미연결(GitHub Pages / file://) 시 window.AlbaEngine 으로 100% 동일 동작
 *   - 다크/라이트 모드 전환 (localStorage 저장)
 *   - 탭 1: 1초 알바 급여 & 표준 급여명세서
 *           (월별 실제 주차/달력 자동 반영 + 출퇴근 시각 슬라이더/클릭 선택기 + 주휴수당 + 식대 자동지급)
 *   - 탭 2: 매장 위생 점검 41개 항목 + 일별 보관함 + PDF/엑셀 출력
 */
(function () {
  'use strict';

  var E = window.AlbaEngine;
  if (!E) {
    document.body.insertAdjacentHTML('afterbegin', '<div class="fatal">Could not load engine.js / 엔진(engine.js)을 불러오지 못했습니다.</div>');
    return;
  }

  var tr = E.t;   // 번역 도우미: tr('한국어 {n}', { n: 3 })
  function moneyBig(v) { return E.getLang() === 'en' ? '<small>₩</small>' + E.formatWon(v) : E.formatWon(v) + '<small>원</small>'; }

  var KEYS = {
    theme: 'alba.theme',
    bigFont: 'alba.bigFont',
    roster: 'alba.roster.v1',        // 예전 형식(정산 명단) — 새 형식으로 옮기기 위해서만 읽음
    workers: 'alba.workers.v2',
    settings: 'alba.settings.v1',
    archive: 'alba.archive.v1',
    store: 'alba.store.v1',
    presets: 'alba.timePresets.v1'
  };

  var SYNC_KEYS = {};
  SYNC_KEYS[KEYS.settings] = SYNC_KEYS[KEYS.workers] = SYNC_KEYS[KEYS.archive] = SYNC_KEYS[KEYS.store] = SYNC_KEYS[KEYS.presets] = true;

  function loadSettings() {
    var st = E.sanitizeSettings(loadJson(KEYS.settings, {}));
    E.setRates(st.rates);
    E.setMealTimes(st.mealTimes);   // 계산에 쓰이는 세율을 먼저 맞춘다
    return st;
  }

  function loadWorkers() {
    var list = loadJson(KEYS.workers, null);
    if (Array.isArray(list)) return E.normalizeWorkers(list);
    // 예전 형식(정산 명단)이 있으면 알바생별 월 기록으로 옮긴다 (원본은 그대로 둠)
    var old = loadJson(KEYS.roster, []);
    var moved = E.migrateRoster(old);
    if (moved.length) { try { localStorage.setItem(KEYS.workers, JSON.stringify(moved)); } catch (e) {} }
    return moved;
  }

  var MINUTE_STEPS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  var state = {
    serverAvailable: false,
    payroll: null,
    checklist: null,
    settings: loadSettings(),
    workers: loadWorkers(),
    selId: '',          // 지금 달력에 불러온 알바생
    archive: loadJson(KEYS.archive, []),
    rightView: 'schedule', // 'schedule' | 'slip'
    calendar: null,
    dailyShifts: [],
    selectedDayIdx: 0,
    contractDays: 5,    // 주 근무 약속일수 (주휴수당 개근 판정)
    weekExcuse: [],     // 결근 있어도 해당 주는 주휴 지급(예외)
    weekAbsent: [],     // 주차별 모드: 결근한 주 수동 체크
    editor: {
      startHour: 9,
      startMin: 0,
      endHour: 14,
      endMin: 0,
      breakMinutes: 0,
      off: false,
      meals: null        // 식대를 직접 고친 날: ['L','D'] 중 체크한 것 / null이면 자동
    }
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

  var syncSuspended = false; // 구글 시트에서 받은 내용을 반영하는 중에는 다시 저장하지 않음
  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
    if (!syncSuspended && SYNC_KEYS[key] && window.AlbaCloud) window.AlbaCloud.markDirty();
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

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTime(h, m) { return pad2(h) + ':' + pad2(m); }

  function parseHM(str, defH, defM) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
    if (!m) return { h: defH, m: defM };
    return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
  }

  /* ---------- 테마 & 서버 연결 상태 배지 ---------- */
  function syncThemeBtn() {
    var cur = document.documentElement.getAttribute('data-theme') || 'light';
    var btn = $('themeToggle');
    if (btn) {
      btn.textContent = cur === 'dark' ? '☀️' : '🌙';
      btn.title = cur === 'dark' ? tr('라이트 모드로 전환') : tr('다크 모드로 전환');
    }
  }

  function syncFontBtn() {
    var big = document.documentElement.getAttribute('data-fs') === 'large';
    var btn = $('fontToggle');
    if (!btn) return;
    btn.textContent = big ? tr('가−') : tr('가+');
    btn.setAttribute('aria-pressed', big ? 'true' : 'false');
    btn.title = big ? tr('글자를 보통 크기로') : tr('글자를 크게');
  }

  function toggleFontSize() {
    var big = document.documentElement.getAttribute('data-fs') === 'large';
    if (big) document.documentElement.removeAttribute('data-fs');
    else document.documentElement.setAttribute('data-fs', 'large');
    try { localStorage.setItem(KEYS.bigFont, big ? '0' : '1'); } catch (e) {}
    syncFontBtn();
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
      badge.textContent = tr('🟢 서버 연결됨 (API + JS 엔진)');
      badge.title = tr('백엔드 API(/api/*)와 브라우저 JS 엔진이 함께 동작 중입니다.');
    } else {
      badge.className = 'badge badge-web';
      badge.textContent = tr('⚡ 웹 단독 실행 (100% 브라우저 엔진)');
      badge.title = tr('서버 없이 브라우저 내장 JS 엔진으로 100% 동일하게 동작 중입니다.');
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
        if (target !== 'punch' && isLocked()) return;   // 잠겨 있으면 출퇴근 화면만
        tabs.forEach(function (b) {
          var active = b === btn;
          b.classList.toggle('active', active);
          b.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.body.classList.toggle('on-punch', target === 'punch');
        document.querySelectorAll('.tab-panel').forEach(function (panel) {
          panel.classList.toggle('active', panel.id === 'tab-' + target);
        });
      });
    });
  }

  /* ---------- 엑셀 다운로드 유틸 ---------- */
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
          showToast(tr('📊 엑셀(.xlsx) 다운로드 완료: {f}', { f: filename }));
        })
        .catch(function () {
          setModeBadge(false);
          var bytes = localBuilder();
          triggerBlobDownload(bytes, filename);
          showToast(tr('📊 엑셀(.xlsx) 다운로드 완료: {f}', { f: filename }));
        });
    } else {
      var bytes = localBuilder();
      triggerBlobDownload(bytes, filename);
      showToast(tr('📊 엑셀(.xlsx) 다운로드 완료: {f}', { f: filename }));
    }
  }

  /* ==========================================================
     빠른 시간대 프리셋 (사용자 정의 · 최대 20개 · localStorage 저장)
     ========================================================== */
  var PRESET_MAX = 20;
  var DEFAULT_PRESETS = [
    { name: '오전', start: '09:00', end: '14:00', breakMin: 0 },
    { name: '미들', start: '10:00', end: '15:00', breakMin: 0 },
    { name: '오후', start: '13:00', end: '18:00', breakMin: 0 },
    { name: '야간', start: '18:00', end: '23:00', breakMin: 0 },
    { name: '풀타임', start: '09:00', end: '18:00', breakMin: 60 }
  ];
  var presetState = { list: [], editMode: false, editingIdx: -1 };

  function loadPresets() {
    var saved = loadJson(KEYS.presets, null);
    var list = Array.isArray(saved) ? saved : DEFAULT_PRESETS;
    presetState.list = list.filter(function (p) {
      return p && /^\d{1,2}:\d{2}$/.test(p.start) && /^\d{1,2}:\d{2}$/.test(p.end);
    }).slice(0, PRESET_MAX).map(function (p) {
      return { name: String(p.name || '').slice(0, 8), start: p.start, end: p.end, breakMin: Number(p.breakMin) || 0 };
    });
  }

  function savePresets() { saveJson(KEYS.presets, presetState.list); }

  function presetHours(p) {
    var st = parseHM(p.start, 9, 0), et = parseHM(p.end, 14, 0);
    var mins = (et.h * 60 + et.m) - (st.h * 60 + st.m) - (p.breakMin || 0);
    var h = Math.max(0, mins) / 60;
    return (Math.round(h * 10) / 10) + 'h';
  }

  var PRESET_EN = { '오전': 'Morning', '미들': 'Mid', '오후': 'Afternoon', '야간': 'Night', '풀타임': 'Full-time' };
  function presetName(n) { return E.getLang() === 'en' && PRESET_EN[n] ? PRESET_EN[n] : n; }

  function renderPresets() {
    var box = $('presetList');
    if (!box) return;
    var html = presetState.list.map(function (p, i) {
      var label = (p.name ? escHtml(presetName(p.name)) + ' ' : '') + escHtml(p.start) + '~' + escHtml(p.end) +
        ' (' + presetHours(p) + (p.breakMin ? tr(', 휴게{m}분', { m: p.breakMin }) : '') + ')';
      var tools = presetState.editMode
        ? '<span class="preset-tools"><button type="button" class="preset-tool" data-act="edit" data-i="' + i + '" title="' + tr('수정') + '">✏️</button>' +
          '<button type="button" class="preset-tool" data-act="del" data-i="' + i + '" title="' + tr('삭제') + '">✕</button></span>'
        : '';
      return '<span class="preset-item"><button type="button" class="chip preset-chip" data-i="' + i + '">' + label + '</button>' + tools + '</span>';
    }).join('');
    html += '<button type="button" class="chip preset-chip chip-off" data-off="true">🚫 휴무</button>';
    box.innerHTML = html;

    var full = presetState.list.length >= PRESET_MAX;
    $('presetCount').textContent = presetState.list.length + '/' + PRESET_MAX;
    $('presetAddBtn').disabled = full;
    $('presetAddBtn').title = full ? tr('최대 {n}개까지 만들 수 있어요', { n: PRESET_MAX }) : tr('시간대 추가 (최대 {n}개)', { n: PRESET_MAX });
    $('presetEditToggle').classList.toggle('active', presetState.editMode);
    $('presetEditToggle').textContent = presetState.editMode ? tr('✔ 편집 완료') : tr('✏️ 편집');
  }

  function openPresetForm(idx) {
    presetState.editingIdx = idx;
    var p = idx >= 0 ? presetState.list[idx] : { name: '', start: '09:00', end: '14:00', breakMin: 0 };
    $('presetName').value = p.name;
    $('presetStart').value = pad2(parseHM(p.start, 9, 0).h) + ':' + pad2(parseHM(p.start, 9, 0).m);
    $('presetEnd').value = pad2(parseHM(p.end, 14, 0).h) + ':' + pad2(parseHM(p.end, 14, 0).m);
    var sel = $('presetBreak');
    if (!Array.prototype.some.call(sel.options, function (o) { return Number(o.value) === p.breakMin; })) {
      var opt = document.createElement('option');
      opt.value = String(p.breakMin);
      opt.textContent = tr('휴게 {m}분', { m: p.breakMin });
      sel.appendChild(opt);
    }
    sel.value = String(p.breakMin);
    $('presetSaveBtn').textContent = idx >= 0 ? tr('수정 저장') : tr('추가');
    $('presetForm').hidden = false;
    $('presetName').focus();
  }

  function closePresetForm() {
    presetState.editingIdx = -1;
    $('presetForm').hidden = true;
  }

  function initTimePresets() {
    loadPresets();
    renderPresets();

    // 칩 클릭: 적용 / 수정 / 삭제
    $('presetList').addEventListener('click', function (ev) {
      var tool = ev.target.closest('.preset-tool');
      if (tool) {
        var ti = Number(tool.getAttribute('data-i'));
        if (tool.getAttribute('data-act') === 'del') {
          if (!window.confirm(tr('이 시간대를 삭제할까요?'))) return;
          presetState.list.splice(ti, 1);
          savePresets();
          closePresetForm();
          renderPresets();
          showToast(tr('🗑 시간대를 삭제했습니다.'));
        } else {
          openPresetForm(ti);
        }
        return;
      }
      var chip = ev.target.closest('.preset-chip');
      if (!chip) return;
      if (chip.getAttribute('data-off') === 'true') {
        state.editor.off = true;
        applyEditorToSelectedDay();
        showToast(tr('🚫 선택된 날짜를 휴무로 설정했습니다.'));
        return;
      }
      var p = presetState.list[Number(chip.getAttribute('data-i'))];
      if (!p) return;
      var st = parseHM(p.start, 9, 0);
      var et = parseHM(p.end, 14, 0);
      state.editor.startHour = st.h;
      state.editor.startMin = st.m;
      state.editor.endHour = et.h;
      state.editor.endMin = et.m;
      state.editor.breakMinutes = p.breakMin || 0;
      state.editor.off = false;
      applyEditorToSelectedDay();
    });

    $('presetAddBtn').addEventListener('click', function () {
      if (presetState.list.length >= PRESET_MAX) {
        showToast(tr('시간대는 최대 {n}개까지 만들 수 있어요.', { n: PRESET_MAX }));
        return;
      }
      openPresetForm(-1);
    });

    $('presetEditToggle').addEventListener('click', function () {
      presetState.editMode = !presetState.editMode;
      if (!presetState.editMode) closePresetForm();
      renderPresets();
    });

    $('presetCancelBtn').addEventListener('click', closePresetForm);

    $('presetForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var start = $('presetStart').value;
      var end = $('presetEnd').value;
      if (!start || !end) { showToast(tr('출근/퇴근 시각을 입력해 주세요.')); return; }
      var st = parseHM(start, 9, 0), et = parseHM(end, 14, 0);
      var sMin = st.h * 60 + st.m;
      var eMin = et.h * 60 + et.m;
      if (eMin === 0) { eMin = 24 * 60; end = '24:00'; } // 00:00 퇴근은 자정(24:00)으로 처리
      var brk = Number($('presetBreak').value) || 0;
      if (eMin <= sMin) { showToast(tr('퇴근 시각은 출근 시각보다 늦어야 해요.')); return; }
      if (eMin - sMin <= brk) { showToast(tr('휴게시간이 근무시간보다 길어요.')); return; }
      var item = { name: $('presetName').value.trim().slice(0, 8), start: start, end: end, breakMin: brk };
      if (presetState.editingIdx >= 0) {
        presetState.list[presetState.editingIdx] = item;
        showToast(tr('✏️ 시간대를 수정했습니다.'));
      } else {
        if (presetState.list.length >= PRESET_MAX) { showToast(tr('최대 {n}개까지 가능합니다.', { n: PRESET_MAX })); return; }
        presetState.list.push(item);
        showToast(tr('＋ 시간대를 추가했습니다. ({a}/{b})', { a: presetState.list.length, b: PRESET_MAX }));
      }
      savePresets();
      closePresetForm();
      renderPresets();
    });
  }


  /* ==========================================================
     월별 실제 달력 & 출퇴근 시각(시/분) 드롭다운 스크롤 선택기
     ========================================================== */
  function initTimePickerChips() {
    var shHtml = '';
    for (var h = 0; h <= 23; h++) {
      shHtml += '<button type="button" class="scroll-option" role="option" data-sh="' + h + '">' +
        '<span>' + tr('{n}시', { n: pad2(h) }) + '</span><small class="muted">' + (E.getLang() === 'en' ? '' : (h < 12 ? tr('오전') : tr('오후'))) + '</small></button>';
    }
    $('startHourMenu').innerHTML = shHtml;

    var ehHtml = '';
    for (var eh = 0; eh <= 24; eh++) {
      ehHtml += '<button type="button" class="scroll-option" role="option" data-eh="' + eh + '">' +
        '<span>' + tr('{n}시', { n: pad2(eh) }) + '</span><small class="muted">' + (eh === 24 ? tr('자정') : (E.getLang() === 'en' ? '' : (eh < 12 ? tr('오전') : tr('오후')))) + '</small></button>';
    }
    $('endHourMenu').innerHTML = ehHtml;

    var smHtml = MINUTE_STEPS.map(function (m) {
      return '<button type="button" class="scroll-option" role="option" data-sm="' + m + '">' +
        '<span>' + tr('{n}분', { n: pad2(m) }) + '</span></button>';
    }).join('');
    $('startMinMenu').innerHTML = smHtml;

    var emHtml = MINUTE_STEPS.map(function (m) {
      return '<button type="button" class="scroll-option" role="option" data-em="' + m + '">' +
        '<span>' + tr('{n}분', { n: pad2(m) }) + '</span></button>';
    }).join('');
    $('endMinMenu').innerHTML = emHtml;
  }

  function closeAllScrollDropdowns(exceptEl) {
    document.querySelectorAll('.scroll-select.open').forEach(function (el) {
      if (el !== exceptEl) {
        el.classList.remove('open');
        var btn = el.querySelector('.scroll-select-btn');
        if (btn) btn.setAttribute('aria-expanded', 'false');
      }
    });
  }

  function toggleScrollDropdown(wrapId) {
    var wrap = $(wrapId);
    if (!wrap) return;
    var willOpen = !wrap.classList.contains('open');
    closeAllScrollDropdowns(wrap);
    wrap.classList.toggle('open', willOpen);
    var btn = wrap.querySelector('.scroll-select-btn');
    if (btn) btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) {
      var menu = wrap.querySelector('.scroll-menu');
      var active = menu && menu.querySelector('.scroll-option.active');
      if (menu && active) {
        menu.scrollTop = Math.max(0, active.offsetTop - (menu.clientHeight / 2) + (active.offsetHeight / 2));
      }
    }
  }

  /* 지급월 달력을 만든다. 근무 기록이 없는 달은 전부 휴무(0시간)로 시작한다. */
  function ensureCalendarAndShifts(payMonth, force) {
    var cal = E.buildMonthCalendar(payMonth);
    state.calendar = cal;
    var reset = force || !state.dailyShifts || state.dailyShifts.length !== cal.daysInMonth;
    if (reset && (!state.dailyShifts || state.dailyShifts.length !== cal.daysInMonth)) state.dailyShifts = E.emptyShifts(payMonth);
    if (state.selectedDayIdx >= cal.daysInMonth) state.selectedDayIdx = 0;
    if (reset) loadDayIntoEditor(state.selectedDayIdx);
  }

  function loadDayIntoEditor(dayIdx) {
    if (!state.calendar || dayIdx < 0 || dayIdx >= state.calendar.daysInMonth) return;
    state.selectedDayIdx = dayIdx;
    var sh = state.dailyShifts[dayIdx] || { off: true, start: '09:00', end: '14:00', breakMinutes: 0 };
    var st = parseHM(sh.start, 9, 0);
    var et = parseHM(sh.end, 14, 0);
    state.editor.startHour = st.h;
    state.editor.startMin = st.m;
    state.editor.endHour = et.h;
    state.editor.endMin = et.m;
    state.editor.breakMinutes = sh.breakMinutes || 0;
    state.editor.off = !!sh.off;
    state.editor.meals = Array.isArray(sh.meals) ? sh.meals.slice() : null;
    renderTimeEditor();
  }

  function currentEditorShift() {
    var start = fmtTime(state.editor.startHour, state.editor.startMin);
    var end = state.editor.endHour === 24 ? '24:00' : fmtTime(state.editor.endHour, state.editor.endMin);
    var hrs = state.editor.off ? 0 : E.calcShiftHours(start, end, state.editor.breakMinutes);
    var out = {
      off: state.editor.off || hrs <= 0,
      start: start,
      end: end,
      breakMinutes: state.editor.breakMinutes,
      hours: hrs
    };
    if (Array.isArray(state.editor.meals)) out.meals = state.editor.meals.slice();
    return out;
  }

  /* 저장용 하루 근무 (계산용 hours 제외, 직접 고친 식대는 유지) */
  function storeShift(sh) {
    var o = { off: sh.off, start: sh.start, end: sh.end, breakMinutes: sh.breakMinutes };
    if (Array.isArray(sh.meals)) o.meals = sh.meals.slice();
    return o;
  }

  function mealShort(m) {
    return m.lunch && m.dinner ? tr('점저') : (m.lunch ? tr('점') : (m.dinner ? tr('저') : ''));
  }

  function mealWords(m) {
    return m.lunch && m.dinner ? tr('점심·저녁') : (m.lunch ? tr('점심') : (m.dinner ? tr('저녁') : ''));
  }

  function renderTimeEditor() {
    var cal = state.calendar;
    var cd = cal && cal.days[state.selectedDayIdx];
    var sh = currentEditorShift();

    if (cd) {
      $('selDayBadge').textContent = tr('{m}월 {d}일 ({w}) · {k}주차', { m: cal.month, d: cd.date, w: cd.dayName, k: cd.week });
      $('selDayTitle').textContent = sh.off ? tr('휴무일 · 시간을 고르면 근무일로 바뀌어요') : tr('근무일');
    }

    var minMeal = E.toNumber($('pMealMinHours').value, 4);
    var ml = E.mealsForShift(storeShift(sh), minMeal);
    var showMeal = $('pMeal').checked && !sh.off;
    var mealTag = showMeal && (ml.lunch || ml.dinner) ? ' · 🍚 ' + tr('{w} 식대', { w: mealWords(ml) }) : '';
    $('mealPick').hidden = !showMeal;
    $('mealLunch').checked = ml.lunch;
    $('mealDinner').checked = ml.dinner;
    $('mealPickNote').textContent = ml.manual ? tr('직접 고침') : tr('자동');
    $('editorCalcPill').innerHTML = sh.off
      ? '🚫 <b>' + tr('휴무 (0시간)') + '</b>'
      : (sh.start + ' ~ ' + sh.end + (sh.breakMinutes ? ' (-' + tr('{n}분', { n: sh.breakMinutes }) + ')' : '') + ' · <b>' + tr('{n}시간', { n: E.formatNum(sh.hours, 2) }) + '</b>' + mealTag);

    $('startHourText').textContent = tr('{n}시', { n: pad2(state.editor.startHour) });
    $('startMinText').textContent = tr('{n}분', { n: pad2(state.editor.startMin) });
    $('endHourText').textContent = tr('{n}시', { n: pad2(state.editor.endHour) });
    $('endMinText').textContent = tr('{n}분', { n: pad2(state.editor.endMin) });

    document.querySelectorAll('[data-sh]').forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-sh')) === state.editor.startHour);
    });
    document.querySelectorAll('[data-eh]').forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-eh')) === state.editor.endHour);
    });
    document.querySelectorAll('[data-sm]').forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-sm')) === state.editor.startMin);
    });
    document.querySelectorAll('[data-em]').forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-em')) === state.editor.endMin);
    });
    document.querySelectorAll('[data-break-val]').forEach(function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-break-val')) === state.editor.breakMinutes);
    });
  }

  function applyEditorToSelectedDay() {
    var sh = currentEditorShift();
    state.dailyShifts[state.selectedDayIdx] = storeShift(sh);
    renderTimeEditor();
    editPayroll();
  }

  function setRightView(view) {
    state.rightView = view === 'slip' ? 'slip' : 'schedule';
    var isDaily = getSelectedMode() === 'daily';
    $('rightViewSwitch').hidden = !isDaily;

    if (!isDaily) {
      $('scheduleBoard').hidden = true;
      $('payDoc').hidden = false;
      return;
    }

    var showSched = state.rightView === 'schedule';
    $('scheduleBoard').hidden = !showSched;
    $('payDoc').hidden = showSched;
    $('btnViewSchedule').classList.toggle('active', showSched);
    $('btnViewSlip').classList.toggle('active', !showSched);
  }

  /* ---------- 월별 실제 달력 테이블 렌더링 ---------- */
  function syncPayMonthLabel() {
    var m = /^(\d{4})-(\d{2})$/.exec($('pMonth').value || '');
    $('pMonthLabel').textContent = m ? tr('{y}년 {m}월', { y: m[1], m: Number(m[2]) }) : tr('월 선택');
  }

  // 주별 주휴 상태 문구 + (결근 주일 때) 예외 지급 버튼
  function weekStatus(w, r, idx) {
    if (!r.includeWeekly) return { text: tr('주휴 미포함'), btn: '', cls: '' };
    var days = (w.workDays !== null && w.workDays !== undefined) ? tr('{a}/{b}일 출근', { a: w.workDays, b: w.contractDays }) : '';
    if (w.eligible && !w.excused) {
      return { text: tr('주휴 +{a}', { a: E.moneyText(w.allowance) }) + (days ? tr(' · 개근 ') + days : ''), btn: '', cls: 'ok' };
    }
    if (w.excused) {
      return {
        text: tr('주휴 +{a}', { a: E.moneyText(w.allowance) }) + tr(' (결근 있으나 지급)'),
        btn: '<button type="button" class="btn btn-xs wk-excuse-btn" data-week-excuse="' + idx + '">' + tr('다시 제외하기') + '</button>',
        cls: 'ok'
      };
    }
    if (!w.hoursOk) return { text: tr('주휴 없음 (15시간 미만)'), btn: '', cls: '' };
    return {
      text: tr('주휴 없음 · ') + (days || tr('결근')),
      btn: '<button type="button" class="btn btn-xs wk-excuse-btn" data-week-excuse="' + idx + '" title="' + tr('공휴일·사장님 사정으로 쉰 주') + '">' + tr('이 주는 주휴 지급') + '</button>',
      cls: 'bad'
    };
  }

  function renderMonthCalendar(r) {
    var cal = r.calendar || state.calendar;
    if (!cal) return;

    $('calMonthBadge').textContent = tr('{m}월 · {n}개 주차', { m: cal.month, n: cal.weekCount });
    $('calBoardTitle').textContent = tr('{y}년 {m}월 출퇴근 달력 (총 {n}개 주차 · {d}일)', { y: cal.year, m: cal.month, n: cal.weekCount, d: cal.daysInMonth });

    // 주차(0..weekCount-1) × 요일(0=월..6=일) 매트릭스 생성
    var grid = [];
    for (var w = 0; w < cal.weekCount; w++) {
      grid.push([null, null, null, null, null, null, null]);
    }
    r.days.forEach(function (d) {
      if (grid[d.weekIndex]) grid[d.weekIndex][d.dayIndex] = d;
    });

    var rowsHtml = '';
    for (var wi = 0; wi < cal.weekCount; wi++) {
      var wkObj = r.weeks[wi] || { week: wi + 1, hours: 0, eligible: false, allowance: 0, mealDays: 0 };
      rowsHtml += '<tr>';

      for (var di = 0; di < 7; di++) {
        var day = grid[wi][di];
        if (!day) {
          rowsHtml += '<td class="cal-empty-cell"></td>';
          continue;
        }
        var isSel = day.index === state.selectedDayIdx;
        var isMeal = r.includeMeal && day.mealEligible;
        var cls = 'cal-day-cell' +
          (isSel ? ' selected' : '') +
          (isMeal ? ' meal-ok' : '') +
          (day.off ? ' off-day' : '');
        var dateColor = di === 5 ? ' sat' : (di === 6 ? ' sun' : '');
        var isOff = day.off || day.hours <= 0;

        rowsHtml += '<td class="' + cls + '" data-day-idx="' + day.index + '">' +
          '<div class="cal-date-num' + dateColor + '">' + day.date + '</div>' +
          (isOff
            ? '<div class="cal-off-badge">' + tr('휴무') + '</div>'
            : '<div class="cal-shift-range">' + shiftRangeHtml(day.start, day.end) + '</div>') +
          (isMeal ? '<div class="cal-meal-icon" title="' + tr('식대: {w}', { w: mealWords(day.meals) }) + '">🍚' + mealShort(day.meals) + '</div>' : '') +
          '</td>';
      }
      rowsHtml += '</tr>';

      // 주간 합계: 한 줄 요약
      var st = weekStatus(wkObj, r, wi);
      var mealSub = r.includeMeal ? (' · 🍚 ' + tr('식대 {n}회', { n: wkObj.mealDays })) : '';
      rowsHtml += '<tr class="cal-week-sum"><td colspan="7"><div class="wk-line ' + st.cls + '">' +
        '<b>' + tr('{k}주차 {h}시간', { k: wi + 1, h: E.formatNum(wkObj.hours, 1) }) + '</b>' +
        '<span class="wk-line-text">' + st.text + mealSub + '</span>' +
        (st.btn || '') + '</div></td></tr>';
    }

    $('monthCalBody').innerHTML = rowsHtml;
  }

  function shiftRangeHtml(a, b) {
    var x = shortTime(a), y = shortTime(b);
    if (x.indexOf(':') < 0 && y.indexOf(':') < 0) return escHtml(x + '-' + y);
    return '<span>' + escHtml(x) + '</span><span>' + escHtml(y) + '</span>';
  }

  // 달력 칸용 짧은 시각: 09:00 -> 9, 09:30 -> 9:30
  function shortTime(t) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(t || '');
    if (!m) return t || '';
    return String(Number(m[1])) + (m[2] === '00' ? '' : ':' + m[2]);
  }

  /* ---------- 날짜 팝업 열기/닫기 ---------- */
  function openDayModal() {
    $('dayModal').hidden = false;
    document.body.classList.add('modal-open');
    var d = $('dayModal').querySelector('details.bulk-details');
    if (d) d.open = false;
  }
  function closeDayModal() {
    if ($('dayModal').hidden) return;
    $('dayModal').hidden = true;
    document.body.classList.remove('modal-open');
    closeAllScrollDropdowns(null);
  }

  /* ==========================================================
     탭 1: 급여 폼 읽기 & 계산 & 렌더링
     ========================================================== */
  function getSelectedMode() { return 'daily'; } // 근무시간 입력은 날짜별(달력) 방식만 사용

  function getSelectedTax() {
    var checked = document.querySelector('input[name="pTax"]:checked');
    return checked ? checked.value : '3.3';
  }

  function setSelectedTax(val) {
    var el = document.querySelector('input[name="pTax"][value="' + val + '"]');
    if (el) el.checked = true;
  }

  function readPayrollForm() {
    var payMonth = $('pMonth').value;
    ensureCalendarAndShifts(payMonth, false);

    return {
      name: $('pName').value,
      payMonth: payMonth,
      hourlyWage: E.toNumber($('pWage').value, 0),
      mode: 'daily',
      totalHours: 0,
      weekHours: [],
      dailyShifts: state.dailyShifts.map(function (s) { return Object.assign({}, s); }),
      lateMinutes: 0, // 지각·조퇴 입력은 UI에서 제거됨 (항상 0)
      contractDays: state.contractDays,
      weekExcuse: state.weekExcuse.slice(0, 6),
      weekAbsent: state.weekAbsent.slice(0, 6),
      includeWeekly: $('pWeekly').checked,
      includeMeal: $('pMeal').checked,
      mealMinHours: E.toNumber($('pMealMinHours').value, 4),
      mealAmount: E.toNumber($('pMealAmount').value, 8000),
      mealDays: null,
      tax: getSelectedTax()
    };
  }

  function syncModeAndHighlights(r) {
    var showSched = state.rightView === 'schedule';
    $('scheduleBoard').hidden = !showSched;
    $('payDoc').hidden = showSched;

    $('weeklyBox').classList.toggle('on', $('pWeekly').checked);
    $('mealBox').classList.toggle('on', $('pMeal').checked);
    $('mealConfig').hidden = !$('pMeal').checked;

    if (r) {
      $('dailyTotalHours').textContent = E.formatNum(r.totalHours, 2);
      $('dailyWorkDays').textContent = r.workDays;
      $('dailyMealDays').textContent = r.mealDays;

      $('mealSummaryText').textContent = r.includeMeal
        ? tr('점심·저녁 {n}회 × {a} = +{b}', { n: r.mealDays, a: E.moneyText(r.mealAmount), b: E.moneyText(r.mealAllowance) })
        : tr('체크 시 점심·저녁 식사 시간에 일한 날 식대를 추가 지급합니다');

      renderMonthCalendar(r);
      renderTimeEditor();
    }
  }

  function renderPayroll(r) {
    state.payroll = r;
    $('pContractLabel').textContent = tr('주 {d}일', { d: state.contractDays });
    syncModeAndHighlights(r);

    $('bannerText').innerHTML =
      '<span class="pay-label">' + tr('<b>{n}</b>님에게 줄 돈 (실수령액)', { n: escHtml(r.name) }) + '</span>' +
      '<b class="money">' + moneyBig(r.net) + '</b>' +
      '<span class="pay-sub">' + tr('{h}시간 · 주휴 {w}', { h: E.formatNum(r.totalHours, 2), w: r.includeWeekly ? tr('포함') : tr('미포함') }) +
        (r.includeMeal ? tr(' · 식대 {n}회 포함', { n: r.mealDays }) : '') + ' · ' + escHtml(r.tax.label) + '</span>';
    $('setSummary').textContent = tr('시급 {w} · 주 {d}일 · ', { w: E.moneyText(r.hourlyWage), d: state.contractDays }) +
      r.tax.label + tr(' · 주휴 {s}', { s: r.includeWeekly ? tr('포함') : tr('미포함') }) +
      (r.includeMeal ? tr(' · 식대 {a}', { a: E.moneyText(r.mealAmount) }) : tr(' · 식대 없음'));

    $('slipName').textContent = r.name;
    $('slipMonth').textContent = r.payMonthLabel;
    $('slipWage').textContent = E.moneyText(r.hourlyWage);
    var modeLabel = r.mode === 'daily'
      ? tr('일별 출퇴근 · {d}일 / {n}개 주차', { d: r.workDays, n: r.weeks.length })
      : (r.mode === 'weekly' ? tr('주차별 · {n}개 주차', { n: r.weeks.length }) : tr('4주 균등'));
    $('slipHours').textContent = tr('{h}시간 ({m})', { h: E.formatNum(r.totalHours, 2), m: modeLabel });
    $('slipWeekly').innerHTML =
      tr('주휴') + ' <span class="pill ' + (r.includeWeekly ? 'pill-ok' : 'pill-off') + '">' + (r.includeWeekly ? tr('포함') : tr('미포함')) + '</span> ' +
      '· ' + tr('식대') + ' <span class="pill ' + (r.includeMeal ? 'pill-ok' : 'pill-off') + '">' + (r.includeMeal ? tr('{n}회', { n: r.mealDays }) : tr('미포함')) + '</span>';
    $('slipTax').textContent = r.tax.label;

    $('slipBody').innerHTML = r.rows.map(function (row) {
      var cls = 'row-' + row.kind;
      var isPositiveBadge = row.badge && row.badge !== tr('미포함');
      var badge = row.badge
        ? ' <span class="pill ' + (isPositiveBadge ? 'pill-ok' : 'pill-off') + '">' + escHtml(row.badge) + '</span>'
        : '';
      var amtPrefix = row.sign < 0 && row.amount > 0 ? '-' : '';
      var detail = row.detail ? '<div class="detail">' + escHtml(row.detail) + '</div>' : '';
      return '<tr class="' + cls + '">' +
        '<td class="sec">' + escHtml(row.section) + '</td>' +
        '<td class="label">' + escHtml(row.label) + badge + '</td>' +
        '<td class="num">' + amtPrefix + E.moneyText(row.amount) + '</td>' +
        '<td class="formula">' + escHtml(row.formula) + detail + '</td>' +
        '</tr>';
    }).join('');

    $('weekStrip').innerHTML = r.weeks.map(function (w) {
      var active = r.includeWeekly && w.eligible;
      var mealSub = r.includeMeal && r.mode === 'daily' ? (' · 🍚 ' + tr('식대 {n}회', { n: w.mealDays })) : '';
      return '<div class="week-cell ' + (active ? 'yes' : 'no') + '">' +
        '<b>' + tr('{k}주차', { k: w.week }) + ' · ' + E.formatNum(w.hours, 2) + 'h' + mealSub + '</b>' +
        '<span class="w-amt">' + (r.includeWeekly
          ? (w.eligible
              ? tr('주휴 +{a}', { a: E.moneyText(w.allowance) }) + (w.excused ? tr(' (결근 있으나 지급)') : '')
              : (!w.hoursOk ? tr('15h 미만 (주휴 0원)')
                : tr('결근으로 주휴 없음') + (w.workDays !== null && w.workDays !== undefined ? ' (' + tr('{a}/{b}일', { a: w.workDays, b: w.contractDays }) + ')' : '')))
          : tr('주휴 미포함 (0원)')) + '</span>' +
        '</div>';
    }).join('');
  }

  function recalcPayroll() {
    var inp = readPayrollForm();
    var r = E.calculatePayroll(inp);
    renderPayroll(r);
  }

  /* ---------- 설정 (세율·보험료율·최저시급) ---------- */
  var MEAL_TIME_KEYS = ['lunchStart', 'lunchEnd', 'dinnerStart', 'dinnerEnd'];
  var RATE_KEYS = ['incomeTax', 'localTax', 'pension', 'health', 'care', 'employment'];

  function fillSettingsForm() {
    $('sMinWage').value = state.settings.minWage;
    MEAL_TIME_KEYS.forEach(function (k) { $('sMeal_' + k).value = state.settings.mealTimes[k]; });
    RATE_KEYS.forEach(function (k) { $('sRate_' + k).value = state.settings.rates[k]; });
    fillPunchUnit();
  }

  function punchUnit() { return state.settings.punchUnit || 30; }
  function fillPunchUnit() {
    var sel = $('sPunchUnit');
    if (!sel) return;
    sel.value = String(punchUnit());
    var u = punchUnit();
    $('punchUnitNote').textContent = u === 1
      ? tr('찍은 시각 그대로 기록해요. (출근·퇴근 모두 분 단위 그대로)')
      : tr('출근은 올림, 퇴근은 내림이에요. 예) {u}분 단위: 출근 {a} → {b}, 퇴근 {c} → {d}', { u: u, a: '08:59', b: E.roundUpUnit('08:59', u), c: '09:59', d: E.roundDownUnit('09:59', u) });
  }

  /* 설정을 계산·화면에 반영 */
  function applySettings() {
    E.setRates(state.settings.rates);
    E.setMealTimes(state.settings.mealTimes);
    var mw = state.settings.minWage;
    $('minWageHint').textContent = tr('최저시급 {a}', { a: E.moneyText(mw) });
    $('awWage').value = mw;
    var r = state.settings.rates;
    var eff = Math.round(r.incomeTax * (1 + r.localTax / 100) * 1000) / 1000;
    var lab = document.querySelector('input[name="pTax"][value="3.3"] + span');
    if (lab) lab.textContent = eff + '%';
    fillSettingsForm();
    recalcPayroll();
    renderRoster();
  }

  function onSettingsInput() {
    var raw = { minWage: $('sMinWage').value, rates: {}, mealTimes: {}, punchUnit: state.settings.punchUnit };
    RATE_KEYS.forEach(function (k) { raw.rates[k] = $('sRate_' + k).value; });
    MEAL_TIME_KEYS.forEach(function (k) { raw.mealTimes[k] = $('sMeal_' + k).value; });
    state.settings = E.sanitizeSettings(raw);
    saveJson(KEYS.settings, state.settings);
    E.setRates(state.settings.rates);
    E.setMealTimes(state.settings.mealTimes);
    // 입력 중인 칸은 그대로 두고 계산 결과만 갱신
    var r = state.settings.rates;
    var eff = Math.round(r.incomeTax * (1 + r.localTax / 100) * 1000) / 1000;
    var lab = document.querySelector('input[name="pTax"][value="3.3"] + span');
    if (lab) lab.textContent = eff + '%';
    $('minWageHint').textContent = tr('최저시급 {a}', { a: E.moneyText(state.settings.minWage) });
    $('awWage').value = state.settings.minWage;
    recalcPayroll();
    renderRoster();
  }

  /* ---------- 알바생 중심 기록: 선택 / 불러오기 / 자동 저장 ---------- */
  function selWorker() {
    for (var i = 0; i < state.workers.length; i++) if (state.workers[i].id === state.selId) return state.workers[i];
    return null;
  }

  function saveWorkers() { saveJson(KEYS.workers, state.workers); }

  function todayIndexIn(payMonth) {
    var n = new Date();
    return payMonth === n.getFullYear() + '-' + pad2(n.getMonth() + 1) ? n.getDate() - 1 : 0;
  }

  /* 선택한 알바생의 (지급월) 설정과 근무 기록을 화면에 채운다. 알바생이 없으면 빈 화면. */
  function loadSelected() {
    var w = selWorker();
    var pm = $('pMonth').value;
    var s = E.workerSettings(w, pm);
    if (!w) s.wage = state.settings.minWage;
    $('pName').value = w ? w.name : '';
    $('pName').disabled = !w;
    $('pPw').value = w && w.password ? w.password : '';
    $('pPw').disabled = !w;
    $('noWorkerNote').hidden = !!w;
    $('pWage').value = s.wage;
    state.contractDays = s.contractDays;
    $('pWeekly').checked = s.includeWeekly;
    $('pMeal').checked = s.includeMeal;
    $('pMealMinHours').value = s.mealMinHours;
    $('pMealAmount').value = s.mealAmount;
    setSelectedTax(s.tax);
    state.dailyShifts = w ? E.workerShifts(w, pm) : E.emptyShifts(pm);
    state.weekExcuse = w ? E.workerExcuse(w, pm) : [];
    state.weekAbsent = [];
    state.selectedDayIdx = todayIndexIn(pm);
    ensureCalendarAndShifts(pm, true);
  }

  /* 화면에서 고친 내용을 그 알바생의 그 달 기록으로 저장 (구글 연동 중이면 시트에도 자동 반영) */
  function persistSelected() {
    var w = selWorker();
    if (!w) return;
    var inp = readPayrollForm();
    var nm = String(inp.name || '').trim();
    if (nm) w.name = nm.slice(0, 20);
    E.setRecord(w, inp.payMonth, {
      wage: inp.hourlyWage, contractDays: inp.contractDays, includeWeekly: inp.includeWeekly,
      includeMeal: inp.includeMeal, mealMinHours: inp.mealMinHours, mealAmount: inp.mealAmount,
      tax: inp.tax, dailyShifts: inp.dailyShifts, weekExcuse: inp.weekExcuse
    });
    saveWorkers();
  }

  /* 사용자가 값을 바꿨을 때: 저장 + 다시 계산 + 명단 갱신 */
  function editPayroll() {
    persistSelected();
    recalcPayroll();
    renderRoster();
  }

  function selectWorker(id) {
    state.selId = id || '';
    loadSelected();
    recalcPayroll();
    renderRoster();
  }

  function monthResults() {
    var pm = $('pMonth').value;
    return state.workers.map(function (w) { return E.calculatePayroll(E.workerPayrollInput(w, pm)); });
  }

  /* 폰 전용: 맨 위 알바생 칩 (많으면 손가락으로 옆으로 밀어서 넘김) */
  function renderChips() {
    var box = $('workerChips');
    document.body.classList.toggle('no-workers', !state.workers.length);
    var html = '<button type="button" class="wchip wchip-add" id="chipAdd" aria-label="' + tr('알바생 추가') + '">＋</button>' +
      state.workers.map(function (w) {
        return '<button type="button" class="wchip' + (w.id === state.selId ? ' on' : '') + '" data-chip="' + escHtml(w.id) + '">' + (E.punchNext(w, new Date()) === 'out' ? '<i class="wdot" aria-hidden="true"></i>' : '') + escHtml(w.name) + '</button>';
      }).join('');
    var keep = box.scrollLeft;
    box.innerHTML = html;
    box.scrollLeft = keep;
    var on = box.querySelector('.wchip.on');
    if (on) {   // 고른 칩이 가려져 있으면 칩 줄만 가로로 이동 (화면은 안 움직임)
      var l = on.offsetLeft - box.offsetLeft, r = l + on.offsetWidth;
      if (l < box.scrollLeft + 56) box.scrollLeft = Math.max(0, l - 64);
      else if (r > box.scrollLeft + box.clientWidth) box.scrollLeft = r - box.clientWidth + 16;
    }
  }

  function openSheet(kind) {   // 'set' | 'add'
    document.body.classList.remove('set-open', 'add-open');
    document.body.classList.add(kind + '-open');
    $('sheetBackdrop').hidden = false;
  }
  function closeSheets() {
    document.body.classList.remove('set-open', 'add-open', 'slip-open', 'export-open');
    $('sheetBackdrop').hidden = true;
  }

  /* 출퇴근 탭에서 출근을 찍고 아직 퇴근 전이면 급여 화면에도 파란 표시 */
  function workingBadge(w) {
    if (E.punchNext(w, new Date()) !== 'out') return '';
    return ' <span class="pill pill-work">' + tr('근무 중 · {t} 출근', { t: escHtml(w.punch.time) }) + '</span>';
  }
  function renderWorkNow() {
    var box = $('workNow');
    if (!box) return;
    var now = new Date();
    var on = state.workers.filter(function (w) { return E.punchNext(w, now) === 'out'; });
    if (!on.length) { box.hidden = true; box.innerHTML = ''; return; }
    box.innerHTML = on.map(function (w) {
      return '<div class="work-now-row"><i class="wdot" aria-hidden="true"></i>' +
        tr('{n}님 근무 중 · {t} 출근', { n: escHtml(w.name), t: escHtml(w.punch.time) }) + '</div>';
    }).join('');
    box.hidden = false;
  }

  function renderRoster() {
    var pm = $('pMonth').value;
    var results = monthResults();
    var sum = E.summarizePayrolls(results);
    $('rosterCount').textContent = tr('{n}명', { n: sum.count });
    $('rosterTotal').textContent = E.moneyText(sum.totalNet);
    $('rosterMonthLabel').textContent = tr('{y}년 {m}월', { y: pm.slice(0, 4), m: Number(pm.slice(5)) });
    renderChips();
    renderWorkNow();
    renderPunch();

    $('rosterCards').innerHTML = results.map(function (r, idx) {
      var w = state.workers[idx];
      var hasRec = !!(w.months && w.months[pm]);
      var sel = w.id === state.selId;
      return '<div class="rcard' + (sel ? ' on' : '') + '">' +
        '<button type="button" class="rcard-main" data-pick-worker="' + escHtml(w.id) + '">' +
          '<span class="rcard-name">' + escHtml(r.name) + (sel ? ' <em>' + tr('보는 중') + '</em>' : '') + workingBadge(w) + '</span>' +
          '<span class="rcard-sub">' + (hasRec ? tr('{h}시간 · 식대 {m}', { h: E.formatNum(r.totalHours, 2), m: r.includeMeal ? tr('{n}회', { n: r.mealDays }) : tr('없음') }) : tr('기록 없음')) + '</span>' +
        '</button>' +
        '<b class="rcard-amt m-amt">' + E.moneyText(r.net) + '</b>' +
        '<button type="button" class="rcard-del" data-del-worker="' + escHtml(w.id) + '" aria-label="' + escHtml(tr('{n} 삭제', { n: r.name })) + '">✕</button>' +
        '</div>';
    }).join('');

    if (!results.length) {
      $('rosterBody').innerHTML = '<tr class="empty"><td colspan="11">아직 알바생이 없습니다. 위에서 이름·일하는 날·시급을 넣고 [➕ 알바생 추가]를 눌러주세요.</td></tr>';
      $('rosterFoot').innerHTML = '';
      return;
    }

    $('rosterBody').innerHTML = results.map(function (r, idx) {
      var w = state.workers[idx];
      var hasRec = !!(w.months && w.months[pm]);
      var sel = w.id === state.selId;
      return '<tr class="roster-row' + (sel ? ' selected' : '') + '" data-wid="' + escHtml(w.id) + '">' +
        '<td>' + (idx + 1) + '</td>' +
        '<td><button type="button" class="worker-link" data-pick-worker="' + escHtml(w.id) + '"><b>' + escHtml(r.name) + '</b></button>' +
          (sel ? ' <span class="pill pill-ok">' + tr('보는 중') + '</span>' : '') + workingBadge(w) + '</td>' +
        '<td>' + escHtml(r.payMonthLabel) + '</td>' +
        '<td class="num">' + (hasRec ? E.formatNum(r.totalHours, 2) + 'h' : '<small class="muted">' + tr('기록 없음') + '</small>') + '</td>' +
        '<td class="num">' + E.moneyText(r.hourlyWage) + '</td>' +
        '<td class="num">' + E.moneyText(r.weeklyAllowance) + ' <span class="pill ' + (r.includeWeekly ? 'pill-ok' : 'pill-off') + '">' + (r.includeWeekly ? tr('포함') : tr('미포함')) + '</span></td>' +
        '<td class="num">' + E.moneyText(r.mealAllowance) + ' <span class="pill ' + (r.includeMeal ? 'pill-ok' : 'pill-off') + '">' + (r.includeMeal ? tr('{n}회', { n: r.mealDays }) : tr('미포함')) + '</span></td>' +
        '<td class="num">' + E.moneyText(r.gross) + '</td>' +
        '<td class="num">' + (r.tax.total ? '-' + E.moneyText(r.tax.total) : E.moneyText(0)) + ' <small class="muted">(' + escHtml(r.tax.type === 'none' ? '0%' : (r.tax.type === '3.3' ? '3.3%' : tr('4대'))) + ')</small></td>' +
        '<td class="num net">' + E.moneyText(r.net) + '</td>' +
        '<td class="num"><button type="button" class="btn-del" data-del-worker="' + escHtml(w.id) + '" title="' + tr('이 알바생 삭제') + '">✕</button></td>' +
        '</tr>';
    }).join('');

    $('rosterFoot').innerHTML =
      '<tr>' +
      '<td colspan="3">' + tr('합계 ({n}명)', { n: sum.count }) + '</td>' +
      '<td class="num">' + E.formatNum(sum.totalHours, 2) + 'h</td>' +
      '<td class="num">-</td>' +
      '<td class="num">' + E.moneyText(sum.totalWeekly) + '</td>' +
      '<td class="num">' + E.moneyText(sum.totalMeal) + '</td>' +
      '<td class="num">' + E.moneyText(sum.totalGross) + '</td>' +
      '<td class="num">' + (sum.totalTax ? '-' + E.moneyText(sum.totalTax) : E.moneyText(0)) + '</td>' +
      '<td class="num">' + E.moneyText(sum.totalNet) + '</td>' +
      '<td></td>' +
      '</tr>';
  }

  /* ==========================================================
     탭 2: 매장 위생 점검 (41개 항목)
     ========================================================== */
  function readChecklistForm() {
    return {
      store: $('cStore').value,
      date: $('cDate').value,
      inspector: $('cInspector').value,
      fridgeTemp: $('cFridge').value === '' ? null : E.toNumber($('cFridge').value, null),
      freezerTemp: $('cFreezer').value === '' ? null : E.toNumber($('cFreezer').value, null),
      memo: $('cMemo').value,
      checks: Array.prototype.map.call(
        document.querySelectorAll('#chkFormList input[type=checkbox]:checked'),
        function (el) { return Number(el.value); })
    };
  }

  /* 점검 항목 체크 목록(왼쪽 입력 폼)을 한 번만 그린다 */
  function buildChecklistForm() {
    var html = '';
    E.getChecklistGroups().forEach(function (g) {
      html += '<section class="chk-form-group"><h4 class="chk-form-title">' + escHtml(g.title) + '</h4>';
      g.items.forEach(function (it) {
        html += '<label class="check-item chk-form-item"><input type="checkbox" value="' + it.no + '">' +
          '<span><b>' + it.no + '.</b> ' + escHtml(it.text) +
          (it.standard ? '<small class="item-std">' + escHtml(it.standard) + '</small>' : '') +
          '</span></label>';
      });
      html += '</section>';
    });
    $('chkFormList').innerHTML = html;
  }

  function setAllChecks(on) {
    Array.prototype.forEach.call(document.querySelectorAll('#chkFormList input[type=checkbox]'), function (el) { el.checked = on; });
    recalcChecklist();
  }

  function renderChecklist(c) {
    state.checklist = c;

    var fh = $('fridgeHint');
    fh.className = 'temp-hint ' + (c.fridgeOk ? 'ok' : 'bad');
    fh.textContent = c.fridgeOk ? tr('✓ 적정 (0~5°C)') : tr('⚠ 기준 이탈 (0~5°C 유지 필요)');

    var fzh = $('freezerHint');
    fzh.className = 'temp-hint ' + (c.freezerOk ? 'ok' : 'bad');
    fzh.textContent = c.freezerOk ? tr('✓ 적정 (-18°C 이하)') : tr('⚠ 기준 이탈 (-18°C 이하 유지 필요)');

    var banner = $('chkBanner');
    banner.className = 'banner chk-banner ' + (c.allPass ? 'ok' : 'bad');
    $('chkBannerText').textContent = c.allPass
      ? tr('✅ 위생 점검 {n}개 항목 모두 적합합니다.', { n: c.total })
      : tr('⚠️ 점검필요 항목이 {n}건 있습니다. 체크하지 않은 항목과 온도를 확인하세요.', { n: c.failCount });
    $('chkScore').textContent = tr('적합 {p}/{n}', { p: c.passCount, n: c.total });
    $('chkProgress').textContent = tr('{a} / {b} 체크', { a: c.input.checks.length, b: c.total });

    $('chkStore').textContent = c.store;
    $('chkDate').textContent = c.date || '-';
    $('chkInspector').textContent = c.inspector;
    $('chkVerdict').innerHTML = '<span class="result ' + (c.allPass ? 'ok' : 'bad') + '">' + escHtml(c.verdict) + '</span>';
    $('chkFridge').textContent = (c.fridgeTemp === null ? tr('미입력') : E.formatNum(c.fridgeTemp, 1) + '°C') + (c.fridgeOk ? tr(' (적정)') : tr(' (이탈)'));
    $('chkFreezer').textContent = (c.freezerTemp === null ? tr('미입력') : E.formatNum(c.freezerTemp, 1) + '°C') + (c.freezerOk ? tr(' (적정)') : tr(' (이탈)'));
    $('chkMemo').textContent = c.memo || tr('특이사항 없음');
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
          '<td>' + escHtml(it.text) + (it.standard ? '<span class="item-std">' + tr('기준: {s}', { s: escHtml(it.standard) }) + '</span>' : '') + '</td>' +
          '<td><span class="result ' + (it.ok ? 'ok' : 'bad') + '">' + escHtml(it.status) + '</span></td>' +
          '<td class="note">' + escHtml(it.note) + '</td>' +
          '</tr>';
      });
    });
    $('chkBody').innerHTML = rowsHtml;

    // 휴대폰용 카드 목록 (CSS가 문서 영역 폭에 따라 표/카드 중 하나만 표시)
    var cardsHtml = '';
    c.groups.forEach(function (g) {
      cardsHtml += '<section class="chk-group"><h4 class="chk-group-title">' + escHtml(g.title) + '</h4>';
      g.items.forEach(function (it) {
        cardsHtml += '<div class="chk-item ' + (it.ok ? 'ok' : 'bad') + '">' +
          '<span class="chk-item-no">' + it.no + '</span>' +
          '<div class="chk-item-body">' +
            '<div class="chk-item-text">' + escHtml(it.text) + '</div>' +
            '<div class="chk-item-std">' + (it.standard ? tr('기준: {s}', { s: escHtml(it.standard) }) + ' · ' : '') + escHtml(it.note) + '</div>' +
          '</div>' +
          '<span class="result ' + (it.ok ? 'ok' : 'bad') + '">' + escHtml(it.status) + '</span>' +
          '</div>';
      });
      cardsHtml += '</section>';
    });
    $('chkCards').innerHTML = cardsHtml;
  }

  function recalcChecklist() {
    var inp = readChecklistForm();
    saveJson(KEYS.store, { store: inp.store, inspector: inp.inspector });
    var c = E.buildChecklist(inp);
    renderChecklist(c);
  }

  function renderArchive() {
    var results = state.archive.map(function (inp) { return E.buildChecklist(inp); });
    $('archiveCount').textContent = tr('{n}일', { n: results.length });

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
        '<td class="num"><button type="button" class="btn-del" data-del-archive="' + idx + '" title="' + tr('삭제') + '">✕</button></td>' +
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

    state.selId = state.workers.length ? state.workers[0].id : '';
    loadSelected();

    var savedStore = loadJson(KEYS.store, null);
    if (savedStore) {
      if (savedStore.store) $('cStore').value = savedStore.store;
      if (savedStore.inspector) $('cInspector').value = savedStore.inspector;
    }
    if (!$('cStore').value) $('cStore').value = tr('행복분식 강남점');
    if (!$('cInspector').value) $('cInspector').value = tr('김사장');
  }

  function bindEvents() {
    $('themeToggle').addEventListener('click', toggleTheme);
    $('fontToggle').addEventListener('click', toggleFontSize);

    // 우측 상단 뷰 전환 탭 (일별 출퇴근 시간표 크게 입력 <-> 표준 급여명세서 보기)
    $('btnViewSchedule').addEventListener('click', function () { setRightView('schedule'); });
    $('btnViewSlip').addEventListener('click', function () { setRightView('slip'); });

    // 달력 날짜 클릭 -> 해당 날짜 선택
    // 주 근무 약속일수 − / +
    function shiftContractDays(delta) {
      state.contractDays = Math.min(7, Math.max(1, state.contractDays + delta));
      editPayroll();
    }
    $('pContractMinus').addEventListener('click', function () { shiftContractDays(-1); });
    $('pContractPlus').addEventListener('click', function () { shiftContractDays(1); });

    // 결근 주의 "주휴 지급" 예외 버튼(달력 표/카드) 및 주차별 모드 결근 칩
    function onWeekToggleClick(ev) {
      var ex = ev.target.closest('[data-week-excuse]');
      if (ex) {
        var wi = Number(ex.getAttribute('data-week-excuse'));
        state.weekExcuse[wi] = !state.weekExcuse[wi];
        editPayroll();
        return;
      }
      var ab = ev.target.closest('[data-week-absent]');
      if (ab) {
        var ai = Number(ab.getAttribute('data-week-absent'));
        state.weekAbsent[ai] = !state.weekAbsent[ai];
        editPayroll();
      }
    }
    $('monthCalBody').addEventListener('click', onWeekToggleClick);

    function onCalDayClick(ev) {
      var cell = ev.target.closest('[data-day-idx]');
      if (!cell) return;
      var idx = Number(cell.getAttribute('data-day-idx'));
      loadDayIntoEditor(idx);
      recalcPayroll();
      openDayModal();
    }
    $('monthCalBody').addEventListener('click', onCalDayClick);
    $('dayClose').addEventListener('click', closeDayModal);
    $('dayModalBackdrop').addEventListener('click', closeDayModal);
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') closeDayModal();
    });

    // 드롭다운 스크롤 피커 열기/닫기 및 옵션 선택
    [
      { btnId: 'startHourBtn', wrapId: 'startHourDropdown' },
      { btnId: 'startMinBtn', wrapId: 'startMinDropdown' },
      { btnId: 'endHourBtn', wrapId: 'endHourDropdown' },
      { btnId: 'endMinBtn', wrapId: 'endMinDropdown' }
    ].forEach(function (item) {
      $(item.btnId).addEventListener('click', function (ev) {
        ev.stopPropagation();
        toggleScrollDropdown(item.wrapId);
      });
    });

    document.addEventListener('click', function (ev) {
      if (!ev.target.closest('.scroll-select')) {
        closeAllScrollDropdowns(null);
      }
    });

    $('startHourMenu').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-sh]');
      if (!b) return;
      state.editor.startHour = Number(b.getAttribute('data-sh'));
      state.editor.off = false;
      closeAllScrollDropdowns(null);
      applyEditorToSelectedDay();
    });
    $('endHourMenu').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-eh]');
      if (!b) return;
      state.editor.endHour = Number(b.getAttribute('data-eh'));
      if (state.editor.endHour === 24) state.editor.endMin = 0;
      state.editor.off = false;
      closeAllScrollDropdowns(null);
      applyEditorToSelectedDay();
    });
    $('startMinMenu').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-sm]');
      if (!b) return;
      state.editor.startMin = Number(b.getAttribute('data-sm'));
      state.editor.off = false;
      closeAllScrollDropdowns(null);
      applyEditorToSelectedDay();
    });
    $('endMinMenu').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-em]');
      if (!b) return;
      if (state.editor.endHour === 24) state.editor.endHour = 23;
      state.editor.endMin = Number(b.getAttribute('data-em'));
      state.editor.off = false;
      closeAllScrollDropdowns(null);
      applyEditorToSelectedDay();
    });

    // 휴게시간 칩 선택
    $('breakBtns').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-break-val]');
      if (!b) return;
      state.editor.breakMinutes = Number(b.getAttribute('data-break-val'));
      applyEditorToSelectedDay();
    });

    // 식대 점심/저녁 체크: 자동 결과와 같게 되돌리면 '자동'으로, 다르게 고치면 '직접 고침'
    ['mealLunch', 'mealDinner'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        var base = currentEditorShift();
        delete base.meals;
        var minMeal = E.toNumber($('pMealMinHours').value, 4);
        var auto = E.mealsForShift(storeShift(base), minMeal).auto;
        var want = [];
        if ($('mealLunch').checked) want.push('L');
        if ($('mealDinner').checked) want.push('D');
        var same = (auto.lunch === ($('mealLunch').checked)) && (auto.dinner === ($('mealDinner').checked));
        state.editor.meals = same ? null : want;
        applyEditorToSelectedDay();
      });
    });

    // 빠른 시간대 프리셋 (사용자 정의, 최대 20개)
    initTimePresets();

    // 적용 범위 버튼들
    $('btnApplySelectedDay').addEventListener('click', function () {
      applyEditorToSelectedDay();
      closeDayModal();
    });

    $('btnApplyWeekday').addEventListener('click', function () {
      var sh = currentEditorShift();
      state.calendar.days.forEach(function (cd, i) {
        if (!cd.isWeekend) {
          state.dailyShifts[i] = storeShift(sh);
        }
      });
      editPayroll();
      closeDayModal();
      showToast(tr('📅 평일(월~금) 전체에 {s} 일괄 적용!', { s: sh.off ? tr('휴무') : (sh.start + '~' + sh.end) }));
    });

    $('btnApplyWeekend').addEventListener('click', function () {
      var sh = currentEditorShift();
      state.calendar.days.forEach(function (cd, i) {
        if (cd.isWeekend) {
          state.dailyShifts[i] = storeShift(sh);
        }
      });
      editPayroll();
      closeDayModal();
      showToast(tr('📅 주말(토·일) 전체에 {s} 일괄 적용!', { s: sh.off ? tr('휴무') : (sh.start + '~' + sh.end) }));
    });

    $('btnApplySameDow').addEventListener('click', function () {
      var sh = currentEditorShift();
      var targetDow = state.calendar.days[state.selectedDayIdx].dow;
      var dayName = E.dayName(targetDow);
      state.calendar.days.forEach(function (cd, i) {
        if (cd.dow === targetDow) {
          state.dailyShifts[i] = storeShift(sh);
        }
      });
      editPayroll();
      closeDayModal();
      showToast(tr('📅 이번 달 모든 {w}요일에 {s} 일괄 적용!', { w: dayName, s: sh.off ? tr('휴무') : (sh.start + '~' + sh.end) }));
    });

    $('btnSetDayOff').addEventListener('click', function () {
      state.editor.off = true;
      applyEditorToSelectedDay();
      var cd = state.calendar.days[state.selectedDayIdx];
      closeDayModal();
      showToast(tr('🚫 {d}일({w}) 휴무 처리', { d: cd.date, w: cd.dayName }));
    });

    $('btnClearAllDays').addEventListener('click', function () {
      state.dailyShifts = state.calendar.days.map(function () {
        return { off: true, start: '09:00', end: '14:00', breakMinutes: 0 };
      });
      state.editor.off = true;
      state.editor.meals = null;
      editPayroll();
      showToast(tr('📅 이번 달 전체를 휴무(0시간)로 초기화했습니다.'));
    });

    // 지급월 ◀ ▶ 버튼 (한글 "2026년 11월" 표기)
    function shiftPayMonth(delta) {
      var m = /^(\d{4})-(\d{2})$/.exec($('pMonth').value || '');
      var d = m ? new Date(Number(m[1]), Number(m[2]) - 1 + delta, 1) : new Date();
      $('pMonth').value = d.getFullYear() + '-' + pad2(d.getMonth() + 1);
      $('pMonth').dispatchEvent(new Event('change'));
    }
    $('pMonthPrev').addEventListener('click', function () { shiftPayMonth(-1); });
    $('pMonthNext').addEventListener('click', function () { shiftPayMonth(1); });
    syncPayMonthLabel();

    // 지급월 라벨을 누르면 1~12월 선택 창 (해 단위 이동 가능)
    var mpYear = new Date().getFullYear();
    function curPayMonth() {
      var m = /^(\d{4})-(\d{2})$/.exec($('pMonth').value || '');
      return m ? { y: Number(m[1]), m: Number(m[2]) } : { y: new Date().getFullYear(), m: new Date().getMonth() + 1 };
    }
    function renderMonthPicker() {
      var cur = curPayMonth();
      var has = {};
      E.recordMonths(state.workers).forEach(function (k) { has[k] = true; });
      $('mpYearLabel').textContent = tr('{y}년', { y: mpYear });
      var html = '';
      for (var mo = 1; mo <= 12; mo++) {
        var key = mpYear + '-' + pad2(mo);
        html += '<button type="button" class="mp-month' + (cur.y === mpYear && cur.m === mo ? ' current' : '') + (has[key] ? ' has' : '') +
          '" data-mp="' + key + '">' + tr('{m}월', { m: mo }) + '</button>';
      }
      $('mpGrid').innerHTML = html;
    }
    function setMonthPicker(open) {
      $('monthPicker').hidden = !open;
      $('pMonthLabel').setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) { mpYear = curPayMonth().y; renderMonthPicker(); }
    }
    function pickMonth(key) {
      if (key !== $('pMonth').value) {
        $('pMonth').value = key;
        $('pMonth').dispatchEvent(new Event('change'));
      }
      setMonthPicker(false);
    }
    $('pMonthLabel').addEventListener('click', function () { setMonthPicker($('monthPicker').hidden); });
    $('mpYearPrev').addEventListener('click', function () { mpYear--; renderMonthPicker(); });
    $('mpYearNext').addEventListener('click', function () { mpYear++; renderMonthPicker(); });
    $('mpGrid').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-mp]');
      if (b) pickMonth(b.getAttribute('data-mp'));
    });
    $('mpThisMonth').addEventListener('click', function () {
      var n = new Date();
      pickMonth(n.getFullYear() + '-' + pad2(n.getMonth() + 1));
    });
    document.addEventListener('click', function (ev) {
      if (!$('monthPicker').hidden && !ev.target.closest('.month-field')) setMonthPicker(false);
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && !$('monthPicker').hidden) setMonthPicker(false);
    });

    // 지급월 변경 시 해당 월의 실제 달력/주차 재구성
    $('pMonth').addEventListener('change', function () {
      syncPayMonthLabel();
      var w = selWorker();
      var pm = $('pMonth').value;
      loadSelected();           // 그 알바생의 그 달 기록 (없으면 빈 달력)
      recalcPayroll();
      renderRoster();
      var label = tr('{y}년 {m}월', { y: state.calendar.year, m: state.calendar.month });
      showToast(w
        ? ('📅 ' + tr('{n}님 {l}', { n: w.name, l: label }) + (w.months[pm] ? tr(' 기록을 불러왔습니다') : tr(' — 아직 기록이 없어 비어 있습니다')))
        : ('📅 ' + label));
    });

    // 출퇴근 비밀번호: 알바생 정보에 저장 (월 기록과 무관)
    $('pPw').addEventListener('input', function () {
      var w = selWorker();
      if (!w) return;
      var pw = E.cleanPassword($('pPw').value);
      if (pw) w.password = pw; else delete w.password;
      saveWorkers();
    });

    // 급여 폼 실시간 반응
    ['pName', 'pWage', 'pMealMinHours', 'pMealAmount'].forEach(function (id) {
      $(id).addEventListener('input', editPayroll);
    });
    ['pWeekly', 'pMeal'].forEach(function (id) {
      $(id).addEventListener('change', editPayroll);
    });
    document.querySelectorAll('input[name="pTax"]').forEach(function (el) {
      el.addEventListener('change', editPayroll);
    });

    // ----- 폰 전용 화면: 칩 / 설정 창 / 알바생 추가 창 / 명세서 -----
    $('workerChips').addEventListener('click', function (ev) {
      if (ev.target.closest('#chipAdd')) { openSheet('add'); return; }
      var c = ev.target.closest('[data-chip]');
      if (c) selectWorker(c.getAttribute('data-chip'));
    });
    $('emptyAdd').addEventListener('click', function () { openSheet('add'); });
    $('emptyGuide').addEventListener('click', function () {
      var t = document.querySelector('.tab[data-tab="guide"]');
      if (t) t.click();
    });
    $('openSet').addEventListener('click', function () { if (selWorker()) openSheet('set'); else openSheet('add'); });
    $('setSheetDone').addEventListener('click', closeSheets);
    $('addSheetClose').addEventListener('click', closeSheets);
    $('sheetBackdrop').addEventListener('click', closeSheets);
    $('btnSlipOpen').addEventListener('click', function () {
      document.body.classList.add('slip-open');
    });
    $('slipClose').addEventListener('click', closeSheets);
    $('moneyToggle').addEventListener('click', function () {   // 줄 돈은 기본 숨김, 눌러야 보임
      var on = document.body.classList.toggle('money-show');
      $('moneyToggle').setAttribute('aria-expanded', on ? 'true' : 'false');
      $('moneyToggleTitle').textContent = on ? tr('줄 돈 숨기기') : tr('줄 돈 보기');
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && /set-open|add-open|slip-open|export-open/.test(document.body.className)) closeSheets();
    });
    // 폰에서는 '지급월'을 설정 창 밖(맨 위)에 두고, PC에서는 원래 자리(시급 위)에 둔다
    var phoneMq = window.matchMedia('screen');
    function placeMonthField() {
      var mf = $('monthField'), sheet = $('setSheet');
      if (phoneMq.matches) sheet.parentNode.insertBefore(mf, sheet);
      else sheet.insertBefore(mf, $('fieldWage'));
    }
    placeMonthField();
    if (phoneMq.addEventListener) phoneMq.addEventListener('change', placeMonthField);
    else if (phoneMq.addListener) phoneMq.addListener(placeMonthField);

    // 카톡 명세서 복사
    $('copyKakao').addEventListener('click', function () {
      if (!state.payroll) return;
      copyText(state.payroll.kakaoText).then(function (ok) {
        showToast(ok ? tr('💬 카카오톡용 급여명세서가 클립보드에 복사되었습니다!') : tr('복사에 실패했습니다.'));
      });
    });

    // 급여 PDF / 엑셀 / 명단 추가
    $('btnPrintPay').addEventListener('click', function () { window.print(); });
    $('btnXlsxPay').addEventListener('click', function () {
      var r = state.payroll || E.calculatePayroll(readPayrollForm());
      downloadXlsx('./api/payroll/excel', { input: r.input }, function () { return E.payrollSlipXlsx(r); }, E.payrollFileName(r));
    });
    // 설정 탭
    ['sMinWage'].concat(RATE_KEYS.map(function (k) { return 'sRate_' + k; }), MEAL_TIME_KEYS.map(function (k) { return 'sMeal_' + k; })).forEach(function (id) {
      $(id).addEventListener('input', onSettingsInput);
      $(id).addEventListener('change', onSettingsInput);
      $(id).addEventListener('blur', fillSettingsForm);   // 비우거나 잘못 넣었으면 적용된 값으로 되돌려 보여줌
    });
    $('sPunchUnit').addEventListener('change', function () {
      state.settings = E.sanitizeSettings({ minWage: state.settings.minWage, rates: state.settings.rates, mealTimes: state.settings.mealTimes, punchUnit: $('sPunchUnit').value });
      saveJson(KEYS.settings, state.settings);
      fillPunchUnit();
      showToast(tr('출퇴근 시간을 {u}으로 끊어요.', { u: punchUnit() === 1 ? tr('찍은 그대로') : tr('{n}분 단위', { n: punchUnit() }) }));
    });
    $('btnSettingsReset').addEventListener('click', function () {
      if (!window.confirm(tr('세금·보험료 비율과 최저시급을 처음 값으로 되돌릴까요?'))) return;
      state.settings = E.sanitizeSettings({ punchUnit: state.settings.punchUnit });   // 출퇴근 끊는 단위는 그대로 둠
      saveJson(KEYS.settings, state.settings);
      applySettings();
      showToast(tr('처음 값으로 되돌렸습니다.'));
    });

    // 알바생 추가: 이름 + 계약서상 주 몇 일 + 시급 → 명단에 한 줄 생기고 바로 선택됨
    $('addWorkerForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var name = $('awName').value.trim();
      if (!name) { showToast(tr('이름을 입력해 주세요. 예) 홍길동')); $('awName').focus(); return; }
      var dup = state.workers.some(function (x) { return x.name === name; });
      if (dup) { showToast(tr('이미 있는 이름입니다. 구분되게 적어 주세요. 예) {n}2', { n: name })); $('awName').focus(); return; }
      var wage = E.toNumber($('awWage').value, 0);
      if (!(wage > 0)) { showToast(tr('시급을 입력해 주세요. 예) 10320')); $('awWage').focus(); return; }
      var cur = readPayrollForm();   // 식대·주휴·세금은 지금 화면의 설정으로 시작
      var w = E.createWorker(name, Number($('awDays').value), wage, {
        includeWeekly: cur.includeWeekly, includeMeal: cur.includeMeal,
        mealMinHours: cur.mealMinHours, mealAmount: cur.mealAmount, tax: cur.tax
      });
      var pw = E.cleanPassword($('awPw').value);
      if (pw) w.password = pw;
      state.workers.push(w);
      saveWorkers();
      $('awName').value = '';
      $('awPw').value = '';
      selectWorker(w.id);
      closeSheets();
      if (state.workers.length === 1) setTimeout(maybeAskPin, 700);
      showToast(tr('➕ {n}님을 추가했습니다. 이름을 누르면 근무 기록을 입력할 수 있어요.', { n: w.name }));
    });

    // 명단에서 이름을 누르면 그 알바생의 기록을 달력에 불러옴
    function onRosterClick(ev) {
      var del = ev.target.closest('[data-del-worker]');
      if (del) {
        var id = del.getAttribute('data-del-worker');
        var idx = state.workers.findIndex(function (x) { return x.id === id; });
        if (idx < 0) return;
        if (!window.confirm(tr('"{n}"님과 지금까지의 모든 월 기록을 삭제할까요?\n(삭제하면 되돌릴 수 없습니다)', { n: state.workers[idx].name }))) return;
        var gone = state.workers.splice(idx, 1)[0];
        saveWorkers();
        purgePunchRows([gone.code]);
        if (state.selId === id) state.selId = state.workers.length ? state.workers[0].id : '';
        loadSelected();
        recalcPayroll();
        renderRoster();
        return;
      }
      var pick = ev.target.closest('[data-pick-worker]') || ev.target.closest('tr[data-wid]');
      if (!pick) return;
      var wid = pick.getAttribute('data-pick-worker') || pick.getAttribute('data-wid');
      selectWorker(wid);
      var w = selWorker();
      if (w) showToast(tr('👤 {n}님 {m}월 ', { n: w.name, m: state.calendar.month }) + (w.months[$('pMonth').value] ? tr('기록을 불러왔습니다') : tr('— 아직 기록이 없어 비어 있습니다')));
    }
    $('rosterBody').addEventListener('click', onRosterClick);
    $('rosterCards').addEventListener('click', onRosterClick);

    function allRecordInputs(ids) {
      var list = [];
      state.workers.forEach(function (w) {
        if (ids && ids.indexOf(w.id) < 0) return;
        Object.keys(w.months).sort().forEach(function (pm) { list.push(E.workerPayrollInput(w, pm)); });
      });
      return list;
    }

    function downloadRosterXlsx(ids, personal) {
      var inputs = allRecordInputs(ids);
      if (!inputs.length) {
        showToast(tr('저장된 근무 기록이 없습니다. 알바생을 추가하고 근무 시간을 입력해 주세요.'));
        return;
      }
      var results = inputs.map(function (inp) { return E.calculatePayroll(inp); });
      if (personal) {
        var fn = E.personalFileName(results);
        triggerBlobDownload(E.payrollPersonalXlsx(results), fn);
        showToast(tr('📊 엑셀(.xlsx) 다운로드 완료: {f}', { f: fn }));
        return;
      }
      var names = {};
      results.forEach(function (r) { names[r.name] = 1; });
      var nameList = Object.keys(names);
      var fname = nameList.length === 1
        ? tr('알바_정산_') + nameList[0].replace(/[\\/:*?"<>|]/g, '') + '.xlsx'
        : E.rosterFileName(results);
      downloadXlsx('./api/payroll/excel', { roster: inputs }, function () { return E.payrollRosterXlsx(results); }, fname);
    }

    // 엑셀로 받을 사람 고르기 (한 명뿐이면 바로 받음)
    function openExportPicker() {
      var withRec = state.workers.filter(function (w) { return Object.keys(w.months).length; });
      if (!withRec.length) { downloadRosterXlsx(null); return; }
      $('exportList').innerHTML = state.workers.map(function (w) {
        var n = Object.keys(w.months).length;
        return '<label class="export-row' + (n ? '' : ' off') + '"><input type="checkbox" value="' + escHtml(w.id) + '"' + (n ? ' checked' : ' disabled') + '>' +
          '<span class="export-name">' + escHtml(w.name) + '</span><small>' + (n ? tr('{n}개월 기록', { n: n }) : tr('기록 없음')) + '</small></label>';
      }).join('');
      document.body.classList.remove('set-open', 'add-open', 'slip-open');
      $('exportAllToggle').textContent = tr('전체 해제');
      document.body.classList.add('export-open');
      $('sheetBackdrop').hidden = false;
    }
    $('btnRosterXlsx').addEventListener('click', openExportPicker);
    $('exportClose').addEventListener('click', closeSheets);
    $('exportAllToggle').addEventListener('click', function () {
      var boxes = $('exportList').querySelectorAll('input:not(:disabled)');
      var all = Array.prototype.every.call(boxes, function (b) { return b.checked; });
      boxes.forEach(function (b) { b.checked = !all; });
      $('exportAllToggle').textContent = all ? tr('전체 선택') : tr('전체 해제');
    });
    $('exportGo').addEventListener('click', function () {
      var ids = Array.prototype.map.call($('exportList').querySelectorAll('input:checked'), function (b) { return b.value; });
      if (!ids.length) { showToast(tr('엑셀로 받을 알바생을 한 명 이상 체크해 주세요.')); return; }
      closeSheets();
      downloadRosterXlsx(ids, $('exportPersonal').checked);
    });


    $('btnRosterClear').addEventListener('click', function () {
      if (!state.workers.length) return;
      if (!window.confirm(tr('알바생 {n}명과 모든 월 기록을 지울까요?\n(지우면 되돌릴 수 없습니다. 먼저 백업 파일을 받아 두면 안전합니다)', { n: state.workers.length }))) return;
      state.workers = [];
      state.selId = '';
      saveWorkers();
      purgePunchRows(null);
      loadSelected();
      recalcPayroll();
      renderRoster();
      showToast(tr('알바생 명단을 비웠습니다.'));
    });

    // 체크리스트 실시간 반응
    ['cStore', 'cDate', 'cInspector', 'cFridge', 'cFreezer', 'cMemo'].forEach(function (id) {
      $(id).addEventListener('input', recalcChecklist);
    });
    $('chkFormList').addEventListener('change', recalcChecklist);
    $('btnCheckAll').addEventListener('click', function () { setAllChecks(true); });
    $('btnCheckNone').addEventListener('click', function () { setAllChecks(false); });

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
      showToast(tr('🗂️ 점검 보관함에 {d} 점검표 저장 ({v})', { d: c.date || tr('오늘'), v: c.verdict }));
    });

    $('archiveBody').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-del-archive]');
      if (!btn) return;
      var idx = Number(btn.getAttribute('data-del-archive'));
      if (idx >= 0 && idx < state.archive.length) {
        if (!window.confirm(tr('이 점검 기록을 삭제할까요?'))) return;
        state.archive.splice(idx, 1);
        saveJson(KEYS.archive, state.archive);
        renderArchive();
      }
    });

    $('btnArchiveXlsx').addEventListener('click', function () {
      if (!state.archive.length) {
        showToast(tr('점검 보관함이 비어 있습니다. 먼저 보관함에 점검표를 저장해주세요.'));
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
      showToast(tr('점검 보관함을 비웠습니다.'));
    });
  }


  /* ==========================================================
     구글 시트 연동 (내 구글 드라이브에 자동 저장 / 다른 기기에서 불러오기)
     ========================================================== */
  function fmtClock(ms) {
    if (!ms) return '';
    var d = new Date(ms);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function cloudData() {
    return {
      workers: state.workers,
      archive: state.archive,
      presets: presetState.list,
      store: loadJson(KEYS.store, {}),
      settings: state.settings
    };
  }

  /* 구글 시트에 사람이 보기 좋게 적을 탭들: 월별(정산 요약 + 날짜별 근무 기록) / 알바생 / 점검 보관함 */
  function cloudTables() {
    var sheets = [];
    var DOW = ['월', '화', '수', '목', '금', '토', '일'];

    E.recordMonths(state.workers).forEach(function (pm) {
      var rs = [];
      state.workers.forEach(function (w) {
        if (w.months && w.months[pm]) rs.push(E.calculatePayroll(E.workerPayrollInput(w, pm)));
      });
      if (!rs.length) return;
      var sum = E.summarizePayrolls(rs);
      var rows = [[pm.slice(0, 4) + '년 ' + Number(pm.slice(5)) + '월 정산'],
        ['이름', '근무일수', '총 근무시간(h)', '시급(원)', '주휴수당(원)', '식대(원)', '세전 합계(원)', '공제(원)', '실수령액(원)']];
      rs.forEach(function (r) {
        rows.push([r.name, r.workDays, r.totalHours, r.hourlyWage, r.weeklyAllowance, r.mealAllowance, r.gross, r.tax.total, r.net]);
      });
      rows.push(['합계 (' + sum.count + '명)', rs.reduce(function (t, r) { return t + r.workDays; }, 0), sum.totalHours, '', sum.totalWeekly, sum.totalMeal, sum.totalGross, sum.totalTax, sum.totalNet]);
      rows.push([]);
      var logTitle = rows.length;
      rows.push(['날짜별 근무 기록']);
      var logHead = rows.length;
      rows.push(['날짜', '요일', '이름', '출근', '퇴근', '휴게(분)', '근무시간(h)', '식대']);
      rs.forEach(function (r) {
        r.days.forEach(function (d) {
          if (d.off) return;
          rows.push([pm + '-' + pad2(d.date), DOW[d.dayIndex], r.name, d.start, d.end, d.breakMinutes, d.hours, r.includeMeal && d.mealEligible ? mealWords(d.meals) : '']);
        });
      });
      sheets.push({ name: pm, rows: rows, bold: [0, 1, logTitle, logHead], sortKey: pm });
    });
    sheets.sort(function (x, y) { return x.sortKey < y.sortKey ? 1 : -1; });   // 최근 달이 앞에

    var wrows = [['이름', '고유코드', '비밀번호', '계약서상 주 근무일', '시급(원)', '기록이 있는 달']];
    state.workers.forEach(function (w) {
      wrows.push([w.name, w.code || '', w.password || '', '주 ' + w.contractDays + '일', w.wage, Object.keys(w.months).length + '개월']);
    });
    sheets.push({ name: '알바생', rows: wrows.length > 1 ? wrows : [['(등록된 알바생이 없습니다)']], bold: [0] });

    var archive = [['점검일자', '매장명', '점검자', '냉장(°C)', '냉동(°C)', '적합 항목', '결과', '점검필요 항목', '특이사항']];
    state.archive.forEach(function (inp) {
      var c = E.buildChecklist(inp);
      var fails = c.items.filter(function (it) { return !it.ok; }).map(function (it) { return it.no + '. ' + it.text; }).join('\n');
      archive.push([c.date || '-', c.store, c.inspector, c.fridgeTemp === null ? '' : c.fridgeTemp, c.freezerTemp === null ? '' : c.freezerTemp,
        c.passCount + ' / ' + c.total, c.verdict, fails || '-', c.memo || '-']);
    });
    sheets.push({ name: '점검 보관함', rows: archive.length > 1 ? archive : [['(저장된 점검 기록이 없습니다)']], bold: [0] });
    return { sheets: sheets };
  }

  function cloudApply(d) {
    d = d || {};
    syncSuspended = true;
    try {
      // 새 형식(workers) 또는 예전 형식(정산 명단 roster)을 받아 알바생별 기록으로 정리
      state.workers = Array.isArray(d.workers) ? E.normalizeWorkers(d.workers) : E.migrateRoster(d.roster);
      state.archive = Array.isArray(d.archive) ? d.archive : [];
      saveWorkers();
      saveJson(KEYS.archive, state.archive);
      if (Array.isArray(d.presets) && d.presets.length) {
        saveJson(KEYS.presets, d.presets);
        loadPresets();
        renderPresets();
      }
      if (d.store && typeof d.store === 'object') {
        saveJson(KEYS.store, d.store);
        if (d.store.store) $('cStore').value = d.store.store;
        if (d.store.inspector) $('cInspector').value = d.store.inspector;
      }
      if (d.settings) { state.settings = E.sanitizeSettings(d.settings); saveJson(KEYS.settings, state.settings); applySettings(); }
      if (!selWorker()) state.selId = state.workers.length ? state.workers[0].id : '';
      loadSelected();
      recalcPayroll();
      renderRoster();
      renderArchive();
      recalcChecklist();
    } finally {
      syncSuspended = false;
    }
  }

  var shownNotice = '';
  /* 출퇴근 화면(잠금 상태 포함)에 구글 저장 연결 상태 표시 */
  function renderPunchCloud(connected, kind, clock) {
    var el = $('punchCloud');
    if (!el) return;
    var cls = 'punch-cloud', txt;
    if (!connected) { cls += ' bad'; txt = tr('⚠️ 구글 로그인이 안 되어 있어요 · 지금은 이 기기에만 저장돼요. 사장님이 구글 연동을 해 주세요'); }
    else if (kind === 'needLogin' || kind === 'error') { cls += ' bad'; txt = tr('⚠️ 구글 로그인이 풀렸어요 · 사장님이 다시 연결해 주세요 (출퇴근은 이 기기에 저장돼요)'); }
    else if (kind === 'saving') { txt = tr('⏳ 구글 시트에 저장 중…'); }
    else { cls += ' ok'; txt = tr('✅ 구글 시트 연결됨') + (clock ? tr(' · 마지막 저장 {c}', { c: clock }) : ''); }
    el.className = cls;
    el.textContent = txt;
  }

  function renderCloudUi(st) {
    if (st && st.notice && st.notice !== shownNotice) { shownNotice = st.notice; showToast('🗑️ ' + st.notice); }
    var btn = $('cloudBtn');
    var body = $('cloudBody');
    if (!btn || !body) return;
    var connected = !!(st && st.connected);
    var kind = st ? st.kind : 'off';
    var clock = fmtClock(st && st.lastSaved);
    renderPunchCloud(connected, kind, clock);

    if (!connected && kind !== 'saving') { btn.textContent = tr('☁️ 구글 저장'); btn.className = 'cloud-btn'; }
    else if (kind === 'saving') { btn.textContent = tr('☁️ 저장 중…'); btn.className = 'cloud-btn'; }
    else if (kind === 'needLogin' || kind === 'error') { btn.textContent = tr('⚠️ 다시 연결'); btn.className = 'cloud-btn bad'; }
    else { btn.textContent = tr('☁️ 저장됨') + (clock ? ' ' + clock : ''); btn.className = 'cloud-btn ok'; }

    var html;
    if (!connected) {
      html =
        '<p class="cloud-lead">' + tr('알바생 근무 기록과 점검 기록을 <b>내 구글 드라이브</b>에 자동으로 저장합니다. 휴대폰을 바꾸거나 다른 컴퓨터에서 열어도 같은 기록을 볼 수 있어요.') + '</p>' +
        '<ul class="cloud-points">' +
        '<li>' + tr('내 구글 드라이브에 <b>"사장님 도우미 데이터"</b> 파일이 만들어집니다') + '</li>' +
        '<li>' + tr('이 앱이 만든 파일 외에는 볼 수 없습니다') + '</li>' +
        '<li>' + tr('저장된 내용은 개발자도 볼 수 없습니다') + '</li>' +
        '<li>' + tr('언제든 연동을 끊을 수 있습니다') + '</li>' +
        '</ul>' +
        '<button type="button" class="btn btn-primary cloud-big" data-cloud="connect"' + (kind === 'saving' ? ' disabled' : '') + '>' + tr('구글 계정으로 연동하기') + '</button>' +
        (kind === 'error' && st.text ? '<p class="cloud-warn">' + escHtml(st.text) + '</p>' : '');
    } else {
      var head, cls = 'ok';
      if (kind === 'saving') { head = '⏳ ' + escHtml(st.text || tr('저장 중…')); cls = ''; }
      else if (kind === 'needLogin') { head = tr('⚠️ 구글 연결을 다시 해 주세요'); cls = 'bad'; }
      else if (kind === 'error') { head = tr('⚠️ 저장하지 못했습니다'); cls = 'bad'; }
      else { head = tr('✅ 구글 시트에 자동 저장 중'); }
      html =
        '<p class="cloud-state ' + cls + '">' + head + '</p>' +
        '<p class="cloud-sub">' + (clock ? tr('마지막 저장 {c} · ', { c: clock }) : '') + tr('내용을 바꾸면 몇 초 뒤 자동으로 저장됩니다.') + '</p>' +
        '<p class="cloud-sub">' + tr('시트에는 달마다 탭이 만들어지고, 5년이 지난 달의 탭은 시트에서만 자동으로 정리됩니다. (이 기기의 기록은 지워지지 않습니다)') + '</p>' +
        (st.notice ? '<p class="cloud-warn">' + escHtml(st.notice) + '</p>' : '') +
        ((kind === 'needLogin' || kind === 'error') && st.text ? '<p class="cloud-warn">' + escHtml(st.text) + '</p>' : '') +
        '<div class="cloud-actions">' +
        ((kind === 'needLogin' || kind === 'error')
          ? '<button type="button" class="btn btn-primary" data-cloud="save">' + tr('다시 연결하고 저장하기') + '</button>'
          : '<button type="button" class="btn btn-primary" data-cloud="save">' + tr('지금 저장') + '</button>') +
        '<button type="button" class="btn" data-cloud="open">' + tr('📄 구글 시트 열어보기') + '</button>' +
        '<button type="button" class="btn" data-cloud="load">' + tr('⬇️ 시트에서 다시 불러오기') + '</button>' +
        '<button type="button" class="btn btn-ghost" data-cloud="off">' + tr('연동 끊기') + '</button>' +
        '</div>';
    }
    html +=
      '<div class="cloud-backup">' +
      '<h3 class="cloud-backup-title">' + tr('💾 백업 파일') + '</h3>' +
      '<p class="cloud-sub">' + tr('구글 계정을 바꾸거나 다른 기기로 옮길 때 쓰세요. 모든 기록이 파일 하나로 저장됩니다.') + '</p>' +
      '<div class="cloud-actions">' +
      '<button type="button" class="btn" data-cloud="backup-save">' + tr('⬇️ 백업 파일 내려받기') + '</button>' +
      '<button type="button" class="btn" data-cloud="backup-load">' + tr('⬆️ 백업 파일 불러오기') + '</button>' +
      '</div></div>';
    body.innerHTML = html;
  }

  function backupDownload() {
    var text = E.buildBackup(cloudData());
    var blob = new Blob([text], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = E.backupFileName();
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 200);
    showToast(tr('💾 백업 파일을 내려받았습니다 ({w}명 · 점검 {a}일)', { w: state.workers.length, a: state.archive.length }));
  }

  function backupRestore(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var r = E.parseBackup(String(reader.result || ''));
      if (!r.ok) { window.alert(r.error); return; }
      var msg = tr('백업 파일의 기록으로 바꿉니다.\n\n불러올 기록: 알바생 {a}명 · 점검 보관함 {b}일\n지금 화면의 기록: 알바생 {c}명 · 점검 보관함 {d}일 (사라집니다)\n\n계속할까요?',
        { a: r.counts.workers, b: r.counts.archive, c: state.workers.length, d: state.archive.length });
      if (!window.confirm(msg)) return;
      cloudApply(r.data);
      if (window.AlbaCloud) window.AlbaCloud.markDirty();
      showToast(tr('⬆️ 백업 파일을 불러왔습니다') + (r.counts.skipped ? tr(' (읽을 수 없는 {n}건 제외)', { n: r.counts.skipped }) : ''));
    };
    reader.onerror = function () { window.alert(tr('파일을 읽지 못했습니다.')); };
    reader.readAsText(file);
  }

  function initCloud() {
    var C = window.AlbaCloud;
    if (!C) { var b = $('cloudBtn'); if (b) b.hidden = true; return; }
    C.init({
      getData: cloudData,
      getTables: cloudTables,
      applyData: cloudApply,
      replayPunchLog: replayPunchLog,
      confirm: function (m) { return window.confirm(m); },
      getAdminPin: function () { return getPin(); },
      onStatus: function (st) { renderCloudUi(st); if (st && st.kind === 'saved') flushPunchQueue(); }
    });

    function openModal() { renderCloudUi(C.getStatus()); $('cloudModal').hidden = false; }
    function closeModal() { $('cloudModal').hidden = true; }
    $('cloudBtn').addEventListener('click', openModal);
    $('cloudClose').addEventListener('click', closeModal);
    $('cloudModal').addEventListener('click', function (ev) { if (ev.target === $('cloudModal')) closeModal(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeModal(); });

    $('cloudBody').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-cloud]');
      if (!b) return;
      var act = b.getAttribute('data-cloud');
      if (act === 'backup-save') { backupDownload(); return; }
      if (act === 'backup-load') { $('backupFile').click(); return; }
      if (act === 'connect') {
        C.connect().then(function (ok) { if (ok) { showToast(tr('☁️ 구글 시트 연동 완료')); adoptSheetPin(); } });
      } else if (act === 'save') {
        C.saveNow().then(function (ok) { if (ok) showToast(tr('☁️ 구글 시트에 저장했습니다')); });
      } else if (act === 'open') {
        var u = C.sheetUrl();
        if (u) window.open(u, '_blank', 'noopener');
      } else if (act === 'load') {
        if (!window.confirm(tr('구글 시트에 저장된 내용으로 이 화면의 기록을 바꿉니다.\n계속할까요?'))) return;
        C.loadFromSheet().then(function (r) {
          if (r === 'ok') adoptSheetPin();
          showToast(r === 'ok' ? tr('⬇️ 구글 시트에서 불러왔습니다') : (r === 'empty' ? tr('시트에 저장된 기록이 없습니다') : tr('불러오지 못했습니다')));
        });
      } else if (act === 'off') {
        if (!window.confirm(tr('구글 연동을 끊을까요?\n이 기기의 기록과 구글 드라이브의 파일은 그대로 남습니다.'))) return;
        C.disconnect();
        showToast(tr('구글 연동을 끊었습니다'));
      }
    });
    $('backupFile').addEventListener('change', function (ev) {
      backupRestore(ev.target.files && ev.target.files[0]);
      ev.target.value = '';
    });
    renderCloudUi(C.getStatus());
  }


  /* ==========================================================
     출퇴근 (매장 기기에서 알바생이 이름 → 비밀번호) + 관리자 잠금
     ========================================================== */
  var PIN_KEY = 'alba.adminPin';          // 이 기기에만 저장 (구글 저장·백업에는 넣지 않음)
  var QUEUE_KEY = 'alba.punchQueue';      // 구글 시트 '출퇴근기록' 탭에 아직 못 올린 기록
  var IDLE_LOCK_MS = 10 * 60 * 1000;
  var RESULT_MS = 5000;
  var punchState = { unlocked: false, target: null, fails: 0, lockUntil: 0, resultTimer: null, idleTimer: null };

  function getPin() { try { return localStorage.getItem(PIN_KEY) || ''; } catch (e) { return ''; } }
  function isLocked() { return !!getPin() && !punchState.unlocked; }
  /* 새로고침해도 관리자 잠금 해제를 유지: 같은 탭에서 마지막 사용 후 10분 안이면 그대로 (탭을 닫으면 사라짐) */
  var UNLOCK_KEY = 'alba.unlockAt';
  function markUnlocked(on) { try { if (on) sessionStorage.setItem(UNLOCK_KEY, String(Date.now())); else sessionStorage.removeItem(UNLOCK_KEY); } catch (e) {} }
  function restoreUnlock() {
    try {
      var t = Number(sessionStorage.getItem(UNLOCK_KEY) || 0);
      if (getPin() && t && Date.now() - t < IDLE_LOCK_MS) punchState.unlocked = true;
    } catch (e) {}
  }

  function openTab(name) {
    var b = document.querySelector('.tabs .tab[data-tab="' + name + '"]');
    if (b) b.click();
  }

  function applyLockUi() {
    var pin = getPin();
    var locked = isLocked();
    document.body.classList.toggle('locked', locked);
    $('lockBtn').hidden = !pin;
    $('lockBtn').textContent = locked ? tr('🔒 관리자') : tr('🔓 잠그기');
    $('pinState').textContent = pin ? tr('· 설정됨') : tr('· 아직 없음');
    if (locked) openTab('punch');
  }

  function lockNow() {
    if (!getPin()) return;
    punchState.unlocked = false;
    markUnlocked(false);
    if (punchState.idleTimer) { clearTimeout(punchState.idleTimer); punchState.idleTimer = null; }
    document.body.classList.remove('set-open', 'add-open', 'slip-open', 'export-open', 'modal-open');
    $('sheetBackdrop').hidden = true;
    $('dayModal').hidden = true;
    $('cloudModal').hidden = true;
    applyLockUi();
  }

  function bumpIdle() {
    if (punchState.unlocked) markUnlocked(true);
    if (punchState.idleTimer) clearTimeout(punchState.idleTimer);
    punchState.idleTimer = (getPin() && punchState.unlocked) ? setTimeout(lockNow, IDLE_LOCK_MS) : null;
  }

  function fmtHM(h) {
    var m = Math.round((Number(h) || 0) * 60);
    var hh = Math.floor(m / 60), mm = m % 60;
    return tr('{n}시간', { n: hh }) + (mm ? ' ' + tr('{n}분', { n: mm }) : '');
  }
  function tsOf(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function hmText(t) { var a = String(t).split(':'); return tr('{h}시 {m}분', { h: Number(a[0]), m: a[1] }); }

  /* ---------- 시트 '출퇴근기록' 탭에 한 줄씩 덧붙임 (연동 중일 때) ---------- */
  var queueBusy = false;
  function loadQueue() { var q = loadJson(QUEUE_KEY, []); return Array.isArray(q) ? q : []; }
  function enqueuePunch(row) {
    var q = loadQueue();
    q.push(row);
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-500))); } catch (e) {}
    flushPunchQueue();
  }
  function flushPunchQueue() {
    var C = window.AlbaCloud;
    if (queueBusy || !C || !C.isConnected() || !C.appendPunch) return;
    var q = loadQueue();
    if (!q.length) return;
    queueBusy = true;
    C.appendPunch(q).then(function () {
      var rest = loadQueue().slice(q.length);
      try { localStorage.setItem(QUEUE_KEY, JSON.stringify(rest)); } catch (e) {}
    }).catch(function () { /* 다음 저장 때 다시 시도 */ }).then(function () { queueBusy = false; });
  }

  /* 지운 알바생의 출퇴근 장부 줄도 지운다 (이 기기에 쌓인 대기분 + 구글 시트). codes가 null이면 전부 */
  function purgePunchRows(codes) {
    var q = loadQueue().filter(function (r) { return codes && codes.indexOf(String(r[1])) < 0; });
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
    var C = window.AlbaCloud;
    if (C && C.isConnected() && C.purgePunchLog) C.purgePunchLog(codes);
  }

  /* 시트 '출퇴근기록' 장부로 출근/퇴근 상태 복구 (다시 로그인·불러오기 뒤) */
  function replayPunchLog(rows, afterMs) {
    // 너무 오래된 줄은 건너뜀: 지운 기록의 옛 장부가 되살아나는 것을 막는다 (최근 48시간만)
    var n = E.replayPunchLog(state.workers, rows, Math.max(afterMs, Date.now() - 48 * 3600 * 1000), punchUnit());
    if (n) {
      saveWorkers();
      loadSelected(); recalcPayroll(); renderRoster();
      showToast(tr('출퇴근 기록 {n}건을 시트 기록에서 복구했습니다', { n: n }));
    }
  }

  /* 자정까지 퇴근을 안 찍은 사람은 그날 출근을 무효(휴무)로 처리 */
  function runAutoClose() {
    var done = E.autoCloseOpen(state.workers, new Date());
    if (!done.length) return;
    saveWorkers();
    loadSelected(); recalcPayroll(); renderRoster();
    done.forEach(function (d) {
      enqueuePunch([tsOf(d.ts), d.worker.code, d.worker.name, '퇴근누락(무효)', '자동(자정)', '정상(자동)', '자정까지 퇴근을 찍지 않아 그날 출근(' + d.date + ' ' + d.start + ')을 무효·휴무로 처리']);
    });
    showToast(tr('🌙 퇴근을 안 찍어 {n}님의 어제 출근은 무효(휴무) 처리했습니다', { n: done.map(function (d) { return d.worker.name; }).join(', ') }));
  }

  /* ---------- 화면 보호기 (번인 방지) ---------- */
  var EGG_TEXT = '진주 경상대점 맘스터치 매니저님 짱 ✨';   // 이스터에그 문구 (언어와 상관없이 그대로)
  var SAVER_KEY = 'alba.saverMin';
  var saverState = { last: Date.now(), on: false, moveTimer: null };
  function saverMinutes() {
    try { var v = localStorage.getItem(SAVER_KEY); if (v === null) return 3; v = Number(v); return v >= 0 && v <= 120 ? v : 3; } catch (e) { return 3; }
  }
  function saverMove() {
    var box = $('saverBox');
    var w = window.innerWidth, h = window.innerHeight;
    var bw = box.offsetWidth || 260, bh = box.offsetHeight || 110;
    box.style.left = Math.round(Math.random() * Math.max(0, w - bw - 20) + 10) + 'px';
    box.style.top = Math.round(Math.random() * Math.max(0, h - bh - 20) + 10) + 'px';
  }
  function saverTick() {
    var d = new Date();
    $('saverTime').textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var working = state.workers.filter(function (w) { return E.punchNext(w, d) === 'out'; }).length;
    $('saverSub').textContent = Math.random() < 0.15 ? EGG_TEXT   // 이스터에그: 가끔 한 번씩
      : (working ? tr('근무 중 {n}명 · ', { n: working }) : '') + tr('화면을 누르면 돌아가요');
  }
  function showSaver() {
    saverState.on = true;
    saverTick(); $('saver').hidden = false; saverMove();
    saverState.moveTimer = setInterval(function () { saverTick(); saverMove(); }, 20000);
  }
  function hideSaver() {
    saverState.on = false;
    if (saverState.moveTimer) { clearInterval(saverState.moveTimer); saverState.moveTimer = null; }
    $('saver').hidden = true;
  }
  function initSaver() {
    $('saverMin').value = String(saverMinutes());
    $('saverMin').addEventListener('change', function () {
      try { localStorage.setItem(SAVER_KEY, $('saverMin').value); } catch (e) {}
      saverState.last = Date.now();
    });
    function touch() { saverState.last = Date.now(); }
    ['pointerdown', 'keydown', 'touchstart', 'mousemove'].forEach(function (t) { document.addEventListener(t, function (ev) {
      if (saverState.on) { if (t !== 'mousemove') { ev.preventDefault(); ev.stopPropagation(); hideSaver(); touch(); } return; }   // 깨우는 첫 터치는 화면 버튼을 누르지 않게 막음
      touch();
    }, true); });
    setInterval(function () {
      var min = saverMinutes();
      var onPunch = $('tab-punch').classList.contains('active');
      if (saverState.on && (!min || !onPunch)) { hideSaver(); return; }
      if (!saverState.on && min && onPunch && Date.now() - saverState.last >= min * 60000) showSaver();
    }, 5000);
  }

  /* ---------- 출퇴근 화면 ---------- */
  function renderPunch() {
    var box = $('punchList');
    if (!box) return;
    var now = new Date();
    var allBtn = $('punchAllOut');
    if (allBtn) {
      var nOn = state.workers.filter(function (w) { return E.punchNext(w, now) === 'out'; }).length;
      allBtn.hidden = nOn < 1;
      allBtn.textContent = tr('🌙 근무 중인 {n}명 모두 퇴근', { n: nOn });
    }
    if (!state.workers.length) {
      box.innerHTML = '<p class="punch-empty">' + tr('등록된 알바생이 없습니다.<br>사장님께 알려 주세요.') + '</p>';
      return;
    }
    // 근무 중인 사람을 맨 위로 (출근한 순서대로), 나머지는 등록한 순서 그대로
    var order = state.workers.map(function (w, i) { return { w: w, i: i, on: E.punchNext(w, now) === 'out' }; });
    order.sort(function (a, b) {
      if (a.on !== b.on) return a.on ? -1 : 1;
      if (a.on) { var ka = a.w.punch.date + a.w.punch.at, kb = b.w.punch.date + b.w.punch.at; if (ka !== kb) return ka < kb ? -1 : 1; }
      return a.i - b.i;
    });
    box.innerHTML = order.map(function (o) {
      var w = o.w;
      var working = o.on;
      var chip = working
        ? '<span class="punch-chip on">' + tr('근무 중 · {t} 출근', { t: escHtml(w.punch.time) }) + '</span>'
        : '<span class="punch-chip">' + tr('퇴근 상태') + '</span>';
      return '<button type="button" class="punch-row' + (working ? ' on' : '') + '" data-punch="' + escHtml(w.id) + '">' +
        '<span class="punch-name">' + escHtml(w.name) + '</span>' + chip + '</button>';
    }).join('');
  }

  function tickClock() {
    var d = new Date();
    var el = $('punchTime');
    if (!el) return;
    el.textContent = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    var wd = E.dayName((d.getDay() + 6) % 7);
    $('punchDate').textContent = tr('{y}년 {m}월 {d}일 ({w})', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate(), w: wd });
  }

  function openPunchPw(w) {
    punchState.target = w;
    var next = E.punchNext(w, new Date());
    $('punchPwName').textContent = w.name;
    $('punchPwState').textContent = next === 'out'
      ? tr('지금 {t}에 출근해 있어요. 비밀번호를 입력하면 퇴근이 찍혀요.', { t: hmText(w.punch.time) })
      : tr('비밀번호를 입력하면 출근이 찍혀요.');
    $('punchPwOk').textContent = next === 'out' ? tr('퇴근 찍기') : tr('출근 찍기');
    var inp = $('punchPwInput');
    inp.value = '';
    inp.setAttribute('inputmode', /^\d+$/.test(w.password || '') ? 'numeric' : 'text');
    $('punchPwErr').textContent = '';
    $('punchPw').hidden = false;
    setTimeout(function () { inp.focus(); }, 50);
  }
  function closePunchPw() { $('punchPw').hidden = true; punchState.target = null; $('punchPwInput').value = ''; }

  function punchSubmit() {
    var w = punchState.target;
    if (!w) return;
    // 창이 열려 있는 사이 시트에서 불러오기가 일어나 사람 객체가 바뀌었을 수 있으니 같은 사람을 다시 찾는다
    w = state.workers.filter(function (x) { return x.id === w.id; })[0];
    if (!w) { closePunchPw(); renderPunch(); return; }
    punchState.target = w;
    var now = new Date();
    if (punchState.lockUntil > now.getTime()) {
      $('punchPwErr').textContent = tr('잠시 후에 다시 해 주세요. ({n}초)', { n: Math.ceil((punchState.lockUntil - now.getTime()) / 1000) });
      return;
    }
    var typed = $('punchPwInput').value.trim();
    if (!w.password) { $('punchPwErr').textContent = tr('이 알바생은 아직 비밀번호가 없어요. 사장님께 알려 주세요. (급여 계산 → 설정에서 정할 수 있어요)'); return; }
    if (!typed || typed !== w.password) {
      punchState.fails++;
      enqueuePunch([tsOf(now), w.code, w.name, '', '이름+비밀번호', '비밀번호 오류', punchState.fails + '번째 연속 실패']);
      if (punchState.fails >= 5) {
        punchState.lockUntil = now.getTime() + 30000;
        punchState.fails = 0;
        $('punchPwErr').textContent = tr('여러 번 틀렸어요. 30초 뒤에 다시 해 주세요.');
      } else {
        $('punchPwErr').textContent = tr('비밀번호가 맞지 않아요.');
      }
      $('punchPwInput').value = '';
      $('punchPwInput').focus();
      return;
    }
    punchState.fails = 0;
    runAutoClose();   // 어제 퇴근 안 찍은 사람이 있으면 먼저 자정 퇴근으로 정리
    var r = E.applyPunch(w, now, punchUnit());
    closePunchPw();
    if (r.kind === 'too_soon') { showToast(tr('방금 찍었어요. 잠시 뒤에 다시 눌러 주세요.')); return; }
    saveWorkers();
    // 열려 있던 급여 화면과 명단도 새 기록으로 맞춤
    if (w.id === state.selId) { loadSelected(); recalcPayroll(); }
    renderRoster();
    enqueuePunch([tsOf(now), w.code, w.name, r.kind === 'in' ? '출근' : '퇴근', '이름+비밀번호', r.note ? '정상(참고)' : '정상', r.note]);
    showPunchResult(w, r, now);
  }

  /* ---------- 출퇴근 알림음: 크기 · 소리 종류(출근/퇴근 따로) ---------- */
  var SND_KEY = 'alba.sound';
  var SOUNDS = {
    up:    { label: '차임 (올라가는 음)', n: [[660, 0, .3], [880, .22, .3], [1320, .44, .5]] },
    down:  { label: '차임 (내려가는 음)', n: [[1320, 0, .3], [880, .22, .3], [660, .44, .5]] },
    dingdong: { label: '딩동', n: [[784, 0, .35], [622, .32, .5]] },
    bell:  { label: '벨', n: [[1175, 0, .9, 'bell'], [1568, .12, .8, 'bell']] },
    beep:  { label: '삐빅 (또렷함)', n: [[1000, 0, .12, 'square'], [1000, .2, .12, 'square']] },
    triple:{ label: '삐삐삐 (아주 또렷함)', n: [[1200, 0, .1, 'square'], [1200, .16, .1, 'square'], [1200, .32, .1, 'square']] },
    fanfare: { label: '팡파르', n: [[523, 0, .16], [659, .14, .16], [784, .28, .16], [1047, .42, .4]] },
    soft:  { label: '부드러운 소리', n: [[440, 0, .6, 'triangle'], [554, .3, .7, 'triangle']] },
    none:  { label: '소리 없음', n: [] }
  };
  var SND_ORDER = ['up', 'down', 'dingdong', 'bell', 'beep', 'triple', 'fanfare', 'soft', 'none'];
  function loadSnd() {
    var d = { vol: 100, inId: 'up', outId: 'down' };
    try {
      var o = JSON.parse(localStorage.getItem(SND_KEY) || '{}');
      if (typeof o.vol === 'number' && o.vol >= 0 && o.vol <= 100) d.vol = o.vol;
      if (SOUNDS[o.inId]) d.inId = o.inId;
      if (SOUNDS[o.outId]) d.outId = o.outId;
    } catch (e) {}
    return d;
  }
  function saveSnd(d) { try { localStorage.setItem(SND_KEY, JSON.stringify(d)); } catch (e) {} }

  var audioCtx = null;
  function playSound(id, volPct) {
    try {
      var snd = SOUNDS[id];
      if (!snd || !snd.n.length || volPct <= 0) return;
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var master = audioCtx.createGain();
      master.gain.value = (volPct / 100) * 6;           // 100%는 원래 소리의 6배(업장용)
      var comp = audioCtx.createDynamicsCompressor();   // 크게 올려도 찢어지지 않게 제한기로 사용
      comp.threshold.value = -3; comp.knee.value = 0; comp.ratio.value = 20; comp.attack.value = 0.001; comp.release.value = 0.15;
      var post = audioCtx.createGain(); post.gain.value = 1.4;
      master.connect(comp); comp.connect(post); post.connect(audioCtx.destination);
      var t0 = audioCtx.currentTime + 0.02;
      snd.n.forEach(function (nt) {
        var type = nt[3] || 'sine';
        var peak = type === 'square' ? 0.8 : 1;
        var parts = type === 'bell' ? [[1, 1], [2.76, .35], [5.4, .15]] : [[1, 1]];
        parts.forEach(function (pt) {
          var o = audioCtx.createOscillator(), g = audioCtx.createGain();
          o.type = type === 'bell' ? 'sine' : type;
          o.frequency.value = nt[0] * pt[0];
          var t = t0 + nt[1], d = nt[2];
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(peak * pt[1], t + 0.015);
          g.gain.exponentialRampToValueAtTime(0.0001, t + d);
          o.connect(g); g.connect(master);
          o.start(t); o.stop(t + d + 0.05);
        });
      });
    } catch (e) { /* 소리를 못 내도 출퇴근 처리는 그대로 */ }
  }
  function playChime(isIn) {
    var c = loadSnd();
    playSound(isIn ? c.inId : c.outId, c.vol);
  }
  function initSoundSettings() {
    var c = loadSnd();
    var opts = SND_ORDER.map(function (k) { return '<option value="' + k + '">' + tr(SOUNDS[k].label) + '</option>'; }).join('');
    $('sndIn').innerHTML = opts; $('sndOut').innerHTML = opts;
    $('sndIn').value = c.inId; $('sndOut').value = c.outId; $('sndVol').value = c.vol;
    $('sndVolLabel').textContent = c.vol + '%';
    function cur() { return { vol: Number($('sndVol').value), inId: $('sndIn').value, outId: $('sndOut').value }; }
    $('sndVol').addEventListener('input', function () { $('sndVolLabel').textContent = $('sndVol').value + '%'; });
    $('sndVol').addEventListener('change', function () { saveSnd(cur()); playChime(true); });
    $('sndIn').addEventListener('change', function () { saveSnd(cur()); playChime(true); });
    $('sndOut').addEventListener('change', function () { saveSnd(cur()); playChime(false); });
    $('sndInTest').addEventListener('click', function () { playChime(true); });
    $('sndOutTest').addEventListener('click', function () { playChime(false); });
  }

  /* ---------- 근무 중인 사람 일괄 퇴근 (마감할 때) ---------- */
  function askBulkOut() {
    runAutoClose();
    var now = new Date();
    var on = state.workers.filter(function (w) { return E.punchNext(w, now) === 'out'; });
    if (!on.length) { showToast(tr('지금 근무 중인 사람이 없어요.')); renderPunch(); return; }
    var go = function () {
      var names = on.map(function (w) { return w.name; }).join(', ');
      if (!window.confirm(tr('근무 중인 {n}명({names})을 지금 한꺼번에 퇴근 처리할까요?\n퇴근 시각은 {t} 기준으로 {u} 기록돼요.', { n: on.length, names: names, t: hmText(pad2(now.getHours()) + ':' + pad2(now.getMinutes())), u: punchUnit() === 1 ? tr('그대로') : tr('{n}분 단위로 내려서', { n: punchUnit() }) }))) return;
      doBulkOut();
    };
    if (getPin()) { punchState.afterPin = go; openAdminPin(); }   // 관리자 비밀번호가 있으면 사장님만
    else go();
  }
  function doBulkOut() {
    var now = new Date();
    var done = E.applyPunchAll(state.workers, now, punchUnit());
    if (!done.length) { showToast(tr('지금 근무 중인 사람이 없어요.')); renderPunch(); return; }
    saveWorkers();
    loadSelected(); recalcPayroll(); renderRoster();
    done.forEach(function (d) {
      enqueuePunch([tsOf(now), d.worker.code, d.worker.name, '퇴근', '일괄 퇴근(관리자)', d.result.note ? '정상(참고)' : '정상', d.result.note]);
    });
    playChime(false);
    $('punchResIcon').textContent = '🌙';
    $('punchResTitle').textContent = tr('{n}명 퇴근했어요. 수고하셨어요!', { n: done.length });
    $('punchResWho').textContent = done.map(function (d) { return d.worker.name; }).join(', ');
    $('punchResStats').innerHTML = done.map(function (d) {
      var r = d.result, w = d.worker;
      var sh = r.empty ? null : E.workerShifts(w, r.date.slice(0, 7))[Number(r.date.slice(8)) - 1];
      var hrs = sh && !sh.off ? fmtHM(E.calcShiftHours(sh.start, sh.end, sh.breakMinutes)) : fmtHM(0);
      return '<div>' + escHtml(w.name) + ' · ' + (r.empty ? tr('근무 0시간') : escHtml(r.start + '~' + r.end) + ' (' + hrs + ')') + '</div>';
    }).join('');
    var bar = $('punchTimerBar');
    bar.style.animation = 'none'; void bar.offsetWidth;
    bar.style.animation = 'punchTimer ' + (RESULT_MS / 1000) + 's linear forwards';
    $('punchResult').hidden = false;
    if (punchState.resultTimer) clearTimeout(punchState.resultTimer);
    punchState.resultTimer = setTimeout(closePunchResult, RESULT_MS);
  }

  function showPunchResult(w, r, now) {
    if (r.kind === 'in' || r.kind === 'out') playChime(r.kind === 'in');
    var pm = r.date.slice(0, 7);
    var sum = E.monthSummary(w, pm);
    var isIn = r.kind === 'in';
    $('punchResIcon').textContent = isIn ? '☀️' : '🌙';
    $('punchResTitle').textContent = isIn ? tr('출근했어요') : tr('퇴근했어요. 수고하셨어요!');
    $('punchResWho').textContent = tr('{n}님 · {t}', { n: w.name, t: hmText(isIn ? r.start : r.end) });
    var lines = [];
    if (!isIn) {
      var sh = r.empty ? null : E.workerShifts(w, pm)[Number(r.date.slice(8)) - 1];
      if (sh && !sh.off) lines.push('<div>' + tr('오늘 <b>{h}</b> 일했어요 ({s}~{e})', { h: fmtHM(E.calcShiftHours(sh.start, sh.end, sh.breakMinutes)), s: sh.start, e: sh.end }) + '</div>');
    }
    lines.push('<div>' + tr('이번 달 <b>{d}일</b> · 누적 <b>{h}</b>', { d: sum.workDays, h: fmtHM(sum.totalHours) }) + '</div>');
    if (isIn) lines.push('<small>' + tr('오늘 근무는 퇴근을 찍으면 더해져요') + '</small>');
    if (r.note) lines.push('<small>' + escHtml(r.note) + '</small>');
    $('punchResStats').innerHTML = lines.join('');
    var bar = $('punchTimerBar');
    bar.style.animation = 'none'; void bar.offsetWidth;
    bar.style.animation = 'punchTimer ' + (RESULT_MS / 1000) + 's linear forwards';
    $('punchResult').hidden = false;
    if (punchState.resultTimer) clearTimeout(punchState.resultTimer);
    punchState.resultTimer = setTimeout(closePunchResult, RESULT_MS);
  }
  function closePunchResult() {
    if (punchState.resultTimer) { clearTimeout(punchState.resultTimer); punchState.resultTimer = null; }
    $('punchResult').hidden = true;
  }

  /* ---------- 관리자 비밀번호 ---------- */
  function openAdminPin() {
    $('adminPinInput').value = '';
    $('adminPinErr').textContent = '';
    $('adminPin').hidden = false;
    setTimeout(function () { $('adminPinInput').focus(); }, 50);
  }
  function closeAdminPin() { $('adminPin').hidden = true; $('adminPinInput').value = ''; punchState.afterPin = null; }

  var PIN_ASKED_KEY = 'alba.pinAsked';
  function commitPin(v) {
    var wasSet = !!getPin();
    try { localStorage.setItem(PIN_KEY, v); } catch (e) { showToast(tr('이 기기에 저장하지 못했습니다.')); return; }
    try { localStorage.setItem(PIN_ASKED_KEY, '1'); } catch (e) {}
    var C = window.AlbaCloud;
    if (C) C.setAdminPin(v);
    var hint = (C && C.isConnected()) ? '' : tr(' 구글 저장을 켜 두면 잊어도 시트에서 다시 정할 수 있어요.');
    if (wasSet) { applyLockUi(); bumpIdle(); showToast(tr('관리자 비밀번호를 바꿨어요.') + hint); }
    else { lockNow(); showToast(tr('관리자 비밀번호를 정했어요. 지금부터 잠깁니다.') + hint); }
  }
  function maybeAskPin() {
    var asked = false;
    try { asked = !!localStorage.getItem(PIN_ASKED_KEY); } catch (e) {}
    if (getPin() || asked || !state.workers.length) return;
    $('pinSetupErr').textContent = '';
    $('pinSetup').hidden = false;
  }
  function adoptSheetPin() {
    var C = window.AlbaCloud;
    if (getPin() || !C || !C.isConnected()) return;
    C.readAdminPin('silent').then(function (v) {
      v = String(v || '').trim();
      if (v.length < 4 || getPin()) return;
      try { localStorage.setItem(PIN_KEY, v); localStorage.setItem(PIN_ASKED_KEY, '1'); } catch (e) { return; }
      lockNow();
      showToast(tr('구글 시트의 관리자 비밀번호가 적용되어 잠겼어요.'));
    }).catch(function () {});
  }

  function initPunch() {
    initSoundSettings();
    initSaver();
    runAutoClose();
    tickClock();
    setInterval(function () { tickClock(); runAutoClose(); renderPunch(); renderChips(); renderWorkNow(); }, 15000);

    $('punchList').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-punch]');
      if (!b) return;
      var w = state.workers.filter(function (x) { return x.id === b.getAttribute('data-punch'); })[0];
      if (!w) return;
      if (!w.password) { showToast(tr('{n}님은 아직 출퇴근 비밀번호가 없어요. 사장님께 정해 달라고 하세요.', { n: w.name })); return; }
      openPunchPw(w);
    });
    $('punchAllOut').addEventListener('click', askBulkOut);
    $('punchPwForm').addEventListener('submit', function (ev) { ev.preventDefault(); punchSubmit(); });
    $('punchPw').addEventListener('click', function (ev) { if (ev.target.closest('[data-punch-close]')) closePunchPw(); });
    $('punchResult').addEventListener('click', function (ev) { if (ev.target.closest('[data-punch-result-close]')) closePunchResult(); });

    $('lockBtn').addEventListener('click', function () {
      if (isLocked()) openAdminPin(); else lockNow();
    });
    $('adminPin').addEventListener('click', function (ev) { if (ev.target.closest('[data-admin-close]')) closeAdminPin(); });
    $('adminPinForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      if ($('adminPinInput').value === getPin() && punchState.afterPin) {   // 일괄 퇴근 등: 비밀번호만 확인하고 잠금은 그대로
        var fn = punchState.afterPin;
        closeAdminPin();
        fn();
        return;
      }
      if ($('adminPinInput').value === getPin()) {
        punchState.unlocked = true;
        closeAdminPin();
        applyLockUi();
        openTab('payroll');
        bumpIdle();
      } else {
        $('adminPinErr').textContent = tr('비밀번호가 맞지 않아요.');
        $('adminPinInput').value = '';
        $('adminPinInput').focus();
      }
    });
    ['pointerdown', 'keydown'].forEach(function (t) { document.addEventListener(t, bumpIdle, true); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (!$('punchPw').hidden) closePunchPw();
      if (!$('punchResult').hidden) closePunchResult();
      if (!$('adminPin').hidden) closeAdminPin();
      if (!$('pinSetup').hidden) { $('pinSetup').hidden = true; try { localStorage.setItem(PIN_ASKED_KEY, '1'); } catch (e2) {} }
    });

    $('btnPinSave').addEventListener('click', function () {
      var v = $('sAdminPin').value.trim();
      if (v.length < 4) { showToast(tr('관리자 비밀번호는 4자 이상으로 정해 주세요.')); return; }
      var msg = getPin()
        ? tr('관리자 비밀번호를 바꿉니다. 계속할까요?')
        : tr('정하면 지금 바로 잠기고, 출퇴근 화면만 보이게 됩니다.\n다시 열 때는 위의 [🔒 관리자]를 눌러 이 비밀번호를 입력하세요.\n\n계속할까요?');
      if (!window.confirm(msg)) return;
      $('sAdminPin').value = '';
      commitPin(v);
    });
    $('btnPinClear').addEventListener('click', function () {
      if (!getPin()) { showToast(tr('정해 둔 관리자 비밀번호가 없어요.')); return; }
      if (!window.confirm(tr('관리자 비밀번호를 없앨까요?\n없애면 누구나 급여 화면을 볼 수 있어요.'))) return;
      try { localStorage.removeItem(PIN_KEY); } catch (e) {}
      if (window.AlbaCloud) window.AlbaCloud.setAdminPin('');
      applyLockUi();
      bumpIdle();
      showToast(tr('관리자 비밀번호를 없앴어요.'));
    });

    // 처음 안내 창
    $('pinSetupForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var v = $('pinSetupInput').value.trim();
      if (v.length < 4) { $('pinSetupErr').textContent = tr('4자 이상으로 정해 주세요.'); return; }
      $('pinSetup').hidden = true;
      $('pinSetupInput').value = '';
      commitPin(v);
    });
    $('pinSetup').addEventListener('click', function (ev) {
      if (!ev.target.closest('[data-pinsetup-close]')) return;
      $('pinSetup').hidden = true;
      try { localStorage.setItem(PIN_ASKED_KEY, '1'); } catch (e) {}   // 한 번만 물어봄. 필요하면 설정에서 정함
    });

    // 비밀번호를 잊었을 때: 사장님이 구글 시트 '관리자' 탭에서 고친 값을 다시 불러옴 (화면에 비밀번호를 보여주지는 않음)
    $('adminPinForgot').addEventListener('click', function () {
      var C = window.AlbaCloud, err = $('adminPinErr');
      if (!C || !C.isConnected()) {
        err.textContent = tr('구글 저장이 연결되어 있지 않아 시트에서 복구할 수 없어요.');
        return;
      }
      err.textContent = tr('시트에서 확인하는 중…');
      C.readAdminPin('user').then(function (v) {
        v = String(v || '').trim();
        if (v.length < 4) { err.textContent = tr('구글 시트의 "관리자" 탭 B1 칸에 새 비밀번호(4자 이상)를 적은 뒤 다시 눌러 주세요.'); return; }
        if (v === getPin()) { err.textContent = tr('시트의 비밀번호가 지금 앱의 비밀번호와 같아요. 시트 "관리자" 탭에서 확인하거나 새 값으로 고친 뒤 다시 눌러 주세요.'); return; }
        try { localStorage.setItem(PIN_KEY, v); } catch (e) {}
        $('adminPinInput').value = '';
        err.textContent = tr('시트에 적힌 비밀번호로 바꿨어요. 그 비밀번호를 입력하세요.');
      }).catch(function () {
        err.textContent = tr('시트를 읽지 못했어요. 인터넷과 구글 로그인을 확인해 주세요. (시트에 "관리자" 탭이 없으면 앱에서 비밀번호를 다시 정해야 해요)');
      });
    });

    // 처음 열었을 때: 알바생이 있고 아직 비밀번호가 없으면 한 번 안내 (나중에 → 설정에서)
    setTimeout(maybeAskPin, 800);
    // 저장소를 지운 새 기기에서 구글을 다시 연결하면 시트의 비밀번호로 복구
    setTimeout(adoptSheetPin, 5000);

    restoreUnlock();
    applyLockUi();
    bumpIdle();
    renderPunch();
    setTimeout(flushPunchQueue, 4000);
  }

  // 버전 표시 (엔진 빌드가 package.json 버전을 넣어 줌)
  if (window.ALBA_VERSION) Array.prototype.forEach.call(document.querySelectorAll('.ver-text'), function (el) { el.textContent = 'v' + window.ALBA_VERSION; });
  /* 언어를 바꾸면 앱이 만든 화면 조각을 새 언어로 다시 그림 (입력값은 그대로) */
  window.addEventListener('alba:lang', function () {
    var checked = Array.prototype.map.call(document.querySelectorAll('#chkFormList input:checked'), function (el) { return el.value; });
    buildChecklistForm();
    checked.forEach(function (v) { var el = document.querySelector('#chkFormList input[value="' + v + '"]'); if (el) el.checked = true; });
    var si = $('sndIn'), so = $('sndOut');
    if (si && so) {
      var iv = si.value, ov = so.value;
      var opts = SND_ORDER.map(function (k) { return '<option value="' + k + '">' + tr(SOUNDS[k].label) + '</option>'; }).join('');
      si.innerHTML = opts; so.innerHTML = opts; si.value = iv; so.value = ov;
    }
    syncThemeBtn(); syncFontBtn(); checkServerHealth();
    renderPresets(); renderTimeEditor();
    recalcPayroll(); recalcChecklist(); renderRoster(); renderArchive();
    renderPunch(); tickClock();
    if (window.AlbaCloud && window.AlbaCloud.getStatus) renderCloudUi(window.AlbaCloud.getStatus());
  });

  /* 이스터에그: 앱 제목을 빠르게 7번 누르면 팝업 */
  (function () {
    var h1 = document.querySelector('.brand h1'), n = 0, last = 0;
    if (!h1) return;
    h1.addEventListener('click', function () {
      var now = Date.now();
      n = now - last < 1200 ? n + 1 : 1; last = now;
      if (n < 7) return;
      n = 0;
      var old = document.getElementById('eggPop'); if (old) old.remove();
      var d = document.createElement('div');
      d.id = 'eggPop'; d.className = 'egg-pop'; d.setAttribute('data-no-i18n', '');
      d.innerHTML = '<div class="egg-box"><div class="egg-emoji">🍔</div><div class="egg-text">' + EGG_TEXT.replace(' ✨', '') + '</div><div class="egg-sub">👍 ✨</div></div>';
      d.addEventListener('click', function () { d.remove(); });
      document.body.appendChild(d);
      setTimeout(function () { if (d.parentNode) d.remove(); }, 3500);
    });
  })();

  syncThemeBtn();
  syncFontBtn();
  initTabs();
  initTimePickerChips();
  buildChecklistForm();
  initDefaults();
  bindEvents();
  applySettings();
  recalcPayroll();
  recalcChecklist();
  renderRoster();
  renderArchive();
  checkServerHealth();
  initCloud();
  initPunch();
  if (window.AlbaCloud) window.AlbaCloud.resume();
})();
