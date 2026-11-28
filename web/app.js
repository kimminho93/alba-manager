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
    presets: 'alba.timePresets.v1',
    conflicts: 'alba.conflicts.v1'   // 다른 기기와 같은 칸을 동시에 고친 기록 (모든 기기에 공유, 사장님이 고르면 지움)
  };

  var SYNC_KEYS = {};
  SYNC_KEYS[KEYS.settings] = SYNC_KEYS[KEYS.workers] = SYNC_KEYS[KEYS.archive] = SYNC_KEYS[KEYS.store] = SYNC_KEYS[KEYS.presets] = SYNC_KEYS[KEYS.conflicts] = true;

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
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* 사람이 적은 이름·매장명: 영어 모드에서 사전 단어로 바뀌지 않게 감쌈 */
  function escName(s) { return '<span data-no-i18n>' + escHtml(s) + '</span>'; }

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
  var storageWarnAt = 0;
  function storageFull() {   // 기기 저장 공간이 꽉 차 저장에 실패함 → 1분에 한 번 빨간 알림
    if (Date.now() - storageWarnAt < 60000) return;
    storageWarnAt = Date.now();
    showToast(tr('⚠️ 기기 저장 공간이 부족해 저장하지 못했어요. 지난 점검 보관함을 정리하거나 사장님께 알려 주세요.'), true);
  }
  function saveJson(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { storageFull(); }
    if (!syncSuspended && SYNC_KEYS[key] && window.AlbaCloud) window.AlbaCloud.markDirty();
  }

  var toastTimer = null;
  function showToast(msg, isError) {
    var el = $('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('error', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, isError ? 5000 : 2400);
  }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fmtTime(h, m) { return pad2(h) + ':' + pad2(m); }

  function parseHM(str, defH, defM) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(str || '').trim());
    if (!m) return { h: defH, m: defM };
    return { h: parseInt(m[1], 10), m: parseInt(m[2], 10) };
  }

  /* ---------- 테마 & 서버 연결 상태 배지 ---------- */
  var THEME_ICON = {
    moon: '<svg class="hdr-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>',
    sun: '<svg class="hdr-ico" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  };
  function syncThemeBtn() {
    var cur = document.documentElement.getAttribute('data-theme') || 'light';
    var btn = $('themeToggle');
    if (btn) {
      // 이모지 대신 선 아이콘: 다크면 해(라이트로), 라이트면 달(다크로)
      btn.innerHTML = cur === 'dark' ? THEME_ICON.sun : THEME_ICON.moon;
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
        // 사용 방법은 설정 안으로 옮겼으므로, 사용 방법이 열려 있을 때는 [설정] 메뉴를 켜진 것처럼 보인다(표시만)
        if (target === 'guide') { var st = document.querySelector('.tabs .tab[data-tab="settings"]'); if (st) st.classList.add('active'); }
        document.body.classList.toggle('on-punch', target === 'punch');
        document.body.classList.toggle('on-payroll', target === 'payroll');
        document.querySelectorAll('.tab-panel').forEach(function (panel) {
          panel.classList.toggle('active', panel.id === 'tab-' + target);
        });
        var hb = $('helpBtn');
        if (hb) hb.classList.toggle('active', target === 'guide');
        if (target === 'settings' && typeof renderSetSummaries === 'function') renderSetSummaries();
        window.scrollTo(0, 0);
      });
    });
    var help = $('helpBtn');
    if (help) help.addEventListener('click', function () { openTab('guide'); });
    var sg = $('btnSetGuide');
    if (sg) sg.addEventListener('click', function () { openTab('guide'); });
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
          showToast(tr('엑셀(.xlsx) 다운로드 완료: {f}', { f: filename }));
        })
        .catch(function () {
          setModeBadge(false);
          var bytes = localBuilder();
          triggerBlobDownload(bytes, filename);
          showToast(tr('엑셀(.xlsx) 다운로드 완료: {f}', { f: filename }));
        });
    } else {
      var bytes = localBuilder();
      triggerBlobDownload(bytes, filename);
      showToast(tr('엑셀(.xlsx) 다운로드 완료: {f}', { f: filename }));
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
    html += '<button type="button" class="chip preset-chip chip-off" data-off="true">휴무</button>';
    box.innerHTML = html;

    var full = presetState.list.length >= PRESET_MAX;
    $('presetCount').textContent = presetState.list.length + '/' + PRESET_MAX;
    $('presetAddBtn').disabled = full;
    $('presetAddBtn').title = full ? tr('최대 {n}개까지 만들 수 있어요', { n: PRESET_MAX }) : tr('시간대 추가 (최대 {n}개)', { n: PRESET_MAX });
    $('presetEditToggle').classList.toggle('active', presetState.editMode);
    $('presetEditToggle').textContent = presetState.editMode ? tr('✔ 편집 완료') : tr('편집');
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
        showToast(tr('선택된 날짜를 휴무로 설정했습니다.'));
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
        showToast(tr('시간대를 수정했습니다.'));
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
    var mealTag = showMeal && (ml.lunch || ml.dinner) ? ' · ' + tr('{w} 식대', { w: mealWords(ml) }) : '';
    $('mealPick').hidden = !showMeal;
    $('mealLunch').checked = ml.lunch;
    $('mealDinner').checked = ml.dinner;
    $('mealPickNote').textContent = ml.manual ? tr('직접 고침') : tr('자동');
    $('editorCalcPill').innerHTML = sh.off
      ? '<b>' + tr('휴무 (0시간)') + '</b>'
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
  /* 주차 줄 상태. mark = "주휴 O/X" 짧은 표시, note = 이유(짧게), money = 주휴 금액(줄 돈 보기일 때만 보임), btn = 주휴 예외 버튼(2-9).
     text는 예전 한 줄 문구(다른 곳에서 쓰지 않지만 호환용으로 남김) */
  function weekStatus(w, r, idx) {
    if (!r.includeWeekly) return { text: tr('주휴 미포함'), mark: tr('주휴 미포함'), note: '', money: '', btn: '', cls: '' };
    var days = (w.workDays !== null && w.workDays !== undefined) ? tr('{a}/{b}일 출근', { a: w.workDays, b: w.contractDays }) : '';
    var money = '+' + E.moneyText(w.allowance);
    if (w.eligible && !w.excused) {
      return { text: tr('주휴 +{a}', { a: E.moneyText(w.allowance) }) + (days ? tr(' · 개근 ') + days : ''), mark: tr('주휴 O'), note: '', money: money, btn: '', cls: 'ok' };
    }
    if (w.excused) {
      return {
        text: tr('주휴 +{a}', { a: E.moneyText(w.allowance) }) + tr(' (결근 있으나 지급)'),
        mark: tr('주휴 O'), note: tr('결근 있으나 지급'), money: money,
        btn: '<button type="button" class="btn btn-xs wk-excuse-btn" data-week-excuse="' + idx + '">' + tr('다시 제외하기') + '</button>',
        cls: 'ok'
      };
    }
    if (!w.hoursOk) return { text: tr('주휴 없음 (15시간 미만)'), mark: tr('주휴 X'), note: tr('15시간 미만'), money: '', btn: '', cls: '' };
    return {
      text: tr('주휴 없음 · ') + (days || tr('결근')),
      mark: tr('주휴 X'), note: days || tr('결근'), money: '',
      btn: '<button type="button" class="btn btn-xs wk-excuse-btn" data-week-excuse="' + idx + '" title="' + tr('공휴일·사장님 사정으로 쉰 주') + '">' + tr('이 주는 주휴 지급') + '</button>',
      cls: 'bad'
    };
  }

  /* 이 주가 아직 안 끝났는지: 'run'(오늘이 들어 있음) | 'next'(아직 시작 전) | '' (지난 주). 표시만 바꾼다 */
  function weekTiming(cal, r, wi) {
    var ds = r.days.filter(function (d) { return d.weekIndex === wi; }).map(function (d) { return d.date; });
    if (!ds.length || !cal) return '';
    var now = new Date(), ym = cal.year * 12 + (cal.month - 1), cur = now.getFullYear() * 12 + now.getMonth();
    if (ym > cur) return 'next';
    if (ym < cur) return '';
    var t = now.getDate(), lo = Math.min.apply(null, ds), hi = Math.max.apply(null, ds);
    return lo > t ? 'next' : (hi >= t ? 'run' : '');
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

    var now = new Date();
    var todayY = now.getFullYear(), todayM = now.getMonth() + 1, todayD = now.getDate();
    var ymDiff = (cal.year * 12 + cal.month) - (todayY * 12 + todayM);
    var curW = selWorker();
    var curWorkDate = (curW && E.punchNext(curW, now) === 'out' && curW.punch) ? curW.punch.date : '';

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
        var isOff = day.off || day.hours <= 0;
        var isToday = ymDiff === 0 && day.date === todayD;
        var isFuture = ymDiff > 0 || (ymDiff === 0 && day.date > todayD);
        var dayIso = cal.year + '-' + pad2(cal.month) + '-' + pad2(day.date);
        var isWorkNow = isToday && curWorkDate === dayIso;
        var cls = 'cal-day-cell' +
          (isSel ? ' selected' : '') +
          (isMeal ? ' meal-ok' : '') +
          (isOff && !isWorkNow ? ' off-day' : '') +
          (isToday ? ' is-today' : '') +
          (isWorkNow ? ' is-working' : '') +
          (isFuture && isOff ? ' is-future' : '') +
          (di === 5 ? ' is-sat' : (di === 6 ? ' is-sun' : ''));
        var dateColor = di === 5 ? ' sat' : (di === 6 ? ' sun' : '');

        var bodyHtml = '';
        if (isWorkNow && isOff) {
          bodyHtml = '<div class="cal-shift-range"><span>' + escHtml(curW.punch.time) + '</span><span class="cal-live">' + tr('근무중') + '</span></div>';
        } else if (!isOff) {
          bodyHtml = '<div class="cal-shift-range">' + shiftRangeHtml(day.start, day.end) + '</div>';
        }
        var mealBarHtml = '';
        if (!isOff && r.includeMeal) {
          if (isMeal) {
            var two = day.meals && day.meals.lunch && day.meals.dinner;
            mealBarHtml = '<div class="cal-meal-icon cal-meal-bar' + (two ? ' two' : '') + '" title="' + escHtml(tr('식대: {w}', { w: mealWords(day.meals) })) + '">' + (two ? '<i></i><i></i>' : '') + '</div>';
          } else {
            mealBarHtml = '<div class="cal-meal-bar none" title="' + escHtml(tr('식대 없음')) + '"></div>';
          }
        }

        rowsHtml += '<td class="' + cls + '" data-day-idx="' + day.index + '">' +
          '<div class="cal-date-num' + dateColor + '">' + day.date + '</div>' +
          bodyHtml + mealBarHtml +
          '</td>';
      }
      rowsHtml += '</tr>';

      // 주간 합계 한 줄: "1주 ──── 5일 · 40h · 식대 5 · 주휴 O" (주휴 금액은 [줄 돈 보기]일 때만)
      var st = weekStatus(wkObj, r, wi);
      var timing = weekTiming(cal, r, wi);
      if (timing && r.includeWeekly && !(wkObj.eligible || wkObj.excused)) {   // 안 끝난 주는 "주휴 X" 대신 진행 중/예정 (계산·버튼은 그대로)
        st.mark = timing === 'run' ? tr('진행 중') : tr('예정');
        st.note = ''; st.cls = timing;
      }
      var mutedLbl = !!(timing && !(wkObj.eligible || wkObj.excused));
      var sumContent = '';
      if (timing && wkObj.hours <= 0 && !(wkObj.eligible || wkObj.excused)) {
        sumContent = escHtml(timing === 'run' ? tr('진행 중') : tr('예정'));
      } else {
        var facts = [];
        if (wkObj.workDays !== null && wkObj.workDays !== undefined) facts.push(tr('{n}일', { n: wkObj.workDays }));
        facts.push(E.formatNum(wkObj.hours, 1) + 'h');
        if (r.includeMeal) facts.push(tr('식대 {n}', { n: wkObj.mealDays }));
        facts.push((wkObj.eligible || wkObj.excused) ? '<strong>' + escHtml(st.mark) + '</strong>' : escHtml(st.mark));
        sumContent = facts.join(' · ') +
          (st.note ? ' <span class="wk-note">' + escHtml(st.note) + '</span>' : '') +
          (st.money ? ' <span class="wk-money m-amt-hide" data-amt="' + escHtml(st.money) + '"></span>' : '');
      }
      rowsHtml += '<tr class="cal-week-sum"><td colspan="7"><div class="wk-line ' + st.cls + '">' +
        '<span class="wk-lbl' + (mutedLbl ? ' muted' : '') + '">' + tr('{k}주', { k: wi + 1 }) + '</span>' +
        '<span class="wk-rule" aria-hidden="true"></span>' +
        '<span class="wk-line-text">' + sumContent + '</span>' +
        (st.btn || '') + '</div></td></tr>';
    }

    $('monthCalBody').innerHTML = rowsHtml;
    fillMoney();
  }

  // 달력 칸: 출근·퇴근 시각을 두 줄로 그대로(09:00 / 18:02). 시각이 아닌 값이면 예전처럼 한 줄
  function shiftRangeHtml(a, b) {
    if (/^\d{1,2}:\d{2}$/.test(a || '') && /^\d{1,2}:\d{2}$/.test(b || '')) return '<span>' + escHtml(a) + '</span><span>' + escHtml(b) + '</span>';
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
    // 화면 아래 줄 돈 바: 고른 알바생 한 명의 이번 달 실수령액. 금액은 syncMoneyUi가 [보기]일 때만 넣는다
    var pm = /^(\d{4})-(\d{2})$/.exec($('pMonth').value || '');
    var ms = $('payMonthSummary');
    if (ms) {
      ms.textContent = tr('{d}일 · {h}h', { d: r.workDays, h: E.formatNum(r.totalHours, 1) }) +
        (r.includeMeal ? ' · ' + tr('식대 {n}', { n: r.mealDays }) : '');
    }
    var mb = $('moneyBar');
    if (mb) {
      $('moneyBarLabel').textContent = pm ? tr('{m}월 줄 돈', { m: Number(pm[2]) }) : tr('이번 달 줄 돈');
      mb.hidden = !state.workers.length;
    }
    var rb = $('payRuleBox'), curW = selWorker();
    if (rb) {
      rb.hidden = !curW;
      if (curW) {
        $('payRuleTitle').textContent = tr('{n} 정산 기준', { n: r.name || curW.name });
        $('payRuleWage').textContent = tr('{w} · 주 {d}일', { w: E.moneyText(r.hourlyWage), d: state.contractDays });
        $('payRuleTax').textContent = tr(r.includeWeekly ? '{t} · 주휴 포함' : '{t} · 주휴 미포함', { t: r.tax.label });
        $('payRuleMeal').textContent = r.includeMeal
          ? tr('{h}시간 이상 · {a}', { h: E.formatNum(r.mealMinHours, 1), a: E.moneyText(r.mealAmount) })
          : tr('미포함');
      }
    }
    syncMoneyUi();
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
      var mealSub = r.includeMeal && r.mode === 'daily' ? (' · ' + tr('식대 {n}회', { n: w.mealDays })) : '';
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

  function punchOpts() { var o = E.punchOptions(state.settings); o.autoOut = autoOut(); return o; }
  function autoOut() { return state.settings.autoOutTime || '00:00'; }
  function autoOutLabel(t) {
    var h = Number(t.slice(0, 2));
    if (t === '00:00') return tr('자정 (00:00)');
    return h < 12 ? tr('새벽 {h}시 ({t})', { h: h, t: t }) : tr('밤 {h}시 ({t})', { h: h - 12, t: t });
  }
  function punchUnit() { return punchOpts().unit; }
  function graceLabel(g) { return g === 0 ? tr('없음 (0분)') : tr('{n}분', { n: g }); }
  function fillPunchUnit() {
    var sel = $('sPunchUnit');
    if (!sel) return;
    var o = punchOpts();
    sel.value = String(o.unit);
    $('sInMode').value = o.inMode;
    var ao = $('sAutoOut');
    if (ao) {
      ao.innerHTML = E.AUTO_OUT_CHOICES.map(function (t) { return '<option value="' + t + '">' + escHtml(autoOutLabel(t)) + (t === E.DEFAULT_AUTO_OUT ? ' · ' + escHtml(tr('기본')) : '') + '</option>'; }).join('');
      ao.value = autoOut();
    }
    $('sOutMode').value = o.outMode;
    // 유예는 단위의 절반까지, 0·5·10·15분 중에서
    [['sGraceIn', o.graceIn, o.inMode], ['sGraceOut', o.graceOut, o.outMode]].forEach(function (x) {
      var g = $(x[0]);
      g.innerHTML = E.graceChoices(o.unit).map(function (v) { return '<option value="' + v + '">' + graceLabel(v) + '</option>'; }).join('');
      g.value = String(x[1]);
      g.disabled = x[2] === 'exact' || o.unit <= 5;
    });
    // 예시 문구: 지금 설정으로 실제 계산해서 보여 줌
    function hm(x) { return pad2(Math.floor(x / 60)) + ':' + pad2(x % 60); }
    var lines = [];
    if (o.inMode === 'exact') lines.push(tr('출근: 찍은 시각 그대로 기록해요. (예: 09:03 → 09:03)'));
    else {
      var t1 = 9 * 60 - 1, t2 = 9 * 60 + o.graceIn, t3 = 9 * 60 + o.graceIn + 1;
      lines.push(tr('출근: {a} → {x}, {b} → {y}, {c} → {z}', { a: hm(t1), x: E.roundUpUnit(hm(t1), o.unit, o.graceIn), b: hm(t2), y: E.roundUpUnit(hm(t2), o.unit, o.graceIn), c: hm(t3), z: E.roundUpUnit(hm(t3), o.unit, o.graceIn) }));
    }
    if (o.outMode === 'exact') lines.push(tr('퇴근: 찍은 시각 그대로 기록해요. (예: 17:48 → 17:48)'));
    else {
      var u1 = 18 * 60 - o.graceOut - 1, u2 = 18 * 60 - o.graceOut, u3 = 18 * 60 + 1;
      lines.push(tr('퇴근: {a} → {x}, {b} → {y}, {c} → {z}', { a: hm(u1), x: E.roundDownUnit(hm(u1), o.unit, o.graceOut), b: hm(u2), y: E.roundDownUnit(hm(u2), o.unit, o.graceOut), c: hm(u3), z: E.roundDownUnit(hm(u3), o.unit, o.graceOut) }));
    }
    var maxMin = (o.inMode === 'round' ? o.graceIn : 0) + (o.outMode === 'round' ? o.graceOut : 0);
    if (maxMin > 0) {
      var wage = Number(state.settings.minWage) || 0;
      lines.push(tr('봐주는 시간은 하루 최대 {m}분이에요. (최저시급 {w} 기준 하루 최대 약 {c})', { m: maxMin, w: E.moneyText(wage), c: E.moneyText(Math.round(wage * maxMin / 60 / 10) * 10) }));
    }
    lines.push(tr('{t}까지 퇴근을 안 찍으면 자동으로 퇴근 처리하고, 근무 기록은 넣지 않고 급여 화면에 [퇴근 확인 필요]로 남겨요.', { t: autoOutLabel(autoOut()) }));
    $('punchUnitNote').innerHTML = lines.map(function (l) { return '<div>' + escHtml(l) + '</div>'; }).join('');
  }
  function readPunchSettings() {
    return {
      punchUnit: $('sPunchUnit').value, punchInMode: $('sInMode').value, punchOutMode: $('sOutMode').value,
      punchGraceIn: $('sGraceIn').value, punchGraceOut: $('sGraceOut').value, autoOutTime: $('sAutoOut').value
    };
  }
  function punchRaw() {   // 세금·최저시급 외에 그대로 둘 설정 (출퇴근 기준·보건증 알림·손님 계좌)
    var st = state.settings;
    return { punchUnit: st.punchUnit, punchInMode: st.punchInMode, punchOutMode: st.punchOutMode, punchGraceIn: st.punchGraceIn, punchGraceOut: st.punchGraceOut, autoOutTime: st.autoOutTime, healthWarnDays: st.healthWarnDays, bank: st.bank };
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
    var raw = Object.assign({ minWage: $('sMinWage').value, rates: {}, mealTimes: {} }, punchRaw());
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
    fillHealthFields(w);
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

  /* 시안 I: "홍길동 ▾" 알바생 고르기 (누르면 알바생 목록 + 알바생 추가 + 정산 명단이 펼쳐짐) */
  var workerPickOpen = false;
  function setWorkerPick(open) {
    workerPickOpen = !!open;
    var box = $('workerChips');
    if (!box) return;
    var wrap = box.querySelector('.wpick'), btn = $('workerPickBtn'), menu = $('workerPickMenu');
    if (wrap) wrap.classList.toggle('open', workerPickOpen);
    if (btn) btn.setAttribute('aria-expanded', workerPickOpen ? 'true' : 'false');
    if (menu) menu.hidden = !workerPickOpen;
  }
  function renderChips() {
    var box = $('workerChips');
    document.body.classList.toggle('no-workers', !state.workers.length);
    if (!state.workers.length) {
      workerPickOpen = false;
      box.innerHTML = '<span class="wpick-empty-title">' + tr('근무·급여') + '</span>';
      return;
    }
    var cur = selWorker() || state.workers[0];
    var now = new Date();
    var pm = $('pMonth').value;
    var itemsHtml = workingFirstOrder().map(function (i) {
      var w = state.workers[i];
      var on = E.punchNext(w, now) === 'out';
      var pend = (w.pending || []).length > 0;
      var sum = E.monthSummary(w, pm);
      var meta = on ? tr('근무 중') : (pend ? tr('퇴근 확인') : (sum.totalHours ? E.formatNum(sum.totalHours, 1) + 'h' : ''));
      return '<button type="button" class="wchip' + (w.id === state.selId ? ' on' : '') + '" data-chip="' + escHtml(w.id) + '" role="option" aria-selected="' + (w.id === state.selId ? 'true' : 'false') + '">' +
        '<span class="wchip-left">' + (on ? '<i class="wdot" aria-hidden="true"></i>' : '') + escName(w.name) + '</span>' +
        (meta ? '<span class="wchip-right' + (on ? ' is-work' : (pend ? ' is-warn' : '')) + '">' + escHtml(meta) + '</span>' : '') +
        '</button>';
    }).join('');
    box.innerHTML = '<div class="wpick' + (workerPickOpen ? ' open' : '') + '">' +
      '<button type="button" class="wpick-btn" id="workerPickBtn" aria-haspopup="listbox" aria-expanded="' + (workerPickOpen ? 'true' : 'false') + '">' +
        '<span class="wpick-name" data-no-i18n>' + escHtml(cur.name) + '</span>' +
        '<svg class="wpick-chev" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>' +
      '</button>' +
      '<div class="wpick-menu" id="workerPickMenu" role="listbox"' + (workerPickOpen ? '' : ' hidden') + '>' +
        '<div class="wpick-list">' + itemsHtml + '</div>' +
        '<div class="wpick-foot">' +
          '<button type="button" class="wchip wchip-add" id="chipAdd">' + tr('알바생 추가') + '</button>' +
          '<button type="button" class="wchip wchip-roster" id="chipRoster">' + tr('정산 명단 ({n}명)', { n: state.workers.length }) + '</button>' +
        '</div>' +
      '</div></div>';
  }

  function openSheet(kind) {   // 'set' | 'add' | 'roster'
    document.body.classList.remove('set-open', 'add-open', 'roster-open');
    document.body.classList.add(kind + '-open');
    $('sheetBackdrop').hidden = false;
  }
  function closeSheets() {
    document.body.classList.remove('set-open', 'add-open', 'slip-open', 'export-open', 'roster-open');
    $('sheetBackdrop').hidden = true;
  }

  /* 근무 중인 사람을 위로 (출근한 순서), 나머지는 등록 순서. state.workers 의 인덱스 배열을 돌려줌 */
  function workingFirstOrder() {
    var now = new Date();
    var arr = state.workers.map(function (w, i) { return { w: w, i: i, on: E.punchNext(w, now) === 'out' }; });
    arr.sort(function (a, b) {
      if (a.on !== b.on) return a.on ? -1 : 1;
      if (a.on) { var ka = a.w.punch.date + a.w.punch.at, kb = b.w.punch.date + b.w.punch.at; if (ka !== kb) return ka < kb ? -1 : 1; }
      return a.i - b.i;
    });
    return arr.map(function (o) { return o.i; });
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
    $('rosterTotal').setAttribute('data-amt', E.moneyText(sum.totalNet));   // 금액은 data-amt에 두고 [줄 돈 보기]일 때만 글자로(fillMoney)
    $('rosterMonthLabel').textContent = tr('{y}년 {m}월', { y: pm.slice(0, 4), m: Number(pm.slice(5)) });
    renderChips();
    renderWorkNow();
    renderPending();
    renderConflicts();
    renderPunch();

    var ord = workingFirstOrder();
    var nowR = new Date();
    var hMap = {};
    if (typeof healthAlertList === 'function') healthAlertList().forEach(function (a) { hMap[a.id] = a; });
    $('rosterCards').innerHTML = ord.map(function (idx) {
      var r = results[idx];
      var w = state.workers[idx];
      var hasRec = !!(w.months && w.months[pm]);
      var sel = w.id === state.selId;
      var working = E.punchNext(w, nowR) === 'out';
      var pend = (w.pending || []).length > 0;
      var ha = hMap[w.id];
      var tag = '';
      if (working) tag = '<span class="rcard-tag is-work">' + tr('근무 중') + '</span>';
      else if (pend) tag = '<span class="rcard-tag is-warn">' + tr('퇴근 확인') + '</span>';
      else if (ha && (ha.state === 'expired' || ha.state === 'urgent')) {
        tag = '<span class="rcard-tag is-red">' + (ha.state === 'expired' ? tr('보건증 만료') : tr('보건증 D-{n}', { n: ha.days })) + '</span>';
      }
      var metaLeft = hasRec
        ? (r.includeMeal ? tr('{d}일 · 식대 {m}회', { d: r.workDays, m: r.mealDays }) : tr('{n}일', { n: r.workDays }))
        : tr('기록 없음');
      return '<div class="rcard' + (sel ? ' on' : '') + '">' +
        '<button type="button" class="rcard-main" data-pick-worker="' + escHtml(w.id) + '">' +
          '<span class="rcard-top">' +
            '<span class="rcard-name">' + escName(r.name) + (working ? '<i class="wdot" aria-hidden="true"></i>' : '') + '</span>' +
            '<span class="rcard-hrs num">' + (hasRec ? E.formatNum(r.totalHours, 1) + 'h' : '0h') + '</span>' +
          '</span>' +
          '<span class="rcard-sub"><span>' + escHtml(metaLeft) + '</span>' + tag + '</span>' +
        '</button>' +
        '<b class="rcard-amt m-amt" data-amt="' + escHtml(E.moneyText(r.net)) + '"></b>' +
        '<button type="button" class="rcard-del" data-del-worker="' + escHtml(w.id) + '" aria-label="' + escHtml(tr('{n} 삭제', { n: r.name })) + '">✕</button>' +
        '</div>';
    }).join('');
    fillMoney();

    if (!results.length) {
      $('rosterBody').innerHTML = '<tr class="empty"><td colspan="11">아직 알바생이 없습니다. 위에서 이름·일하는 날·시급을 넣고 [알바생 추가]를 눌러주세요.</td></tr>';
      $('rosterFoot').innerHTML = '';
      return;
    }

    $('rosterBody').innerHTML = ord.map(function (idx, pos) {
      var r = results[idx];
      var w = state.workers[idx];
      var hasRec = !!(w.months && w.months[pm]);
      var sel = w.id === state.selId;
      return '<tr class="roster-row' + (sel ? ' selected' : '') + '" data-wid="' + escHtml(w.id) + '">' +
        '<td>' + (pos + 1) + '</td>' +
        '<td><button type="button" class="worker-link" data-pick-worker="' + escHtml(w.id) + '"><b>' + escName(r.name) + '</b></button>' +
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
      '</tr>';    if (typeof healthDay === 'string' && $('bellBtn')) renderHealth();   // 알바생 추가·삭제·이름 변경 반영
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
  /* 시안 I: 분류마다 접기/펼치기 + 항목마다 [적합 | 점검 필요].
     저장 형식은 그대로 — 항목마다 체크박스 하나(체크 = 적합, 안 체크 = 점검 필요)이고, 두 버튼은 그 체크박스를 켜고 끈다 */
  function buildChecklistForm() {
    var html = '';
    E.getChecklistGroups().forEach(function (g, gi) {
      html += '<details class="chk-form-group" data-g="' + gi + '"><summary class="chk-form-sum">' +
        '<span class="chk-form-title">' + escHtml(g.title) + '</span>' +
        '<span class="chk-gcount" data-gcount></span><span class="chk-gneed" data-gneed></span></summary>';
      g.items.forEach(function (it) {
        html += '<div class="check-item chk-form-item" data-item="' + it.no + '">' +
          '<input type="checkbox" class="chk-in" value="' + it.no + '" tabindex="-1" aria-hidden="true">' +
          '<div class="chk-fitem-text"><b>' + it.no + '.</b> ' + escHtml(it.text) +
          (it.standard ? '<small class="item-std">' + escHtml(it.standard) + '</small>' : '') +
          '<div class="health-warn chk-item-warn" data-iwarn hidden></div></div>' +
          '<div class="chk-seg" role="group" aria-label="' + escHtml(tr('{n}번 결과', { n: it.no })) + '">' +
          '<button type="button" class="seg-ok" data-chk-set="' + it.no + '" data-v="1" aria-pressed="false">' + tr('적합') + '</button>' +
          '<button type="button" class="seg-bad" data-chk-set="' + it.no + '" data-v="0" aria-pressed="true">' + tr('점검 필요') + '</button>' +
          '</div></div>';
      });
      html += '</details>';
    });
    $('chkFormList').innerHTML = html;
  }

  /* 체크 상태를 버튼 눌림·분류 개수·경고에 맞춘다(renderChecklist 끝에서 매번 부름).
     분류 펼침은 폼을 새로 그린 뒤 첫 번에만 "점검 필요가 있으면 펼침"으로 정하고(data-init), 그 뒤로는 손대지 않는다 —
     항목을 누르다 분류가 저절로 접히면 아래 내용이 손가락 밑으로 올라오기 때문이다 */
  function syncChkForm(c, hNote) {
    var byNo = {};
    (c && c.groups || []).forEach(function (g) { g.items.forEach(function (it) { byNo[it.no] = it; }); });
    Array.prototype.forEach.call(document.querySelectorAll('#chkFormList .chk-form-group'), function (gEl) {
      var boxes = gEl.querySelectorAll('input.chk-in'), on = 0;
      Array.prototype.forEach.call(boxes, function (cb) {
        var ok = cb.checked;
        var jud = byNo[Number(cb.value)];
        if (jud ? jud.ok : ok) on++;   // 분류 개수는 판정 결과로 센다(20번은 체크해도 온도 이탈이면 점검필요)
        var row = cb.closest('.chk-form-item');
        row.classList.toggle('is-ok', ok);
        row.querySelector('.seg-ok').setAttribute('aria-pressed', ok ? 'true' : 'false');
        row.querySelector('.seg-bad').setAttribute('aria-pressed', ok ? 'false' : 'true');
        var no = Number(cb.value), it = byNo[no], w = row.querySelector('[data-iwarn]'), msg = '';
        if (no === 4 && hNote) msg = '⚠️ ' + hNote;                                   // 보건증 만료 경고
        else if (it && ok && it.ok === false) msg = tr('⚠️ 체크했지만 온도가 기준을 벗어나 점검필요로 판정돼요');   // 20번 온도 자동 판정
        w.textContent = msg; w.hidden = !msg;
      });
      var need = boxes.length - on;
      gEl.querySelector('[data-gcount]').textContent = on + '/' + boxes.length;
      var ne = gEl.querySelector('[data-gneed]');
      ne.textContent = need ? tr('필요 {n}', { n: need }) : '';
      ne.hidden = !need;
      gEl.classList.toggle('all-ok', !need);
      if (!gEl.dataset.init) { gEl.open = need > 0; gEl.dataset.init = '1'; }
    });
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

    var hNote = typeof healthDay === 'string' && $('bellBtn') ? healthChecklistNote() : '';
    function itemWarn(it) { return it.no === 4 && hNote ? '<div class="health-warn">⚠️ ' + escHtml(hNote) + '</div>' : ''; }
    var rowsHtml = '';
    c.groups.forEach(function (g) {
      g.items.forEach(function (it, idx) {
        rowsHtml += '<tr>';
        if (idx === 0) {
          rowsHtml += '<td class="group" rowspan="' + g.items.length + '">' + escHtml(g.title) + '</td>';
        }
        rowsHtml +=
          '<td class="no">' + it.no + '</td>' +
          '<td>' + escHtml(it.text) + (it.standard ? '<span class="item-std">' + tr('기준: {s}', { s: escHtml(it.standard) }) + '</span>' : '') + itemWarn(it) + '</td>' +
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
            '<div class="chk-item-std">' + (it.standard ? tr('기준: {s}', { s: escHtml(it.standard) }) + ' · ' : '') + escHtml(it.note) + '</div>' + itemWarn(it) +
          '</div>' +
          '<span class="result ' + (it.ok ? 'ok' : 'bad') + '">' + escHtml(it.status) + '</span>' +
          '</div>';
      });
      cardsHtml += '</section>';
    });
    $('chkCards').innerHTML = cardsHtml;
    syncChkForm(c, hNote);
  }

  function recalcChecklist() {
    var inp = readChecklistForm();
    var c = E.buildChecklist(inp);
    renderChecklist(c);
  }

  function renderArchive() {
    var results = state.archive.map(function (inp) { return E.buildChecklist(inp); });
    $('archiveCount').textContent = tr('{n}일', { n: results.length });

    if (!results.length) {
      $('archiveBody').innerHTML = '<tr class="empty"><td colspan="10">저장된 일별 점검 기록이 없습니다. [보관함에 저장] 버튼을 눌러 누적해보세요.</td></tr>';
      return;
    }

    $('archiveBody').innerHTML = results.map(function (c, idx) {
      return '<tr>' +
        '<td>' + (idx + 1) + '</td>' +
        '<td>' + escHtml(c.date || '-') + '</td>' +
        '<td><b>' + escName(c.store) + '</b></td>' +
        '<td>' + escName(c.inspector) + '</td>' +
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

    var savedStore = cleanStoreInfo(loadJson(KEYS.store, null));
    $('cStore').value = savedStore.store;
    $('cInspector').value = savedStore.inspector;
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
      showToast(tr('{d}일({w}) 휴무 처리', { d: cd.date, w: cd.dayName }));
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

    // ----- 시안 I: 알바생 ▾ 메뉴 / 설정 창 / 알바생 추가 창 / 정산 명단 / 명세서 / ⋯ 더보기 -----
    $('workerChips').addEventListener('click', function (ev) {
      if (ev.target.closest('#workerPickBtn')) { ev.stopPropagation(); setWorkerPick(!workerPickOpen); return; }
      if (ev.target.closest('#chipAdd')) { setWorkerPick(false); openSheet('add'); return; }
      if (ev.target.closest('#chipRoster')) { setWorkerPick(false); openSheet('roster'); return; }
      var c = ev.target.closest('[data-chip]');
      if (c) { setWorkerPick(false); selectWorker(c.getAttribute('data-chip')); }
    });
    document.addEventListener('click', function (ev) {
      if (workerPickOpen && !ev.target.closest('#workerChips')) setWorkerPick(false);
    });
    $('emptyAdd').addEventListener('click', function () { openSheet('add'); });
    $('emptyGuide').addEventListener('click', function () {
      var t = document.querySelector('.tab[data-tab="guide"]');
      if (t) t.click();
    });
    $('openSet').addEventListener('click', function () { if (selWorker()) openSheet('set'); else openSheet('add'); });
    $('setSheetDone').addEventListener('click', closeSheets);
    $('addSheetClose').addEventListener('click', closeSheets);
    if ($('rosterSheetClose')) $('rosterSheetClose').addEventListener('click', closeSheets);
    if ($('btnAddStaffQuick')) $('btnAddStaffQuick').addEventListener('click', function () { openSheet('add'); });
    if ($('payRuleEdit')) $('payRuleEdit').addEventListener('click', function () { $('openSet').click(); });
    if ($('tbSlip')) $('tbSlip').addEventListener('click', function () { document.body.classList.add('slip-open'); });
    if ($('tbKakao')) $('tbKakao').addEventListener('click', function () { $('copyKakao').click(); });
    if ($('tbPdf')) $('tbPdf').addEventListener('click', function () { $('btnPrintPay').click(); });
    if ($('tbXlsx')) $('tbXlsx').addEventListener('click', function () { $('btnXlsxPay').click(); });
    if ($('moneyBarSlip')) $('moneyBarSlip').addEventListener('click', function () { document.body.classList.add('slip-open'); });
    if ($('payMoreMenu')) $('payMoreMenu').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-pm]');
      if (!b) return;
      var act = b.getAttribute('data-pm');
      $('payMoreMenu').open = false;
      if (act === 'set') $('openSet').click();
      else if (act === 'slip') document.body.classList.add('slip-open');
      else if (act === 'kakao') $('copyKakao').click();
      else if (act === 'pdf') $('btnPrintPay').click();
      else if (act === 'xlsx') $('btnXlsxPay').click();
      else if (act === 'roster-xlsx') $('btnRosterXlsx').click();
      else if (act === 'roster') openSheet('roster');
      else if (act === 'clear-days') $('btnClearAllDays').click();
      else if (act === 'cloud') $('cloudBtn').click();
      else if (act === 'lock') $('lockBtn').click();
      else if (act === 'roster-clear') $('btnRosterClear').click();
    });
    if ($('moneyBar')) $('moneyBar').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-mb]');
      if (!b) return;
      var act = b.getAttribute('data-mb');
      if (act === 'slip') document.body.classList.add('slip-open');
      else if (act === 'kakao') $('copyKakao').click();
      else if (act === 'pdf') $('btnPrintPay').click();
      else if (act === 'xlsx') $('btnXlsxPay').click();
    });
    $('sheetBackdrop').addEventListener('click', closeSheets);
    $('btnSlipOpen').addEventListener('click', function () {
      document.body.classList.add('slip-open');
    });
    $('slipClose').addEventListener('click', closeSheets);
    $('moneyToggle').addEventListener('click', function () {   // 줄 돈은 기본 숨김, 눌러야 보임
      document.body.classList.toggle('money-show');
      syncMoneyUi();
    });
    // 아래 줄 돈 바의 [보기]/[숨기기]는 위 버튼과 같은 상태를 쓴다
    $('moneyBarBtn').addEventListener('click', function () { $('moneyToggle').click(); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && workerPickOpen) setWorkerPick(false);
      if (ev.key === 'Escape' && /set-open|add-open|slip-open|export-open|roster-open/.test(document.body.className)) closeSheets();
    });

    // 카톡 명세서 복사
    $('copyKakao').addEventListener('click', function () {
      if (!state.payroll) return;
      copyText(state.payroll.kakaoText).then(function (ok) {
        showToast(ok ? tr('카카오톡용 급여명세서가 클립보드에 복사되었습니다!') : tr('복사에 실패했습니다.'));
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
    ['sPunchUnit', 'sInMode', 'sGraceIn', 'sOutMode', 'sGraceOut', 'sAutoOut'].forEach(function (id) {
      $(id).addEventListener('change', function () {
        state.settings = E.sanitizeSettings(Object.assign({}, state.settings, readPunchSettings()));
        saveJson(KEYS.settings, state.settings);
        fillPunchUnit();
        showToast(tr('출퇴근 시간 기준을 바꿨어요. 지금부터 찍는 시각에 적용돼요.'));
      });
    });
    $('btnSettingsReset').addEventListener('click', function () {
      if (!window.confirm(tr('세금·보험료 비율과 최저시급을 처음 값으로 되돌릴까요?'))) return;
      state.settings = E.sanitizeSettings(punchRaw());   // 출퇴근 끊는 기준은 그대로 둠
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
      showToast(tr('{n}님을 추가했습니다. 이름을 누르면 근무 기록을 입력할 수 있어요.', { n: w.name }));
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
      if (document.body.classList.contains('roster-open')) closeSheets();
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
        showToast(tr('엑셀(.xlsx) 다운로드 완료: {f}', { f: fn }));
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
          '<span class="export-name">' + escName(w.name) + '</span><small>' + (n ? tr('{n}개월 기록', { n: n }) : tr('기록 없음')) + '</small></label>';
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
    ['cDate', 'cInspector', 'cFridge', 'cFreezer', 'cMemo'].forEach(function (id) {
      $(id).addEventListener('input', recalcChecklist);
    });
    $('chkFormList').addEventListener('change', recalcChecklist);
    // [적합]/[점검 필요] → 그 항목 체크박스를 켜고 끈 뒤, 체크박스를 직접 누른 것처럼 change를 올려 보낸다(저장·계산 경로 그대로)
    $('chkFormList').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-chk-set]');
      if (!b) return;
      var cb = $('chkFormList').querySelector('input.chk-in[value="' + b.getAttribute('data-chk-set') + '"]');
      if (!cb) return;
      var want = b.getAttribute('data-v') === '1';
      if (cb.checked === want) return;
      cb.checked = want;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
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
      showToast(tr('점검 보관함에 {d} 점검표 저장 ({v})', { d: c.date || tr('오늘'), v: c.verdict }));
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

  /* 지금 받아온 내용을 화면에 바로 반영하면 곤란한 순간(입력 중·창이 열려 있음) */
  function cloudBusy() {
    var ids = ['punchPw', 'punchResult', 'adminPin', 'dayModal', 'sheetBackdrop', 'healthModal', 'bankModal', 'pinSetup', 'cloudModal'];   // sheetBackdrop: 폰에서 정산 설정·알바생 추가 창이 열려 있음
    for (var i = 0; i < ids.length; i++) { var el = $(ids[i]); if (el && !el.hidden) return true; }
    var a = document.activeElement;
    return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.id !== 'guideSearch');
  }

  function cloudData() {
    return {
      conflicts: loadConflicts(),
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

    var wrows = [['이름', '고유코드', '비밀번호', '계약서상 주 근무일', '시급(원)', '기록이 있는 달', '보건증 만료일']];
    state.workers.forEach(function (w) {
      var hh = w.health || {};
      wrows.push([w.name, w.code || '', w.password || '', '주 ' + w.contractDays + '일', w.wage, Object.keys(w.months).length + '개월', hh.off ? '알림 끔' : (hh.expire || '')]);
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
      state.archive = Array.isArray(d.archive) ? d.archive.filter(function (x) { return x && typeof x === 'object' && !Array.isArray(x); }) : [];
      if (Array.isArray(d.conflicts)) saveJson(KEYS.conflicts, cleanConflicts(d.conflicts));
      saveWorkers();
      saveJson(KEYS.archive, state.archive);
      if (Array.isArray(d.presets)) {   // 빈 목록(모두 지움)도 반영
        saveJson(KEYS.presets, d.presets);
        loadPresets();
        savePresets();   // 이름 길이·개수를 정리한 목록으로 저장
        renderPresets();
      }
      if (d.store && typeof d.store === 'object') {
        d.store = cleanStoreInfo(d.store);   // 길이·예시 문구 정리한 값을 저장
        saveJson(KEYS.store, d.store);
        applyStoreInfo(d.store, true);
      }
      if (d.settings) { state.settings = E.sanitizeSettings(d.settings); saveJson(KEYS.settings, state.settings); applySettings(); $('sHealthWarn').value = String(state.settings.healthWarnDays); renderBank(); }
      if (!selWorker()) state.selId = state.workers.length ? state.workers[0].id : '';
      loadSelected();
      recalcPayroll();
      renderRoster();
      renderArchive();
      recalcChecklist();
      renderConflicts();
      renderHealth();
    } finally {
      syncSuspended = false;
    }
  }

  /* ---------- 다른 기기와 수정이 겹친 곳 (같은 칸을 두 기기가 서로 다르게 고침) ----------
     저장은 먼저 정해진 값(저장된 값)으로 하되 조용히 덮이지 않게 목록으로 남겨, 사장님이 [유지] 또는 [덮인 값으로 되돌리기]를 고른다 */
  function cleanConflicts(list) {
    return (Array.isArray(list) ? list : []).filter(function (c) { return c && typeof c.id === 'string' && Array.isArray(c.path); }).slice(-30);
  }
  function loadConflicts() { return cleanConflicts(loadJson(KEYS.conflicts, [])); }
  var FIELD_LABEL = { wage: '시급', contractDays: '주 근무일', name: '이름', password: '비밀번호', includeWeekly: '주휴수당', includeMeal: '식대', mealAmount: '식대 금액', mealMinHours: '식대 기준 시간', tax: '세금', weekExcuse: '주휴 예외', breakMinutes: '휴게', health: '보건증', exam: '보건증 검진일', expire: '보건증 만료일', off: '보건증 알림 끔', healthWarnDays: '보건증 알림 시점', bank: '손님 계좌' };
  function cellText(v) {
    if (v === null || v === undefined) return tr('없음');
    if (typeof v === 'object' && !Array.isArray(v) && ('off' in v || 'start' in v)) {
      if (v.off || !v.start || !v.end) return tr('휴무');
      return v.start + '~' + v.end + (v.breakMinutes ? ' (' + tr('휴게 {n}분', { n: v.breakMinutes }) + ')' : '');
    }
    if (typeof v === 'number' && v >= 1000) return E.formatWon ? E.formatWon(v) + (E.getLang() === 'en' ? '' : '원') : String(v);
    if (typeof v === 'boolean') return v ? tr('예') : tr('아니오');
    var t = typeof v === 'string' ? v : JSON.stringify(v);
    return t.length > 60 ? t.slice(0, 60) + '…' : t;
  }
  function conflictWhat(c) {
    var p = (c.path || []).map(function (k) { return k && typeof k === 'object' && k.id ? k.id : k; });
    if (p[0] === 'workers') {
      var w = state.workers.filter(function (x) { return x.id === p[1]; })[0];
      var who = w ? w.name : tr('(삭제된 알바생)');
      if (p[2] === 'months' && p[4] === 'dailyShifts' && typeof p[5] === 'number') {
        return who + ' · ' + tr('{m}월 {d}일 근무', { m: Number(String(p[3]).slice(5, 7)), d: p[5] + 1 });
      }
      if (p[2] === 'months' && p[4]) return who + ' · ' + tr('{m}월', { m: Number(String(p[3]).slice(5, 7)) }) + ' ' + tr(FIELD_LABEL[p[4]] || p[4]);
      return who + ' · ' + tr(FIELD_LABEL[p[2]] || String(p[2] || ''));
    }
    if (p[0] === 'settings') return tr('설정') + ' · ' + (FIELD_LABEL[p[1]] ? tr(FIELD_LABEL[p[1]]) + (p.length > 2 ? ' › ' + p.slice(2).join(' › ') : '') : p.slice(1).join(' › '));
    return p.join(' › ');
  }
  /* 덮인 값으로 되돌릴 수 있는 곳: 알바생 기록·설정 */
  function conflictTarget(c) {
    var p = (c.path || []).map(function (k) { return k && typeof k === 'object' && k.id ? k.id : k; }), cur;
    if (p.some(function (k) { return k === '__proto__' || k === 'constructor' || k === 'prototype'; })) return null;   // 원형 오염 방지
    if (p[0] === 'workers') {
      cur = state.workers.filter(function (x) { return x.id === p[1]; })[0];
      if (!cur) return null;
      for (var i = 2; i < p.length - 1; i++) { cur = cur[p[i]]; if (!cur || typeof cur !== 'object') return null; }
      return p.length > 2 ? { obj: cur, key: p[p.length - 1], kind: 'workers' } : null;
    }
    if (p[0] === 'settings' && p.length > 1) {
      cur = state.settings;
      for (var j = 1; j < p.length - 1; j++) { cur = cur[p[j]]; if (!cur || typeof cur !== 'object') return null; }
      return { obj: cur, key: p[p.length - 1], kind: 'settings' };
    }
    return null;
  }
  /* ---------- 출퇴근 기기(단일 저장) ---------- */
  function devRole() { var C = window.AlbaCloud; return C && C.role ? C.role() : 'none'; }
  function isRequester() { return devRole() === 'requester'; }
  /* 수정 요청을 사람이 읽을 수 있게: "김알바 · 11월 16일 근무: 09:00~14:00 → 09:00~13:30" */
  function opText(op) {
    var p = (op.path || []).map(function (k) { return k && typeof k === 'object' && k.id ? k.id : k; });
    if (op.add !== undefined || op.del !== undefined) {
      var what = p[0] === 'archive' ? tr('점검 보관함') : p.join(' › ');
      var it = op.add !== undefined ? op.add : op.del;
      var label = it && typeof it === 'object' ? (it.date || it.store || '') : String(it);
      return what + ' ' + (op.add !== undefined ? tr('추가') : tr('삭제')) + (label ? ' (' + label + ')' : '');
    }
    if (p[0] === 'workers' && p.length === 2) {
      var w = op.after || op.before || {};
      return (op.before === null ? tr('알바생 추가') : op.after === null ? tr('알바생 삭제') : tr('알바생 정보')) + ': ' + (w.name || '');
    }
    var c = { path: op.path };
    var name = conflictWhat(c);
    if (p[0] === 'workers' && !state.workers.some(function (x) { return x.id === p[1]; })) {
      name = name.replace(tr('(삭제된 알바생)'), tr('새 알바생'));
    }
    return name + ': ' + cellText(op.before) + ' → ' + cellText(op.after);
  }
  function describeOps(ops) {
    var list = (ops || []).map(opText);
    return list.slice(0, 3).join(' / ') + (list.length > 3 ? ' ' + tr('외 {n}건', { n: list.length - 3 }) : '');
  }
  function ageText(iso) {
    var t = Date.parse(iso || '');
    if (!t) return '';
    var m = Math.max(0, Math.round((Date.now() - t) / 60000));
    return m < 1 ? tr('방금') : m < 60 ? tr('{n}분 전', { n: m }) : tr('{n}시간 전', { n: Math.floor(m / 60) });
  }
  function renderDevice() {
    var C = window.AlbaCloud, bar = $('devBar');
    if (!bar) return;
    var info = C && C.deviceInfo ? C.deviceInfo() : null;
    var st = C && C.getStatus ? C.getStatus() : null;
    var conn = !!(st && st.connected);
    var cls = 'dev-bar', txt = '';
    if (info && conn) {
      var dv = info.dev || {};
      if (info.role === 'writer') { cls += ' ok'; txt = tr('✅ 이 기기가 출퇴근 기기예요 ({n})', { n: dv.name || info.myName || '' }); }
      else if (info.role === 'requester') {
        var mins = dv.beat ? (Date.now() - Date.parse(dv.beat)) / 60000 : 999;
        var name = dv.name || tr('매장 기기');
        if (mins > 5) { cls += ' warn'; txt = dv.beat ? tr('⚠️ 출퇴근 기기({n})가 {a}부터 응답이 없어요', { n: name, a: ageText(dv.beat) }) : tr('⚠️ 출퇴근 기기({n})의 응답 기록이 없어요', { n: name }); }
        else txt = tr('📍 출퇴근 기기: {n} · {a} 응답', { n: name, a: ageText(dv.beat) });
        if (info.queued) txt += ' · ' + tr('내 수정 요청 {q}건 대기 중', { q: info.queued });
      } else { cls += ' warn'; txt = tr('⚠️ 출퇴근 기기가 지정되지 않았어요 · 설정 → 출퇴근 기기에서 매장 기기를 지정해 주세요'); }
    }
    bar.className = cls;
    bar.textContent = txt;
    bar.hidden = !txt;
    // 설정 화면
    var di = $('devInfo');
    if (di) {
      var role = info ? info.role : 'none';
      var d = info ? info.dev || {} : {};
      di.innerHTML = !conn ? escHtml(tr('구글 저장을 켜면 지정할 수 있어요.'))
        : role === 'writer' ? escHtml(tr('이 기기가 출퇴근 기기예요. 다른 기기의 수정 요청을 받아 반영합니다.'))
        : role === 'requester' ? escHtml(tr('출퇴근 기기: {n} (마지막 응답 {a}). 이 기기에서 고친 내용은 수정 요청으로 보내져요.', { n: d.name || '', a: ageText(d.beat) || '-' }))
        : escHtml(tr('아직 지정되지 않았어요. 매장 기기에서 이름을 적고 아래 버튼을 눌러 주세요.'));
      $('devState').textContent = (role === 'writer' ? tr('· 이 기기') : role === 'requester' ? tr('· 다른 기기 지정됨') : tr('· 미지정')).replace(/^·\s*/, '');
      $('btnDevSet').disabled = !conn;
      $('btnDevSet').textContent = role === 'writer' ? tr('이름 바꾸기') : tr('이 기기를 출퇴근 기기로 지정');
      $('btnDevClear').hidden = role !== 'writer';
      if (info && document.activeElement !== $('sDevName') && !$('sDevName').value) $('sDevName').value = info.myName || '';
    }
  }
  function onDevSet() {
    var C = window.AlbaCloud;
    if (!C || !C.isConnected()) { showToast(tr('구글 저장을 먼저 켜 주세요.')); return; }
    if (!getPin()) { showToast(tr('관리자 비밀번호를 먼저 정해 주세요. 출퇴근 기기를 바꾸는 일을 막기 위해 필요해요.'), true); $('sAdminPin').focus(); return; }
    var info = C.deviceInfo(), d = info.dev || {};
    var name = $('sDevName').value.trim() || tr('매장 기기');
    if (d.id && d.id !== info.myId) {
      var mins = d.beat ? (Date.now() - Date.parse(d.beat)) / 60000 : 999;
      var msg = mins < 3
        ? tr('{n}이(가) 지금 켜져 있어요 ({a} 응답). 그래도 이 기기를 출퇴근 기기로 바꿀까요?\n바꾸면 {n}은(는) 저장을 멈추고 수정 요청만 보내요.', { n: d.name || tr('다른 기기'), a: ageText(d.beat) })
        : tr('출퇴근 기기를 {n}에서 이 기기로 바꿀까요?', { n: d.name || tr('다른 기기') });
      if (!window.confirm(msg)) return;
    }
    var btn = $('btnDevSet');
    btn.disabled = true;
    C.designate(name).then(function (ok) {
      btn.disabled = false;
      showToast(ok ? tr('✅ 이 기기({n})를 출퇴근 기기로 지정했어요.', { n: name }) : tr('지정하지 못했어요. 인터넷과 구글 로그인을 확인해 주세요.'), !ok);
      renderDevice(); renderPunch();
    });
  }
  function onDevClear() {
    var C = window.AlbaCloud;
    if (!C || !window.confirm(tr('출퇴근 기기 지정을 해제할까요? 해제하면 모든 기기가 예전처럼 직접 저장해요.'))) return;
    C.undesignate().then(function (ok) { showToast(ok ? tr('지정을 해제했어요.') : tr('해제하지 못했어요. 인터넷을 확인해 주세요.'), !ok); renderDevice(); renderPunch(); });
  }
  var reqToastAt = 0;
  function onRequestEvent(ev) {
    if (!ev || !ev.item) return;
    if (ev.kind === 'queued') {
      if (Date.now() - reqToastAt > 8000) { reqToastAt = Date.now(); showToast(tr('📨 수정 요청을 보냈어요. 출퇴근 기기가 반영하면 확정돼요.')); }
    } else if (ev.kind === 'rejected') {
      showToast(tr('⚠️ 수정 요청이 반영되지 않았어요: {r}. 화면을 확인하고 다시 고쳐 주세요. ({d})', { r: ev.reason || '', d: ev.item.desc || '' }), true);
    } else if (ev.kind === 'converted') {
      showToast(tr('⚠️ 출퇴근 기기가 다른 기기로 바뀌어, 이 기기에서 저장 못 한 내용을 수정 요청으로 보냈어요. 반영되는지 확인해 주세요.'), true);
    }
    renderDevice();
  }

  function renderConflicts() {
    var box = $('conflictBox');
    if (!box) return;
    var list = loadConflicts();
    if (!list.length) { box.hidden = true; box.innerHTML = ''; return; }
    var wasOpen = !!(box.querySelector('details.pending-det[open]'));
    box.innerHTML = '<details class="pending-det conflict-det"' + (wasOpen ? ' open' : '') + '>' +
      '<summary class="pending-sum conflict-sum">' +
        '<svg class="warn-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>' +
        '<span class="pending-sum-txt">' + tr('다른 기기와 수정이 겹쳤어요 {n}건', { n: list.length }) + '</span>' +
        '<span class="pending-sum-end"><span class="pending-sum-cta">' + tr('확인하기') + '</span>' +
          '<svg class="pending-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>' +
      '</summary>' +
      '<div class="pending-body">' +
        '<p class="pending-note">' + tr('두 기기에서 같은 곳을 거의 동시에 고쳤어요. 지금은 [저장된 값]으로 되어 있어요. 맞는 값을 골라 주세요.') + '</p>' +
        list.map(function (c) {
          var can = !!conflictTarget(c);
          var id = escHtml(c.id);
          return '<div class="pending-row">' +
            '<div class="pending-who"><b>' + escHtml(conflictWhat(c)) + '</b></div>' +
            '<div class="conflict-vals"><span>' + tr('저장된 값') + ': <b>' + escHtml(cellText(c.local)) + '</b></span><span>' + tr('덮인 값') + ': <b>' + escHtml(cellText(c.remote)) + '</b></span></div>' +
            '<div class="pending-act">' +
              '<button type="button" class="btn btn-primary" data-conflict-keep="' + id + '">' + tr('저장된 값 유지') + '</button>' +
              (can ? '<button type="button" class="btn" data-conflict-undo="' + id + '">' + tr('덮인 값으로 되돌리기') + '</button>' : '') +
            '</div></div>';
        }).join('') +
      '</div></details>';
    box.hidden = false;
  }
  function onConflictClick(ev) {
    var keep = ev.target.closest('[data-conflict-keep]'), undo = ev.target.closest('[data-conflict-undo]');
    if (!keep && !undo) return;
    var id = (keep || undo).getAttribute(keep ? 'data-conflict-keep' : 'data-conflict-undo');
    var list = loadConflicts(), c = list.filter(function (x) { return x.id === id; })[0];
    if (!c) { renderConflicts(); return; }
    if (undo) {
      var t = conflictTarget(c);
      if (!t) { showToast(tr('되돌릴 곳을 찾지 못했어요. 직접 고쳐 주세요.')); return; }
      var now = t.obj[t.key];
      if (JSON.stringify(now === undefined ? null : now) !== JSON.stringify(c.local === undefined ? null : c.local) &&
          !window.confirm(tr('그 뒤에 이 값이 또 바뀌었어요 (지금: {v}). 그래도 덮인 값({o})으로 되돌릴까요?', { v: cellText(now), o: cellText(c.remote) }))) return;
      if (c.remote === null || c.remote === undefined) delete t.obj[t.key]; else t.obj[t.key] = JSON.parse(JSON.stringify(c.remote));
      if (t.kind === 'workers') { state.workers = E.normalizeWorkers(state.workers); saveWorkers(); }
      else { state.settings = E.sanitizeSettings(state.settings); saveJson(KEYS.settings, state.settings); applySettings(); renderBank(); renderHealth(); }
      loadSelected(); recalcPayroll(); renderRoster();
      showToast(tr('덮인 값으로 되돌렸어요.'));
    } else showToast(tr('저장된 값으로 확정했어요.'));
    saveJson(KEYS.conflicts, list.filter(function (x) { return x.id !== id; }));
    renderConflicts();
  }

  var shownNotice = '';
  /* 출퇴근 화면(잠금 상태 포함)에 구글 저장 연결 상태 표시 */
  function renderPunchCloud(connected, kind, clock) {
    var el = $('punchCloud');
    if (!el) return;
    if (connected === undefined) {   // 주기 갱신: 지금 상태로 다시 그림
      var C = window.AlbaCloud, st = C && C.getStatus ? C.getStatus() : null;
      connected = !!(st && st.connected); kind = st ? st.kind : 'off'; clock = fmtClock(st && st.lastSaved);
    }
    var waiting = loadQueue().length;
    var more = waiting ? tr(' · 시트에 아직 안 올라간 출퇴근 {n}건', { n: waiting }) : '';
    var cls = 'punch-cloud', txt;
    if (!connected) { cls += ' bad'; txt = tr('⚠️ 구글 로그인이 안 되어 있어요 · 지금은 이 기기에만 저장돼요. 사장님이 구글 연동을 해 주세요'); }
    else if (kind === 'needLogin' || kind === 'error') { cls += ' bad'; txt = tr('⚠️ 구글 로그인이 풀렸어요 · 화면을 누르면 다시 연결을 시도해요. 안 되면 사장님이 [다시 연결]을 눌러 주세요 (출퇴근은 이 기기에 저장돼요)') + more; }
    else if (kind === 'saving') { txt = tr('⏳ 구글 시트에 저장 중…') + more; }
    else { cls += waiting ? '' : ' ok'; txt = (waiting ? tr('⏳ 구글 시트 연결됨') : tr('✅ 구글 시트 연결됨')) + (clock ? tr(' · 마지막 저장 {c}', { c: clock }) : '') + more; }
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

    if (!connected && kind !== 'saving') { btn.textContent = tr('구글 저장'); btn.className = 'cloud-btn'; }
    else if (kind === 'saving') { btn.textContent = tr('저장 중…'); btn.className = 'cloud-btn'; }
    else if (kind === 'needLogin' || kind === 'error') { btn.textContent = tr('⚠️ 다시 연결'); btn.className = 'cloud-btn bad'; }
    else { btn.textContent = tr('저장됨') + (clock ? ' ' + clock : ''); btn.className = 'cloud-btn ok'; }
    var pmc = $('pmCloud');
    if (pmc) {
      pmc.textContent = btn.textContent;
      pmc.classList.toggle('is-ok', btn.classList.contains('ok'));
      pmc.classList.toggle('is-bad', btn.classList.contains('bad'));
    }

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
    if (!C) { var b = $('cloudBtn'); if (b) b.hidden = true; var pmc = $('pmCloud'); if (pmc) pmc.hidden = true; return; }
    C.init({
      getData: cloudData,
      getTables: cloudTables,
      applyData: cloudApply,
      replayPunchLog: replayPunchLog,
      confirm: function (m) { return window.confirm(m); },
      getAdminPin: function () { return getPin(); },
      isBusy: cloudBusy,
      version: E.ENGINE_VERSION || '',
      describeOps: describeOps,
      describeFail: function (path) { return tr('그 사이 바뀜') + ' – ' + opText({ path: path, before: null, after: null }).split(':')[0]; },
      onDevice: function () {
        setTimeout(function () {
          renderDevice(); renderPunch(); renderPunchCloud();
          if (isRequester()) adoptSheetPin();
        }, 0);
      },
      onRequest: function (ev) { setTimeout(function () { onRequestEvent(ev); }, 0); },
      onRequestsApplied: function (before, after) {
        // 요청으로 지워진 알바생은 출퇴근 장부에서도 지움 (출퇴근 기기에서만)
        var keep = {};
        ((after && after.workers) || []).forEach(function (w) { keep[w.code] = true; });
        var gone = ((before && before.workers) || []).filter(function (w) { return w.code && !keep[w.code]; }).map(function (w) { return w.code; });
        if (gone.length) setTimeout(function () { purgePunchRows(gone); }, 0);
      },
      onConflicts: function (n) {
        setTimeout(function () {
          renderConflicts();
          showToast(tr('⚠️ 다른 기기와 수정이 겹친 곳이 {n}건 있어요. 급여 계산 탭 맨 위에서 확인해 주세요.', { n: n }), true);
        }, 0);
      },
      onStatus: function (st) {
        renderCloudUi(st);
        renderDevice();
        if (st && st.kind === 'saved') {
          flushPunchQueue(); retryPurges();
          if (!firstSyncDone) { firstSyncDone = true; runAutoClose(); renderPunch(); renderWorkNow(); }   // 로그인이 풀려 있다 다시 연결돼 처음 동기화된 때
        }
      }
    });
    // 다른 기기(갤럭시·아이패드 등)가 저장한 내용을 30초마다, 화면으로 돌아올 때 받아옴
    setInterval(function () { if (!document.hidden && C.refresh) C.refresh(); }, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden && C.refresh) C.refresh(); });
    window.addEventListener('focus', function () { if (C.refresh) C.refresh(); });
    // 화면을 누르는 순간(사용자 동작)에 구글 로그인을 조용히 갱신: 타이머 갱신은 브라우저가 막아서 1시간쯤 뒤 풀리는 문제 대응
    document.addEventListener('click', function (ev) { if (ev && ev.isTrusted && C.renewOnGesture) C.renewOnGesture(); }, true);   // 실제 손가락·마우스 클릭만 (코드가 누른 클릭은 팝업이 막혀 시도만 낭비)

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
        C.connect().then(function (ok) { if (ok) { showToast(tr('구글 시트 연동 완료')); adoptSheetPin(); } });
      } else if (act === 'save') {
        C.saveNow().then(function (ok) { if (ok) showToast(tr('구글 시트에 저장했습니다')); });
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
  var punchState = { unlocked: false, target: null, resultTimer: null, idleTimer: null };

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
    // 아이콘은 CSS(.lock-btn::before). "관리자"는 시트 탭 이름으로도 쓰여 사전에 넣지 않고 언어별 글자를 바로 넣는다
    var enL = E.getLang() === 'en';
    $('lockBtn').textContent = locked ? (enL ? 'Admin' : '관리자') : (enL ? 'Lock' : '잠그기');
    $('lockBtn').classList.toggle('is-open', !locked);
    var pml = $('pmLock');
    if (pml) { pml.hidden = !pin; pml.textContent = $('lockBtn').textContent; }
    if (typeof healthDay === 'string' && $('bellBtn')) { renderHealth(); if (locked) closeHealth(); }
    $('pinState').textContent = (pin ? tr('· 설정됨') : tr('· 아직 없음')).replace(/^·\s*/, '');
    if (locked) openTab('punch');
  }

  /* 줄 돈 보기/숨김 상태를 버튼 글자·바 금액에 맞춘다(토글, 계산, 언어 바꿈, 잠금 때마다).
     숨김일 때는 바에 금액을 아예 넣지 않는다 — 글자 크기 0으로 가리기만 하면 스크린 리더·복사·찾기에 금액이 남는다 */
  var EYE_SVG = {
    open: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    off: '<path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.3"/><path d="M6.6 6.6A16.5 16.5 0 0 0 2 12s3.5 7 10 7a10.4 10.4 0 0 0 4.1-.8"/>'
  };
  function syncMoneyUi() {
    var on = document.body.classList.contains('money-show');
    var t = $('moneyToggle');
    if (t) t.setAttribute('aria-expanded', on ? 'true' : 'false');
    if ($('moneyToggleTitle')) $('moneyToggleTitle').textContent = on ? tr('줄 돈 숨기기') : tr('줄 돈 보기');
    var b = $('moneyBarBtn');
    if (b) {
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      var bt = $('moneyBarBtnText');
      if (bt) bt.textContent = on ? tr('숨기기') : tr('보기');
      else b.textContent = on ? tr('숨기기') : tr('보기');
      var eye = $('moneyBarEye');
      if (eye) eye.innerHTML = on ? EYE_SVG.off : EYE_SVG.open;
    }
    var a = $('moneyBarAmt');
    if (a) a.textContent = on && state.payroll ? E.moneyText(state.payroll.net) : '';
    var subText = '';
    if (on && state.payroll) {
      var r = state.payroll;
      var wkPaid = (r.weeks || []).filter(function (w) { return w.eligible; }).length;
      subText = tr('시급 {w} · 주휴 {wk} · ', { w: E.moneyText(r.hourlyWage), wk: r.includeWeekly ? tr('{n}주', { n: wkPaid }) : tr('미포함') }) +
        (r.includeMeal ? tr('식대 {n}회 · ', { n: r.mealDays }) : '') + r.tax.label;
    }
    if ($('moneyBarSub')) $('moneyBarSub').textContent = subText;
    if ($('moneyBarDrawerSub')) $('moneyBarDrawerSub').textContent = subText;
    fillMoney();
  }

  /* 명단 카드·합계 금액(.m-amt[data-amt]): [줄 돈 보기]일 때만 글자로 넣고, 숨김일 때는 비운다.
     (비운 칸은 CSS ::after가 •••••원으로 보여 준다. 글자 크기 0으로만 가리면 스크린 리더·복사·찾기에 금액이 남는다) */
  function fillMoney() {
    var on = document.body.classList.contains('money-show');
    Array.prototype.forEach.call(document.querySelectorAll('.m-amt[data-amt], .m-amt-hide[data-amt]'), function (el) {
      el.textContent = on ? el.getAttribute('data-amt') : '';
    });
  }

  function lockNow() {
    if (!getPin()) return;
    punchState.unlocked = false;
    markUnlocked(false);
    setWorkerPick(false);
    document.body.classList.remove('money-show');   // 잠갔다 풀었을 때 금액이 열린 채로 남지 않게
    syncMoneyUi();
    if (punchState.idleTimer) { clearTimeout(punchState.idleTimer); punchState.idleTimer = null; }
    document.body.classList.remove('set-open', 'add-open', 'slip-open', 'export-open', 'roster-open', 'modal-open');
    $('sheetBackdrop').hidden = true;
    $('dayModal').hidden = true;
    $('cloudModal').hidden = true;
    closeAdminPin();   // 열려 있던 비밀번호 창과 '확인 후 할 일'(afterPin)도 버림 — 다음 잠금 해제 때 엉뚱한 일이 실행되지 않게
    closeBank(); closeHealth();
    if (!$('punchPw').hidden) closePunchPw();
    applyLockUi();
  }

  /* 비밀번호 연속 실패 잠금: 새로고침해도 풀리지 않게 이 기기에 기억 */
  function pinLock(kind) {
    var v = loadJson('alba.pinLock.' + kind, null);
    return v && typeof v === 'object' ? { fails: Number(v.fails) || 0, until: Number(v.until) || 0 } : { fails: 0, until: 0 };
  }
  function lockLeft(kind) { var l = pinLock(kind), left = l.until - Date.now(); return left > 0 && left < 3600000 ? Math.ceil(left / 1000) : 0; }
  function noteFail(kind, ms) {   // → 이번 실패로 잠겼으면 true
    var l = pinLock(kind);
    l.fails++;
    var locked = l.fails >= 5;
    if (locked) { l.until = Date.now() + ms; l.fails = 0; }
    try { localStorage.setItem('alba.pinLock.' + kind, JSON.stringify(l)); } catch (e) {}
    return { locked: locked, n: locked ? 5 : l.fails };
  }
  function clearFails(kind) { try { localStorage.removeItem('alba.pinLock.' + kind); } catch (e) {} }

  function bumpIdle(ev) {
    // 출퇴근 화면·화면 보호기에서의 터치(알바생)는 사장님 잠금 해제 시간을 늘리지 않음
    if (ev && ev.target && ev.target.closest && ev.target.closest('#tab-punch, #saver, #punchPw, #punchResult')) return;
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
  /* 대기 줄 하나 = {id, row}. 예전 버전은 row(7칸 배열)만 저장했으므로 읽을 때 id를 붙임 */
  var queueSeq = 0;
  function queueId() { return Date.now().toString(36) + '-' + (queueSeq++).toString(36) + '-' + Math.random().toString(36).slice(2, 8); }
  function loadQueue() {
    var q = loadJson(QUEUE_KEY, []);
    if (!Array.isArray(q)) return [];
    return q.map(function (x) {
      if (Array.isArray(x)) return { id: 'old-' + JSON.stringify(x), row: x };
      return x && Array.isArray(x.row) ? { id: String(x.id || queueId()), row: x.row } : null;
    }).filter(Boolean);
  }
  function saveQueue(q) { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); return true; } catch (e) { storageFull(); return false; } }
  function enqueuePunch(row) {
    if (isRequester()) return;   // 출퇴근 장부는 출퇴근 기기만 씀
    var q = loadQueue();
    // 비밀번호 오류 기록은 최근 50건만 대기 (오프라인 중 마구 틀려도 실제 출퇴근 기록이 밀려나지 않게)
    if (row && row[5] === '비밀번호 오류') {
      var fails = q.filter(function (x) { return x.row && x.row[5] === '비밀번호 오류'; });
      if (fails.length >= 50) { var drop = fails[0]; q = q.filter(function (x) { return x !== drop; }); }
    }
    q.push({ id: queueId(), row: row });
    if (q.length > 500) showToast(tr('⚠️ 시트에 못 올린 출퇴근 기록이 500건을 넘어 가장 오래된 기록부터 지워져요. 구글 로그인을 확인해 주세요.'), true);
    saveQueue(q.slice(-500));
    renderPunchCloud();
    flushPunchQueue();
  }
  function flushPunchQueue() {
    var C = window.AlbaCloud;
    if (queueBusy || !C || !C.isConnected() || !C.appendPunch) return;
    var q = loadQueue();
    if (!q.length) return;
    queueBusy = true;
    var sent = {}, more = false;
    q.forEach(function (x) { sent[x.id] = true; });
    C.appendPunch(q.map(function (x) { return x.row; })).then(function () {
      // 보낸 줄만 지움 (보내는 사이 새로 찍힌 줄·지워진 줄이 있어도 순서와 상관없이 정확히)
      var rest = loadQueue().filter(function (x) { return !sent[x.id]; });
      saveQueue(rest);
      more = rest.length > 0;
    }).catch(function () { /* 다음 저장 때 다시 시도 */ }).then(function () { queueBusy = false; renderPunchCloud(); if (more) flushPunchQueue(); });
  }

  /* 지운 알바생의 출퇴근 장부 줄도 지운다 (이 기기에 쌓인 대기분 + 구글 시트). codes가 null이면 전부 */
  function purgePunchRows(codes) {
    if (isRequester()) return;   // 장부는 출퇴근 기기만 지움 (요청이 반영될 때 출퇴근 기기가 지움)
    var q = loadQueue().filter(function (x) { return codes && codes.indexOf(String(x.row[1])) < 0; });
    saveQueue(q);
    // 시트에서 지우는 일은 로그인이 풀려 있거나 실패하면 보관했다가, 다음에 저장이 성공할 때 다시 시도
    var p = loadPurges();
    p.push({ codes: codes, before: tsOf(new Date()) });
    savePurges(p);
    retryPurges();
  }
  var PURGE_KEY = 'alba.punchPurge', purgeBusy = false;
  function loadPurges() { try { var v = JSON.parse(localStorage.getItem(PURGE_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function savePurges(p) { try { if (p.length) localStorage.setItem(PURGE_KEY, JSON.stringify(p.slice(-50))); else localStorage.removeItem(PURGE_KEY); } catch (e) {} }
  function retryPurges() {
    var C = window.AlbaCloud;
    if (purgeBusy || !C || !C.isConnected() || !C.purgePunchLog) return;
    var p = loadPurges();
    if (!p.length) return;
    purgeBusy = true;
    var job = p[0];
    C.purgePunchLog(job.codes, job.before).then(function (ok) {
      purgeBusy = false;
      if (!ok) return;
      var rest = loadPurges();
      if (rest.length && JSON.stringify(rest[0]) === JSON.stringify(job)) rest.shift();
      savePurges(rest);
      if (rest.length) retryPurges();
    }, function () { purgeBusy = false; });
  }

  /* 시트 '출퇴근기록' 장부로 출근/퇴근 상태 복구 (다시 로그인·불러오기 뒤) */
  function replayPunchLog(rows, afterMs) {
    // 너무 오래된 줄은 건너뜀: 지운 기록의 옛 장부가 되살아나는 것을 막는다 (최근 48시간만)
    var n = E.replayPunchLog(state.workers, rows, Math.max(afterMs, Date.now() - 48 * 3600 * 1000), punchOpts());
    if (n) {
      saveWorkers();
      loadSelected(); recalcPayroll(); renderRoster();
      showToast(tr('출퇴근 기록 {n}건을 시트 기록에서 복구했습니다', { n: n }));
    }
  }

  /* 자정까지 퇴근을 안 찍은 사람은 그날 출근을 무효(휴무)로 처리 */
  var firstSyncDone = false;   // 연동된 기기는 켜질 때 시트를 먼저 받은 뒤에 자동 퇴근을 판단 (오래 꺼 둔 기기의 옛 '근무 중'으로 잘못 처리하지 않게)
  function runAutoClose() {
    if (isRequester()) return;   // 자동 퇴근은 출퇴근 기기만
    var C0 = window.AlbaCloud;
    if (!firstSyncDone && C0 && C0.getStatus && C0.getStatus().connected) return;
    var done = E.autoCloseOpen(state.workers, new Date(), autoOut());
    if (!done.length) return;
    saveWorkers();
    loadSelected(); recalcPayroll(); renderRoster(); renderPending();
    done.forEach(function (d) {
      enqueuePunch([tsOf(d.ts), d.worker.code, d.worker.name, '퇴근누락(확인필요)', '자동(마감)', '정상(자동)', '자동 퇴근 시각까지 퇴근을 찍지 않아 퇴근 처리. 근무(' + d.date + ' ' + d.start + ' 출근)는 기록하지 않고 확인 필요로 남김']);
    });
    showToast(tr('퇴근을 안 찍은 {n}님은 자동 퇴근 처리했어요. 급여 화면 [퇴근 확인 필요]에서 퇴근 시각을 넣어 주세요.', { n: done.map(function (d) { return d.worker.name; }).join(', ') }));
  }

  /* ---------- 앱 공유 (QR · 주소 복사 · 공유) ---------- */
  var SHARE_URL = 'https://kimminho93.github.io/alba-manager/';
  function initShare() {
    var copy = $('btnShareCopy'), share = $('btnShare');
    if (!copy) return;
    copy.addEventListener('click', function () {
      var done = function () { showToast(tr('주소를 복사했어요. 카톡 등에 붙여넣으세요.')); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(SHARE_URL).then(done, function () { fallbackCopy(); done(); });
      } else { fallbackCopy(); done(); }
    });
    function fallbackCopy() {
      var t = document.createElement('textarea');
      t.value = SHARE_URL; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(t);
    }
    if (navigator.share) {
      share.hidden = false;
      share.addEventListener('click', function () {
        navigator.share({ title: tr('사장님 도우미'), text: tr('알바 출퇴근 · 급여 정산 · 위생 점검'), url: SHARE_URL }).catch(function () {});
      });
    }
  }

  /* ---------- 새 버전 자동 적용 ----------
     매장 기기는 며칠씩 켜 두므로, 새 버전이 올라오면 아무도 쓰지 않는 안전한 순간에 스스로 새로고침한다.
     (기록은 모두 이 기기 저장소와 구글 시트에 있어 새로고침해도 사라지지 않음) */
  var update = { cur: '', next: '', checking: false };
  function curBuild() {
    var s = document.querySelector('script[src*="app.js?v="]');
    var m = s && /app\.js\?v=(\d+)/.exec(s.getAttribute('src'));
    return m ? m[1] : '';
  }
  function checkUpdate() {
    if (update.checking || !update.cur || !window.fetch || location.protocol === 'file:') return;
    update.checking = true;
    fetch('./index.html?nc=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : ''; }).then(function (t) {
      var m = /app\.js\?v=(\d+)/.exec(t || '');
      if (m && m[1] > update.cur) update.next = m[1];
    }).catch(function () {}).then(function () { update.checking = false; });
  }
  function updateSafeNow() {
    if (!update.next) return false;
    var openIds = ['punchPw', 'punchResult', 'adminPin', 'cloudModal', 'sheetBackdrop', 'dayModal', 'healthModal', 'bankModal', 'pinSetup'];
    for (var i = 0; i < openIds.length; i++) { var el = $(openIds[i]); if (el && !el.hidden) return false; }
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
    if (Date.now() - saverState.last < 60000) return false;   // 1분 동안 아무도 안 만졌을 때만
    var C = window.AlbaCloud, st = C && C.getStatus ? C.getStatus() : null;
    if (st && st.kind === 'saving') return false;
    if (queueBusy || purgeBusy) return false;
    if (navigator.onLine === false) return false;   // 인터넷이 끊긴 순간 새로고침하면 빈 화면이 뜨므로
    try {   // 같은 버전으로 계속 새로고침하는 일 방지 (10분에 한 번만 시도)
      var tried = JSON.parse(sessionStorage.getItem('alba.updTried') || 'null');
      if (tried && tried.v === update.next && Date.now() - tried.t < 600000) return false;
      sessionStorage.setItem('alba.updTried', JSON.stringify({ v: update.next, t: Date.now() }));
      sessionStorage.setItem('alba.updFrom', update.cur);
    } catch (e) {}
    return true;
  }
  function initUpdate() {
    update.cur = curBuild();
    try {
      var from = sessionStorage.getItem('alba.updFrom');
      if (from && update.cur && update.cur !== from) {
        sessionStorage.removeItem('alba.updFrom');
        setTimeout(function () { showToast(tr('새 버전으로 바뀌었어요 · v{v}', { v: window.ALBA_VERSION || '' })); }, 800);
      }
    } catch (e) {}
    setTimeout(checkUpdate, 60000);
    setInterval(checkUpdate, 10 * 60000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkUpdate(); });
    setInterval(function () { if (updateSafeNow()) location.reload(); }, 15000);
  }

  /* ---------- 사용 방법: 바로가기 · 검색 · 모두 펼치기 ---------- */
  function initGuide() {
    var list = $('guideList');
    if (!list) return;
    var items = function () { return Array.prototype.slice.call(list.querySelectorAll('.guide-item')); };
    var nav = document.querySelector('.guide-nav');
    if (nav) nav.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-guide-go]');
      if (!b) return;
      var it = $(b.getAttribute('data-guide-go'));
      if (!it) return;
      $('guideSearch').value = ''; applyFilter();
      it.open = true;
      it.scrollIntoView({ behavior: 'smooth', block: 'start' });
      it.classList.remove('guide-flash'); void it.offsetWidth; it.classList.add('guide-flash');
    });
    function syncToggle() {
      var all = items().filter(function (x) { return !x.hidden; });
      var allOpen = all.length && all.every(function (x) { return x.open; });
      $('guideToggleAll').textContent = allOpen ? tr('모두 접기') : tr('모두 펼치기');
    }
    function applyFilter() {
      var q = $('guideSearch').value.trim().toLowerCase();
      var shown = 0;
      items().forEach(function (it) {
        var hit = !q || it.textContent.toLowerCase().indexOf(q) >= 0;
        it.hidden = !hit;
        if (hit) shown++;
        if (q && hit) it.open = true;
      });
      $('guideEmpty').hidden = shown > 0;
      syncToggle();
    }
    $('guideSearch').addEventListener('input', applyFilter);
    $('guideToggleAll').addEventListener('click', function () {
      var all = items().filter(function (x) { return !x.hidden; });
      var open = !all.every(function (x) { return x.open; });
      all.forEach(function (x) { x.open = open; });
      syncToggle();
    });
    list.addEventListener('toggle', syncToggle, true);
    window.addEventListener('alba:lang', syncToggle);
    syncToggle();
  }

  /* ---------- 퇴근 확인 필요 (자동 퇴근된 근무) ---------- */
  function renderPending() {
    var box = $('pendingBox');
    if (!box) return;
    var items = [];
    state.workers.forEach(function (w) {
      (w.pending || []).forEach(function (p, i) { items.push({ w: w, p: p, i: i }); });
    });
    if (!items.length) { box.hidden = true; box.innerHTML = ''; box.removeAttribute('data-sig'); return; }
    // 같은 내용이면 다시 그리지 않음 (넣고 있던 퇴근 시각이 지워지지 않게). 다시 그려도 넣던 값은 살림
    var sig = JSON.stringify([E.getLang(), items.map(function (x) { return [x.w.id, x.w.name, x.p.id || (x.p.date + ' ' + x.p.start), x.p.end || '']; })]);
    if (!box.hidden && box.getAttribute('data-sig') === sig) return;
    var typed = {}, focusKey = null;
    box.querySelectorAll('[data-pending-time]').forEach(function (el) {
      if (el.value) typed[el.getAttribute('data-pending-time')] = el.value;
      if (el === document.activeElement) focusKey = el.getAttribute('data-pending-time');
    });
    var wasOpen = !!(box.querySelector('details.pending-det[open]'));
    var first = items[0];
    var firstDate = Number(first.p.date.slice(5, 7)) + '.' + Number(first.p.date.slice(8));
    var sumHead = tr('퇴근 확인 필요 {n}건', { n: items.length }) + ' · ' + escName(first.w.name) + ' <span class="num">' + escHtml(firstDate) + '</span>' +
      (items.length > 1 ? ' ' + tr('외 {n}건', { n: items.length - 1 }) : '');
    box.innerHTML = '<details class="pending-det"' + (wasOpen ? ' open' : '') + '>' +
      '<summary class="pending-sum">' +
        '<svg class="warn-ico" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/></svg>' +
        '<span class="pending-sum-txt">' + sumHead + '</span>' +
        '<span class="pending-sum-end"><span class="pending-sum-cta">' + tr('시각 수정') + '</span>' +
          '<svg class="pending-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg></span>' +
      '</summary>' +
      '<div class="pending-body">' +
        '<p class="pending-note">' + tr('퇴근을 안 찍어 자동 퇴근된 근무예요. 실제 퇴근 시각을 넣으면 달력에 기록돼요. 일하지 않았으면 [근무 없음]을 누르세요.') + '</p>' +
        items.map(function (x) {
          var d = x.p.date, wd = E.dayName((new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8))).getDay() + 6) % 7);
          var rawKey = x.w.id + '|' + (x.p.id || (x.p.date + ' ' + x.p.start));
          var key = escHtml(rawKey);
          var val = typed[rawKey] || x.p.end || '';
          return '<div class="pending-row">' +
            '<div class="pending-who"><b>' + escName(x.w.name) + '</b> · ' + tr('{m}월 {d}일 ({w}) {t} 출근', { m: Number(d.slice(5, 7)), d: Number(d.slice(8)), w: wd, t: escHtml(x.p.start) }) + '</div>' +
            '<div class="pending-act">' +
              '<input type="time" class="pending-time" data-pending-time="' + key + '" value="' + escHtml(val) + '" aria-label="' + escHtml(tr('퇴근 시각')) + '">' +
              '<button type="button" class="btn btn-primary" data-pending-ok="' + key + '">' + tr('퇴근 기록') + '</button>' +
              '<button type="button" class="btn" data-pending-no="' + key + '">' + tr('근무 없음') + '</button>' +
            '</div></div>';
        }).join('') +
      '</div></details>';
    box.hidden = false;
    box.setAttribute('data-sig', sig);
    if (focusKey) box.querySelectorAll('[data-pending-time]').forEach(function (el) { if (el.getAttribute('data-pending-time') === focusKey) el.focus(); });
  }
  function pendingTarget(key) {
    var k = String(key), cut = k.indexOf('|');
    var wid = k.slice(0, cut), pid = k.slice(cut + 1);
    var w = state.workers.filter(function (x) { return x.id === wid; })[0];
    if (!w) return null;
    var i = -1;
    (w.pending || []).forEach(function (p, j) { if ((p.id || (p.date + ' ' + p.start)) === pid) i = j; });
    return i >= 0 ? { w: w, i: i } : null;
  }
  function onPendingClick(ev) {
    var ok = ev.target.closest('[data-pending-ok]'), no = ev.target.closest('[data-pending-no]');
    if (!ok && !no) return;
    var key = (ok || no).getAttribute(ok ? 'data-pending-ok' : 'data-pending-no');
    var t = pendingTarget(key);
    if (!t || !t.w.pending || !t.w.pending[t.i]) { renderPending(); return; }
    var p = t.w.pending[t.i];
    if (ok) {
      var inp = null;
      $('pendingBox').querySelectorAll('[data-pending-time]').forEach(function (el) { if (el.getAttribute('data-pending-time') === key) inp = el; });
      var end = inp ? inp.value : '';
      if (!/^\d{2}:\d{2}$/.test(end)) { showToast(tr('퇴근 시각을 넣어 주세요.')); if (inp) inp.focus(); return; }
      var r = E.resolvePending(t.w, t.i, end);
      if (!r.ok) { showToast(r.error); return; }
      enqueuePunch([tsOf(new Date()), t.w.code, t.w.name, '퇴근확인', '사장님 입력', '확인', p.date + ' ' + p.start + '~' + end + ' 근무로 기록']);
      showToast(tr('{n}님 {d} 근무를 {s}~{e}로 기록했어요.', { n: t.w.name, d: p.date.slice(5).replace('-', '/'), s: p.start, e: end }));
    } else {
      if (!window.confirm(tr('{n}님 {d} {s} 출근을 근무 없음으로 정리할까요?', { n: t.w.name, d: p.date.slice(5).replace('-', '/'), s: p.start }))) return;
      E.dismissPending(t.w, t.i);
      enqueuePunch([tsOf(new Date()), t.w.code, t.w.name, '퇴근확인', '사장님 입력', '근무 없음', p.date + ' ' + p.start + ' 출근을 근무 없음으로 정리']);
      showToast(tr('근무 없음으로 정리했어요.'));
    }
    saveWorkers();
    loadSelected(); recalcPayroll(); renderRoster(); renderPending(); renderPunch();
  }


  /* ---------- 화면 보호기 (번인 방지) ---------- */
  var EGG_TEXT = '진주 경상대점 맘스터치 점장님 짱 ✨';   // 이스터에그 문구 (언어와 상관없이 그대로)
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
    var remote = isRequester();
    var rb = $('punchRemote');
    if (rb) {
      var dv = window.AlbaCloud && window.AlbaCloud.deviceInfo ? window.AlbaCloud.deviceInfo().dev : {};
      rb.hidden = !remote;
      if (remote) rb.innerHTML = tr('📍 출퇴근은 <b>{n}</b>에서 찍어요. 이 기기에서는 근무 현황만 볼 수 있어요.', { n: escHtml(dv.name || tr('매장 기기')) });
      $('punchTitle').hidden = remote;
    }
    if (allBtn) {
      var nOn = state.workers.filter(function (w) { return E.punchNext(w, now) === 'out'; }).length;
      allBtn.hidden = nOn < 1 || remote;
      allBtn.textContent = tr('근무 중 {n}명 모두 퇴근', { n: nOn });
    }
    if (!state.workers.length) {
      box.innerHTML = '<p class="punch-empty">' + tr('등록된 알바생이 없습니다.<br>사장님께 알려 주세요.') + '</p>';
      return;
    }
    // 근무 중인 사람을 맨 위로 (출근한 순서대로), 나머지는 등록한 순서 그대로
    var order = workingFirstOrder().map(function (i) { var w = state.workers[i]; return { w: w, on: E.punchNext(w, now) === 'out' }; });
    // 시안 I: 줄 = [이름(+근무 중 점) / 한 줄 상태] + 오른쪽 출근·퇴근 표시. 줄 전체가 버튼인 것은 그대로(data-punch)
    box.innerHTML = order.map(function (o) {
      var w = o.w;
      var working = o.on;
      var pend = (w.pending || []).length ? '<span class="punch-chip warn">' + tr('⚠️ 퇴근 확인 필요') + '</span>' : '';
      var main = '<span class="punch-main"><span class="punch-name">' + escName(w.name) +
        (working ? '<span class="punch-dot" aria-hidden="true"></span>' : '') + '</span>' +
        '<span class="punch-sub">' + punchSubText(w, working, now) + '</span>' + pend + '</span>';
      // "출근"/"퇴근" 사전 키는 엑셀 머리글(In/Out)과 같이 쓰므로 여기서는 사전을 쓰지 않고 언어별 글자를 바로 넣는다
      var en = E.getLang() === 'en';
      var act = '<span class="punch-act' + (working ? ' out' : '') + '" data-no-i18n>' + (working ? (en ? 'Clock out' : '퇴근') : (en ? 'Clock in' : '출근')) + '</span>';
      if (remote) return '<div class="punch-row view' + (working ? ' on' : '') + '">' + main + '</div>';
      return '<button type="button" class="punch-row' + (working ? ' on' : '') + '" data-punch="' + escHtml(w.id) + '">' + main + act + '</button>';
    }).join('');
  }

  /* 출퇴근 줄의 한 줄 상태: "09:00 출근 · 41분째" / "18:02 퇴근" / "오늘 기록 없음" (읽기만 한다) */
  function punchSubText(w, working, now) {
    if (working && w.punch) {
      var at = new Date(w.punch.date + 'T' + (w.punch.at || w.punch.time) + ':00');
      var mins = Math.max(0, Math.floor((now.getTime() - at.getTime()) / 60000));
      var d = mins < 60 ? tr('{n}분째', { n: mins }) : tr('{h}시간 {m}분째', { h: Math.floor(mins / 60), m: mins % 60 });
      return tr('{t} 출근 · {d}', { t: escHtml(w.punch.time), d: d });
    }
    try {
      var ym = now.getFullYear() + '-' + pad2(now.getMonth() + 1);
      var sh = (E.workerShifts(w, ym) || [])[now.getDate() - 1];
      if (sh && !sh.off && sh.end) return tr('{t} 퇴근', { t: escHtml(sh.end) });
    } catch (e) { /* 기록을 못 읽어도 출퇴근 화면은 계속 보여야 한다 */ }
    return tr('오늘 기록 없음');
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
    if (isRequester()) { closePunchPw(); renderPunch(); return; }
    // 창이 열려 있는 사이 시트에서 불러오기가 일어나 사람 객체가 바뀌었을 수 있으니 같은 사람을 다시 찾는다
    w = state.workers.filter(function (x) { return x.id === w.id; })[0];
    if (!w) { closePunchPw(); renderPunch(); return; }
    punchState.target = w;
    var now = new Date();
    if (lockLeft('punch')) {
      $('punchPwErr').textContent = tr('잠시 후에 다시 해 주세요. ({n}초)', { n: lockLeft('punch') });
      return;
    }
    var typed = $('punchPwInput').value.trim();
    if (!w.password) { $('punchPwErr').textContent = tr('이 알바생은 아직 비밀번호가 없어요. 사장님께 알려 주세요. (급여 계산 → 설정에서 정할 수 있어요)'); return; }
    if (!typed || typed !== w.password) {
      var nf = noteFail('punch', 30000);
      enqueuePunch([tsOf(now), w.code, w.name, '', '이름+비밀번호', '비밀번호 오류', nf.n + '번째 연속 실패']);
      if (nf.locked) {
        $('punchPwErr').textContent = tr('여러 번 틀렸어요. 30초 뒤에 다시 해 주세요.');
      } else {
        $('punchPwErr').textContent = tr('비밀번호가 맞지 않아요.');
      }
      $('punchPwInput').value = '';
      $('punchPwInput').focus();
      return;
    }
    clearFails('punch');
    runAutoClose();   // 어제 퇴근 안 찍은 사람이 있으면 먼저 자정 퇴근으로 정리
    var r = E.applyPunch(w, now, punchOpts());
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
    if (isRequester()) return;
    runAutoClose();
    var now = new Date();
    var on = state.workers.filter(function (w) { return E.punchNext(w, now) === 'out'; });
    if (!on.length) { showToast(tr('지금 근무 중인 사람이 없어요.')); renderPunch(); return; }
    var go = function () {
      var names = on.map(function (w) { return w.name; }).join(', ');
      if (!window.confirm(tr('근무 중인 {n}명({names})을 지금 한꺼번에 퇴근 처리할까요?\n퇴근 시각은 {t} 기준으로 {u} 기록돼요.', { n: on.length, names: names, t: hmText(pad2(now.getHours()) + ':' + pad2(now.getMinutes())), u: punchOpts().outMode === 'exact' ? tr('그대로') : tr('{n}분 단위로 내려서', { n: punchUnit() }) }))) return;
      doBulkOut();
    };
    if (getPin()) { punchState.afterPin = go; openAdminPin(); }   // 관리자 비밀번호가 있으면 사장님만
    else go();
  }
  function doBulkOut() {
    if (isRequester()) return;
    runAutoClose();   // 자동 퇴근 시각이 지난 근무부터 정리 (그 사람에게 새 출근이 찍히지 않게)
    var now = new Date();
    var done = E.applyPunchAll(state.workers, now, punchOpts());
    if (!done.length) { showToast(tr('지금 근무 중인 사람이 없어요.')); renderPunch(); return; }
    saveWorkers();
    loadSelected(); recalcPayroll(); renderRoster();
    done.forEach(function (d) {
      enqueuePunch([tsOf(now), d.worker.code, d.worker.name, '퇴근', '일괄 퇴근(관리자)', d.result.note ? '정상(참고)' : '정상', d.result.note]);
    });
    playChime(false);
    $('punchResIcon').innerHTML = THEME_ICON.moon;   // 이모지 대신 선 아이콘(고정 SVG)
    $('punchResTitle').textContent = tr('{n}명 퇴근했어요. 수고하셨어요!', { n: done.length });
    $('punchResWho').textContent = done.map(function (d) { return d.worker.name; }).join(', ');
    $('punchResStats').innerHTML = done.map(function (d) {
      var r = d.result, w = d.worker;
      var sh = r.empty ? null : E.workerShifts(w, r.date.slice(0, 7))[Number(r.date.slice(8)) - 1];
      var hrs = sh && !sh.off ? fmtHM(E.calcShiftHours(sh.start, sh.end, sh.breakMinutes)) : fmtHM(0);
      return '<div>' + escName(w.name) + ' · ' + (r.held ? tr('확인 필요') : r.empty ? tr('근무 0시간') : escHtml(r.start + '~' + r.end) + ' (' + hrs + ')') + '</div>';
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
    $('punchResIcon').innerHTML = isIn ? THEME_ICON.sun : THEME_ICON.moon;   // 출근 = 해, 퇴근 = 달(고정 SVG)
    $('punchResTitle').textContent = isIn ? tr('출근했어요') : tr('퇴근했어요. 수고하셨어요!');
    $('punchResWho').textContent = tr('{n}님 · {t}', { n: w.name, t: hmText(isIn ? r.start : r.end) });
    var lines = [];
    if (!isIn) {
      var sh = r.empty ? null : E.workerShifts(w, pm)[Number(r.date.slice(8)) - 1];
      if (sh && !sh.off) lines.push('<div>' + tr('오늘 <b>{h}</b> 일했어요 ({s}~{e})', { h: fmtHM(E.calcShiftHours(sh.start, sh.end, sh.breakMinutes)), s: escHtml(sh.start), e: escHtml(sh.end) }) + '</div>');
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

  /* ==========================================================
     보건증 만료 알림 (관리자 화면 위 🔔)
     ========================================================== */
  function todayYmd() { var n = new Date(); return n.getFullYear() + '-' + pad2(n.getMonth() + 1) + '-' + pad2(n.getDate()); }
  function healthAlertList() { return E.healthAlerts(state.workers, todayYmd(), state.settings.healthWarnDays); }
  function healthStateText(a) {
    if (a.state === 'expired') return tr('만료 {n}일 지남', { n: -a.days });
    if (a.state === 'missing') return tr('미등록');
    if (a.days === 0) return tr('오늘 만료');
    return tr('{n}일 남음', { n: a.days });
  }
  function ymdText(s) { return s ? s.replace(/-/g, '.') : ''; }
  var healthDay = '';
  function renderHealth() {
    healthDay = todayYmd();
    var list = healthAlertList();
    var hot = list.filter(function (a) { return a.state !== 'missing'; }).length + (bankPending() ? 1 : 0);
    var btn = $('bellBtn');
    btn.hidden = isLocked() || (!state.workers.length && !bankPending());
    $('bellCount').textContent = hot ? String(hot) : '';
    btn.classList.toggle('hot', bankPending() || list.some(function (a) { return a.state === 'expired' || a.state === 'urgent'; }));
    btn.setAttribute('aria-label', hot ? tr('알림 {n}건', { n: hot }) : tr('보건증 알림'));
    var pb = $('payBellBtn'), pc = $('payBellCount');
    if (pb && pc) {
      pb.hidden = isLocked();
      pc.textContent = hot ? String(hot) : '';
      pb.classList.toggle('hot', btn.classList.contains('hot'));
      pb.setAttribute('aria-label', btn.getAttribute('aria-label'));
    }
    if (!$('healthModal').hidden) renderHealthList(list);
  }
  function renderHealthList(list) {
    list = list || healthAlertList();
    $('healthLead').textContent = tr('만료 {d}일 전부터 알려 드려요. 7일 이내는 빨간색이에요.', { d: state.settings.healthWarnDays });
    var html = '';
    if (bankPending()) {
      html += '<div class="health-item st-expired"><div class="health-main"><b>' + tr('손님 계좌가 바뀌었어요') + '</b>' +
        '<small>' + tr('설정에서 확인해야 계좌 QR이 보여요') + '</small></div>' +
        '<div class="health-acts"><button type="button" class="btn btn-sm btn-primary" data-bank-review>' + tr('확인하러 가기') + '</button></div></div>';
    }
    list.forEach(function (a) {
      var id = escHtml(a.id);
      html += '<div class="health-item st-' + a.state + '">' +
        '<div class="health-main"><b>' + escName(a.name) + '</b> <span class="health-chip">' + escHtml(healthStateText(a)) + '</span>' +
          (a.expire ? '<small>' + tr('만료일 {d}', { d: ymdText(a.expire) }) + '</small>' : '<small>' + tr('검진일·만료일을 적어 주세요') + '</small>') + '</div>' +
        '<div class="health-acts">' +
          (a.state !== 'missing' ? '<button type="button" class="btn btn-sm btn-primary" data-health-renew="' + id + '">' + tr('새로 받았어요') + '</button>' : '') +
          '<button type="button" class="btn btn-sm" data-health-edit="' + id + '">' + (a.state === 'missing' ? tr('날짜 적기') : tr('날짜 고치기')) + '</button>' +
          (a.state === 'missing' ? '<button type="button" class="btn btn-sm btn-ghost" data-health-off="' + id + '">' + tr('알림 끄기') + '</button>' : '') +
        '</div>' +
        '<div class="health-renew" data-renew-box="' + id + '" hidden>' +
          '<label>' + tr('새 검진일') + ' <input type="date" min="2000-01-01" max="2100-12-31" data-renew-exam="' + id + '"></label>' +
          '<div class="health-renew-out" data-renew-out="' + id + '"></div>' +
          '<button type="button" class="btn btn-sm btn-primary" data-renew-save="' + id + '" disabled>' + tr('저장') + '</button>' +
        '</div>' +
        '</div>';
    });
    if (!html) html = '<p class="health-empty">' + tr('✓ 모든 알바생의 보건증이 유효해요.') + '</p>';
    $('healthList').innerHTML = html;
  }
  function workerById(id) { return state.workers.filter(function (w) { return w.id === id; })[0]; }
  function openHealth() { renderHealthList(); $('healthModal').hidden = false; }
  function closeHealth() { $('healthModal').hidden = true; }
  function healthChanged() { saveWorkers(); renderHealth(); recalcChecklist(); }

  /* 정산 설정 창의 보건증 칸 */
  function fillHealthFields(w) {
    var h = (w && w.health) || {};
    $('pHealthExam').value = h.exam || '';
    $('pHealthExp').value = h.expire || '';
    $('pHealthOff').checked = !!h.off;
    ['pHealthExam', 'pHealthExp', 'pHealthOff'].forEach(function (id) { $(id).disabled = !w; });
  }
  function readHealthFields(w, fromExam) {
    var exam = $('pHealthExam').value, exp = $('pHealthExp').value;
    // 검진일을 적으면 만료일 = 1년 뒤 전날. 새로 받은 보건증(옛 만료일 다음 날부터 1년)은 🔔의 [새로 받았어요]에서. 보건증에 적힌 값과 다르면 만료일 칸에서 고침
    if (fromExam && E.validYmd(exam)) {
      exp = E.healthYearEnd(exam);
      $('pHealthExp').value = exp;
    }
    var h = E.cleanHealth({ exam: exam, expire: exp, off: $('pHealthOff').checked });
    if (h) w.health = h; else delete w.health;
  }

  /* 위생 점검표 4번(건강진단결과서) 옆 안내 */
  function healthChecklistNote() {
    var list = healthAlertList();
    var exp = list.filter(function (a) { return a.state === 'expired'; }).map(function (a) { return a.name; });
    var miss = list.filter(function (a) { return a.state === 'missing'; }).length;
    var parts = [];
    if (exp.length) parts.push(tr('보건증 만료 {n}명: {names}', { n: exp.length, names: exp.join(', ') }));
    if (miss) parts.push(tr('보건증 날짜 미등록 {n}명', { n: miss }));
    return parts.join(' · ');
  }

  /* ==========================================================
     손님 계좌이체 QR
     ========================================================== */
  var BANK_OK_KEY = 'alba.bankOk';
  var PAY_URL = 'https://kimminho93.github.io/alba-manager/pay.html';
  var BANKS = ['KB국민은행', '신한은행', '우리은행', '하나은행', 'NH농협은행', 'IBK기업은행', '카카오뱅크', '토스뱅크', '케이뱅크', '새마을금고', '신협', '우체국', '지역농협·축협', 'SC제일은행', '수협은행', '부산은행', '경남은행', '대구은행(iM뱅크)', '광주은행', '전북은행', '제주은행', '산업은행', '씨티은행'];
  function curBank() { return E.cleanBank(state.settings.bank); }
  function bankOkKey() { try { return localStorage.getItem(BANK_OK_KEY) || ''; } catch (e) { return ''; } }
  function bankConfirmed() { var b = curBank(); return !!b && bankOkKey() === E.bankKey(b); }
  function bankPending() { return !!curBank() && !bankConfirmed(); }
  function markBankOk(b) { try { if (b) localStorage.setItem(BANK_OK_KEY, E.bankKey(b)); else localStorage.removeItem(BANK_OK_KEY); } catch (e) {} }
  function storeName() { return cleanStoreInfo(loadJson(KEYS.store, {})).store; }
  function payBase() {
    if (location.protocol !== 'https:') return PAY_URL;   // 이 PC 안 서버(localhost) 주소는 손님 휴대폰이 못 엶
    return location.href.split('#')[0].split('?')[0].replace(/[^/]*$/, '') + 'pay.html';
  }
  function bankUrl() { var b = curBank(); return b ? E.payUrl(payBase(), b, storeName()) : ''; }
  function bankText(b) { return b.bank + ' ' + b.number + ' ' + b.holder; }
  function renderBank() {
    var b = curBank(), ok = bankConfirmed(), pend = bankPending();
    if (!b && bankOkKey()) markBankOk(null);   // 계좌가 지워졌으면 이 기기의 확인 기록도 지움
    $('punchBankBtn').hidden = !ok;
    $('btnBankShow').hidden = !ok;
    $('btnBankPrint').hidden = !ok;
    $('btnBankClear').hidden = !b;
    $('bankState').textContent = (!b ? tr('· 아직 없음') : ok ? tr('· 설정됨') : tr('· 확인 필요')).replace(/^·\s*/, '');
    $('bankState').classList.toggle('warn', pend);
    if (pend) $('acc-bank').open = true;   // 확인할 계좌가 있으면 펼쳐 둠
    var warn = $('bankWarn');
    warn.hidden = !pend;
    if (pend) {
      warn.innerHTML = escHtml(tr('다른 기기에서 손님 계좌가 바뀌었어요. 맞는 계좌인지 확인해 주세요.')) +
        '<div class="bank-warn-acc" data-no-i18n>' + escHtml(bankText(b)) + '</div>' +
        '<button type="button" id="btnBankConfirm" class="btn btn-sm btn-primary">' + escHtml(tr('맞아요, 이 계좌로 QR 표시')) + '</button>';
    }
    var act = document.activeElement;
    var editing = act && /^sBank/.test(act.id || '');
    if (!editing) {
      $('sBankName').value = b ? b.bank : '';
      $('sBankNo').value = b ? b.number : '';
      $('sBankHolder').value = b ? b.holder : '';
    }
    if (!$('bankModal').hidden && !ok) closeBank();
  }
  function needPin(go, msg) {   // 관리자 비밀번호가 있으면 한 번 더 확인
    if (!getPin()) { go(); return; }
    punchState.afterPin = go;
    openAdminPin();
    if (msg) $('adminPinErr').textContent = msg;
  }
  function openBank() {
    var b = curBank();
    if (!b || !bankConfirmed()) return;
    var svg = E.qrSvg(bankUrl(), { label: tr('계좌이체 QR') }) || E.qrSvg(E.payUrl(payBase(), b, ''), { label: tr('계좌이체 QR') });   // 너무 길면 매장명 없이
    $('bankQr').innerHTML = svg;   // 이 앱이 만든 SVG (글자는 들어가지 않음)
    $('bankStore').textContent = storeName() || tr('계좌이체');
    $('bankShowName').textContent = b.bank;
    $('bankShowNo').textContent = b.number;
    $('bankShowHolder').textContent = b.holder;
    $('bankModal').hidden = false;
  }
  function closeBank() { $('bankModal').hidden = true; }
  function printBank() {
    var b = curBank();
    if (!b || !bankConfirmed()) return;
    var box = $('bankPrint');
    if (!box) { box = document.createElement('div'); box.id = 'bankPrint'; box.setAttribute('data-no-i18n', ''); document.body.appendChild(box); }
    box.innerHTML = '<div class="bp-store"></div><div class="bp-sub"></div><div class="bp-qr">' + (E.qrSvg(bankUrl()) || E.qrSvg(E.payUrl(payBase(), b, ''))) + '</div>' +
      '<div class="bp-hint"></div><table class="bp-info"><tr><th></th><td class="bp-bank"></td></tr><tr><th></th><td class="bp-no"></td></tr><tr><th></th><td class="bp-holder"></td></tr></table>';
    box.querySelector('.bp-store').textContent = storeName() || '';
    box.querySelector('.bp-sub').textContent = tr('계좌이체 안내');
    box.querySelector('.bp-hint').textContent = tr('휴대폰 카메라로 찍으면 계좌번호를 복사할 수 있어요');
    var th = box.querySelectorAll('th');
    th[0].textContent = tr('은행'); th[1].textContent = tr('계좌번호'); th[2].textContent = tr('예금주');
    box.querySelector('.bp-bank').textContent = b.bank;
    box.querySelector('.bp-no').textContent = b.number;
    box.querySelector('.bp-holder').textContent = b.holder;
    document.body.classList.add('print-bank');
    var done = function () { document.body.classList.remove('print-bank'); window.removeEventListener('afterprint', done); window.removeEventListener('focus', done); };
    window.addEventListener('afterprint', done);
    window.print();
    // 휴대폰처럼 인쇄 창이 따로 뜨는 곳: 돌아와 화면을 다시 볼 때 풀어 줌 (곧바로 풀면 다른 화면이 인쇄됨)
    setTimeout(function () { window.addEventListener('focus', done); }, 500);
  }
  function setBank(b) {
    state.settings = E.sanitizeSettings(Object.assign({}, state.settings, { bank: b }));
    saveJson(KEYS.settings, state.settings);
    markBankOk(b);
    renderBank();
    renderHealth();
  }

  function initHealthBank() {
    $('bankList').innerHTML = BANKS.map(function (n) { return '<option value="' + escHtml(n) + '">'; }).join('');
    $('bellBtn').addEventListener('click', openHealth);
    if ($('payBellBtn')) $('payBellBtn').addEventListener('click', openHealth);
    $('healthModal').addEventListener('click', function (ev) {
      var t = ev.target;
      if (t.closest('[data-health-close]')) { closeHealth(); return; }
      if (t.closest('[data-bank-review]')) { closeHealth(); openTab('settings'); $('acc-bank').open = true; setTimeout(function () { $('bankWarn').scrollIntoView({ block: 'center' }); }, 50); return; }
      var b = t.closest('[data-health-renew]');
      if (b) {
        var box = $('healthList').querySelector('[data-renew-box="' + CSS.escape(b.getAttribute('data-health-renew')) + '"]');
        box.hidden = !box.hidden;
        if (!box.hidden) { var inp = box.querySelector('input'); if (!inp.value) { inp.value = todayYmd(); inp.dispatchEvent(new Event('input', { bubbles: true })); } inp.focus(); }
        return;
      }
      b = t.closest('[data-health-edit]');
      if (b) {
        var w = workerById(b.getAttribute('data-health-edit'));
        if (!w) return;
        closeHealth();
        openTab('payroll');
        selectWorker(w.id);
        openSheet('set');
        setTimeout(function () { $('healthField').scrollIntoView({ block: 'center' }); $('pHealthExam').focus(); }, 80);
        return;
      }
      b = t.closest('[data-health-off]');
      if (b) {
        var w2 = workerById(b.getAttribute('data-health-off'));
        if (!w2) return;
        w2.health = E.cleanHealth(Object.assign({}, w2.health || {}, { off: true }));
        healthChanged();
        showToast(tr('{n}님 보건증 알림을 껐어요. 정산 설정에서 다시 켤 수 있어요.', { n: w2.name }));
        return;
      }
      b = t.closest('[data-renew-save]');
      if (b) {
        var id = b.getAttribute('data-renew-save'), w3 = workerById(id);
        var exam = $('healthList').querySelector('[data-renew-exam="' + CSS.escape(id) + '"]').value;
        var exp = w3 && E.renewHealthExpire(w3.health, exam);
        if (!w3 || !exp) return;
        w3.health = E.cleanHealth({ exam: exam, expire: exp });
        healthChanged();
        if (state.selId === w3.id) fillHealthFields(w3);
        showToast(tr('{n}님 보건증을 새로 기록했어요. 만료일 {d}', { n: w3.name, d: ymdText(exp) }));
      }
    });
    $('healthModal').addEventListener('input', function (ev) {
      var inp = ev.target.closest('[data-renew-exam]');
      if (!inp) return;
      var id = inp.getAttribute('data-renew-exam'), w = workerById(id);
      var exp = w && E.renewHealthExpire(w.health, inp.value);
      var out = $('healthList').querySelector('[data-renew-out="' + CSS.escape(id) + '"]');
      out.textContent = exp ? tr('새 만료일 {d}', { d: ymdText(exp) }) + (w.health && w.health.expire && E.healthYearEnd(inp.value) !== exp ? ' ' + tr('(옛 만료일 다음 날부터 1년)') : '') : tr('검진일을 골라 주세요');
      $('healthList').querySelector('[data-renew-save="' + CSS.escape(id) + '"]').disabled = !exp;
    });
    $('pHealthExam').addEventListener('change', function () { var w = selWorker(); if (!w) return; readHealthFields(w, true); healthChanged(); });
    $('pHealthExp').addEventListener('change', function () { var w = selWorker(); if (!w) return; readHealthFields(w, false); healthChanged(); });
    $('pHealthOff').addEventListener('change', function () { var w = selWorker(); if (!w) return; readHealthFields(w, false); healthChanged(); });
    $('sHealthWarn').addEventListener('change', function () {
      state.settings = E.sanitizeSettings(Object.assign({}, state.settings, { healthWarnDays: $('sHealthWarn').value }));
      saveJson(KEYS.settings, state.settings);
      renderHealth();
    });

    $('btnBankSave').addEventListener('click', function () {
      var b = E.cleanBank({ bank: $('sBankName').value, number: $('sBankNo').value, holder: $('sBankHolder').value });
      if (!b) { showToast(tr('은행·계좌번호(숫자 8~20자리)·예금주를 모두 적어 주세요.'), true); return; }
      if (bankConfirmed() && E.bankKey(b) === E.bankKey(curBank())) { showToast(tr('바뀐 내용이 없어요.')); return; }
      needPin(function () { setBank(b); showToast(tr('손님 계좌를 저장했어요: {t}', { t: bankText(b) })); }, tr('계좌를 바꾸려면 관리자 비밀번호를 입력해 주세요.'));
    });
    $('btnBankClear').addEventListener('click', function () {
      if (!window.confirm(tr('손님 계좌 QR을 지울까요?'))) return;
      needPin(function () { setBank(null); showToast(tr('손님 계좌를 지웠어요.')); }, tr('계좌를 지우려면 관리자 비밀번호를 입력해 주세요.'));
    });
    $('bankWarn').addEventListener('click', function (ev) {
      if (!ev.target.closest('#btnBankConfirm')) return;
      var b = curBank();
      if (!b) return;
      var key = E.bankKey(b);
      needPin(function () {
        if (E.bankKey(curBank()) !== key) { renderBank(); return; }   // 그 사이 또 바뀜
        markBankOk(b); renderBank(); renderHealth();
        showToast(tr('이 계좌로 QR을 보여 줄게요.'));
      }, tr('계좌를 확인하려면 관리자 비밀번호를 입력해 주세요.'));
    });
    $('btnBankShow').addEventListener('click', openBank);
    $('punchBankBtn').addEventListener('click', openBank);
    $('btnBankPrint').addEventListener('click', printBank);
    $('bankModal').addEventListener('click', function (ev) { if (ev.target.closest('[data-bank-close]')) closeBank(); });
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') { closeBank(); closeHealth(); } });
    $('sHealthWarn').value = String(state.settings.healthWarnDays);
    renderBank();
    renderHealth();
  }

  /* 설정 목록 각 줄 오른쪽의 현재 값 */
  function optText(id) { var el = $(id); var o = el && el.options && el.options[el.selectedIndex]; return o ? o.textContent.replace(/\s*\(.*\)\s*$/, '').replace(/\s*·.*$/, '') : ''; }
  function renderSetSummaries() {
    var set = function (id, t) { var el = $(id); if (el) el.textContent = t; };
    var sti = cleanStoreInfo(loadJson(KEYS.store, {}));
    set('sumStore', [sti.store, sti.inspector].filter(Boolean).join(' · ') || tr('아직 없음'));
    set('sumPunch', optText('sPunchUnit'));
    set('sumSound', ($('sndVolLabel') && $('sndVolLabel').textContent) || '');
    set('sumSaver', optText('saverMin'));
    set('sumWage', E.moneyText(state.settings.minWage));
    set('sumHealth', tr('{d}일 전부터', { d: state.settings.healthWarnDays }));
    var r = state.settings.rates || {};
    set('sumTax', Math.round(r.incomeTax * (1 + r.localTax / 100) * 1000) / 1000 + '%');
    set('sumLang', E.getLang() === 'en' ? 'English' : '한국어');
    set('sumInfo', 'v' + (window.ALBA_VERSION || ''));
  }
  /* ⋯ 메뉴: 안의 버튼을 누르거나 바깥을 누르면 닫힘 */
  function initMoreMenus() {
    document.addEventListener('click', function (ev) {
      document.querySelectorAll('details.more-menu[open]').forEach(function (m) {
        if (!m.contains(ev.target) || ev.target.closest('.more-pop .btn')) m.open = false;
      });
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      document.querySelectorAll('details.more-menu[open]').forEach(function (m) { m.open = false; var sm = m.querySelector('summary'); if (sm) sm.focus(); });
    });
  }
  /* 매장 정보(설정): 매장명은 점검표·계좌 QR에, 사장님 이름은 점검자 성명 기본값으로 */
  /* 예전 버전이 빈 칸에 예시 문구를 실제 값으로 저장했던 것 정리 (손님 QR에 남의 가게 이름이 뜨지 않게) */
  var SAMPLE_STORE = { '행복분식 강남점': 1, 'Happy Snack Gangnam': 1 }, SAMPLE_OWNER = { '김사장': 1, 'Mr. Kim': 1 };
  function cleanStoreInfo(st) {
    st = st && typeof st === 'object' ? st : {};
    var name = typeof st.store === 'string' ? E.cleanText(st.store, 30) : '', owner = typeof st.inspector === 'string' ? E.cleanText(st.inspector, 20) : '';
    if (SAMPLE_STORE[name]) name = '';
    if (SAMPLE_OWNER[owner]) owner = '';
    return { store: name, inspector: owner };
  }
  function applyStoreInfo(st, fromCloud) {
    st = cleanStoreInfo(st);
    var name = typeof st.store === 'string' ? st.store : '', owner = typeof st.inspector === 'string' ? st.inspector : '';
    var oldOwner = $('sOwnerName').getAttribute('data-was') || '';
    var a = document.activeElement;
    if (!(a && a.id === 'sStoreName') || fromCloud) $('sStoreName').value = name;
    if (!(a && a.id === 'sOwnerName') || fromCloud) $('sOwnerName').value = owner;
    $('sOwnerName').setAttribute('data-was', owner);
    $('cStore').value = name;
    if ($('railStore')) $('railStore').textContent = name || tr('사장님 도우미');   // 넓은 화면 왼쪽 메뉴 맨 위
    if (!$('cInspector').value || $('cInspector').value === oldOwner) $('cInspector').value = owner;
    recalcChecklist();
    renderSetSummaries();
  }
  function initStoreInfo() {
    var save = function () {
      var st = { store: E.cleanText($('sStoreName').value, 30), inspector: E.cleanText($('sOwnerName').value, 20) };
      saveJson(KEYS.store, st);
      applyStoreInfo(st);
    };
    $('sStoreName').addEventListener('input', save);
    $('sOwnerName').addEventListener('input', save);
    var go = function () { openTab('settings'); $('acc-store').open = true; setTimeout(function () { $('sStoreName').focus(); }, 50); };
    $('cStoreGo').addEventListener('click', go);
    $('cStore').addEventListener('click', go);
    var saved = loadJson(KEYS.store, {}), fixed = cleanStoreInfo(saved);
    if (saved && (saved.store !== fixed.store || saved.inspector !== fixed.inspector) && (saved.store || saved.inspector)) saveJson(KEYS.store, fixed);   // 예시 문구 정리 결과를 저장(동기화)
    applyStoreInfo(fixed);
  }
  function initSetSummaries() {
    var tab = $('tab-settings');
    var later = function () { setTimeout(renderSetSummaries, 0); };
    tab.addEventListener('change', later);
    tab.addEventListener('input', later);
    tab.addEventListener('blur', later, true);
    renderSetSummaries();
  }

  function initPunch() {
    initSoundSettings();
    initSaver();
    initHealthBank();
    initSetSummaries();
    initStoreInfo();
    var pl = $('punchLang');   // 출퇴근 화면(잠금 중에도)에서 알바생이 언어를 바꿀 수 있게
    if (pl) {
      pl.textContent = E.getLang() === 'en' ? '한국어' : 'English';
      pl.addEventListener('click', function () { if (window.AlbaLang) window.AlbaLang.set(E.getLang() === 'en' ? 'ko' : 'en'); });
      window.addEventListener('alba:lang', function () { pl.textContent = E.getLang() === 'en' ? '한국어' : 'English'; renderSetSummaries(); });
    }
    initMoreMenus();
    runAutoClose();
    tickClock();
    setInterval(function () { tickClock(); runAutoClose(); renderPunch(); renderChips(); renderWorkNow(); renderPunchCloud(); renderDevice(); if (healthDay !== todayYmd()) { renderHealth(); recalcChecklist(); } }, 15000);

    $('punchList').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-punch]');
      if (!b) return;
      var w = state.workers.filter(function (x) { return x.id === b.getAttribute('data-punch'); })[0];
      if (!w) return;
      if (!w.password) { showToast(tr('{n}님은 아직 출퇴근 비밀번호가 없어요. 사장님께 정해 달라고 하세요.', { n: w.name })); return; }
      openPunchPw(w);
    });
    initGuide();
    initShare();
    initUpdate();
    $('punchAllOut').addEventListener('click', askBulkOut);
    $('pendingBox').addEventListener('click', onPendingClick);
    $('conflictBox').addEventListener('click', onConflictClick);
    $('punchPwForm').addEventListener('submit', function (ev) { ev.preventDefault(); punchSubmit(); });
    $('punchPw').addEventListener('click', function (ev) { if (ev.target.closest('[data-punch-close]')) closePunchPw(); });
    $('punchResult').addEventListener('click', function (ev) { if (ev.target.closest('[data-punch-result-close]')) closePunchResult(); });

    $('lockBtn').addEventListener('click', function () {
      if (isLocked()) { punchState.afterPin = null; openAdminPin(); } else lockNow();
    });
    $('adminPin').addEventListener('click', function (ev) { if (ev.target.closest('[data-admin-close]')) closeAdminPin(); });
    $('adminPinForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (lockLeft('admin')) {
        $('adminPinErr').textContent = tr('잠시 후에 다시 해 주세요. ({n}초)', { n: lockLeft('admin') });
        $('adminPinInput').value = '';
        return;
      }
      if ($('adminPinInput').value === getPin()) clearFails('admin');
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
        var af = noteFail('admin', 60000);
        enqueuePunch([tsOf(new Date()), '', '관리자', '', '관리자 비밀번호', '비밀번호 오류', af.n + '번째 연속 실패']);
        $('adminPinErr').textContent = af.locked ? tr('여러 번 틀렸어요. 1분 뒤에 다시 해 주세요.') : tr('비밀번호가 맞지 않아요.');
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

    $('btnDevSet').addEventListener('click', onDevSet);
    $('btnDevClear').addEventListener('click', onDevClear);
    $('sDevName').addEventListener('change', function () { var C = window.AlbaCloud; if (C && C.setDeviceName) C.setDeviceName($('sDevName').value); });
    $('btnPinSave').addEventListener('click', function () {
      var v = $('sAdminPin').value.trim();
      if (v.length < 4) { showToast(tr('관리자 비밀번호는 4자 이상으로 정해 주세요.')); return; }
      var msg = getPin()
        ? tr('관리자 비밀번호를 바꿉니다. 계속할까요?')
        : tr('정하면 지금 바로 잠기고, 출퇴근 화면만 보이게 됩니다.\n다시 열 때는 위의 [관리자]를 눌러 이 비밀번호를 입력하세요.\n\n계속할까요?');
      if (!window.confirm(msg)) return;
      var go = function () { $('sAdminPin').value = ''; commitPin(v); };
      if (getPin()) { punchState.afterPin = go; openAdminPin(); $('adminPinErr').textContent = tr('지금 쓰는 관리자 비밀번호를 입력해 주세요.'); }   // 바꿀 때는 지금 비밀번호 확인
      else go();
    });
    $('btnPinClear').addEventListener('click', function () {
      if (!getPin()) { showToast(tr('정해 둔 관리자 비밀번호가 없어요.')); return; }
      if (!window.confirm(tr('관리자 비밀번호를 없앨까요?\n없애면 누구나 급여 화면을 볼 수 있어요.'))) return;
      punchState.afterPin = function () {
        try { localStorage.removeItem(PIN_KEY); } catch (e) {}
        if (window.AlbaCloud) window.AlbaCloud.setAdminPin('');
        applyLockUi();
        bumpIdle();
        showToast(tr('관리자 비밀번호를 없앴어요.'));
      };
      openAdminPin();
      $('adminPinErr').textContent = tr('지금 쓰는 관리자 비밀번호를 입력해 주세요.');
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
      if (C.pinPending && C.pinPending()) {   // 이 기기에서 바꾼 비밀번호가 아직 시트에 안 올라감 → 시트의 옛 값으로 덮지 않음
        err.textContent = tr('이 기기에서 바꾼 비밀번호가 아직 구글 시트에 올라가지 않았어요. 인터넷·구글 로그인을 확인하고 잠시 뒤 다시 눌러 주세요.');
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
    syncMoneyUi();   // [보기]/[숨기기]·줄 돈 보기 글자를 새 언어로
    if ($('railStore')) $('railStore').textContent = ($('sStoreName') && $('sStoreName').value.trim()) || tr('사장님 도우미');   // 가게 이름이 비었을 때 대체 글자
    var checked = Array.prototype.map.call(document.querySelectorAll('#chkFormList input:checked'), function (el) { return el.value; });
    var opened = Array.prototype.map.call(document.querySelectorAll('#chkFormList details'), function (d) { return d.open; });   // 펼친 분류 기억
    buildChecklistForm();
    checked.forEach(function (v) { var el = document.querySelector('#chkFormList input[value="' + v + '"]'); if (el) el.checked = true; });
    Array.prototype.forEach.call(document.querySelectorAll('#chkFormList details'), function (d, i) {
      if (i < opened.length) { d.open = opened[i]; d.dataset.init = '1'; }
    });
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
    // 앱이 상태에 따라 직접 쓰는 글(잠금 버튼·기기·계좌·보건증·출퇴근 기준 등)은 현재 상태로 다시 씀
    applyLockUi(); fillPunchUnit(); renderBank(); renderHealth(); renderDevice(); renderPunchCloud(); renderPending(); renderConflicts(); renderSetSummaries();
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
  if (window.AlbaCloud) {
    // 연동된 기기는 시트와 한 번 맞춘 뒤에 자동 퇴근을 판단. 로그인이 풀려 맞추지 못했으면 다시 연결될 때까지 기다림(최대 10분)
    var syncBlocked = function () { var st = window.AlbaCloud.getStatus ? window.AlbaCloud.getStatus() : null; return !!(st && st.connected && (st.kind === 'needLogin' || st.kind === 'error')); };
    var startAuto = function () { if (!firstSyncDone) { firstSyncDone = true; runAutoClose(); renderPunch(); renderWorkNow(); } };
    setTimeout(function () { if (!syncBlocked()) startAuto(); }, 20000);   // 인터넷이 아주 느려도 20초 뒤엔 판단
    setTimeout(startAuto, 600000);
    window.AlbaCloud.resume().then(function () {}, function () {}).then(function () { if (!syncBlocked()) startAuto(); else { renderPunch(); renderWorkNow(); } });
  } else firstSyncDone = true;
})();
