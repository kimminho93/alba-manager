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
    document.body.insertAdjacentHTML('afterbegin', '<div class="fatal">엔진(engine.js)을 불러오지 못했습니다.</div>');
    return;
  }

  var KEYS = {
    theme: 'alba.theme',
    bigFont: 'alba.bigFont',
    roster: 'alba.roster.v1',
    archive: 'alba.archive.v1',
    store: 'alba.store.v1',
    presets: 'alba.timePresets.v1'
  };

  var SYNC_KEYS = {};
  SYNC_KEYS[KEYS.roster] = SYNC_KEYS[KEYS.archive] = SYNC_KEYS[KEYS.store] = SYNC_KEYS[KEYS.presets] = true;

  var MINUTE_STEPS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

  var state = {
    serverAvailable: false,
    payroll: null,
    checklist: null,
    roster: loadJson(KEYS.roster, []),
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
      off: false
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
      btn.title = cur === 'dark' ? '라이트 모드로 전환' : '다크 모드로 전환';
    }
  }

  function syncFontBtn() {
    var big = document.documentElement.getAttribute('data-fs') === 'large';
    var btn = $('fontToggle');
    if (!btn) return;
    btn.textContent = big ? '가−' : '가+';
    btn.setAttribute('aria-pressed', big ? 'true' : 'false');
    btn.title = big ? '글자를 보통 크기로' : '글자를 크게';
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

  function renderPresets() {
    var box = $('presetList');
    if (!box) return;
    var html = presetState.list.map(function (p, i) {
      var label = (p.name ? escHtml(p.name) + ' ' : '') + escHtml(p.start) + '~' + escHtml(p.end) +
        ' (' + presetHours(p) + (p.breakMin ? ', 휴게' + p.breakMin + '분' : '') + ')';
      var tools = presetState.editMode
        ? '<span class="preset-tools"><button type="button" class="preset-tool" data-act="edit" data-i="' + i + '" title="수정">✏️</button>' +
          '<button type="button" class="preset-tool" data-act="del" data-i="' + i + '" title="삭제">✕</button></span>'
        : '';
      return '<span class="preset-item"><button type="button" class="chip preset-chip" data-i="' + i + '">' + label + '</button>' + tools + '</span>';
    }).join('');
    html += '<button type="button" class="chip preset-chip chip-off" data-off="true">🚫 휴무</button>';
    box.innerHTML = html;

    var full = presetState.list.length >= PRESET_MAX;
    $('presetCount').textContent = presetState.list.length + '/' + PRESET_MAX;
    $('presetAddBtn').disabled = full;
    $('presetAddBtn').title = full ? '최대 ' + PRESET_MAX + '개까지 만들 수 있어요' : '시간대 추가 (최대 ' + PRESET_MAX + '개)';
    $('presetEditToggle').classList.toggle('active', presetState.editMode);
    $('presetEditToggle').textContent = presetState.editMode ? '✔ 편집 완료' : '✏️ 편집';
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
      opt.textContent = '휴게 ' + p.breakMin + '분';
      sel.appendChild(opt);
    }
    sel.value = String(p.breakMin);
    $('presetSaveBtn').textContent = idx >= 0 ? '수정 저장' : '추가';
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
          if (!window.confirm('이 시간대를 삭제할까요?')) return;
          presetState.list.splice(ti, 1);
          savePresets();
          closePresetForm();
          renderPresets();
          showToast('🗑 시간대를 삭제했습니다.');
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
        showToast('🚫 선택된 날짜를 휴무로 설정했습니다.');
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
        showToast('시간대는 최대 ' + PRESET_MAX + '개까지 만들 수 있어요.');
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
      if (!start || !end) { showToast('출근/퇴근 시각을 입력해 주세요.'); return; }
      var st = parseHM(start, 9, 0), et = parseHM(end, 14, 0);
      var sMin = st.h * 60 + st.m;
      var eMin = et.h * 60 + et.m;
      if (eMin === 0) { eMin = 24 * 60; end = '24:00'; } // 00:00 퇴근은 자정(24:00)으로 처리
      var brk = Number($('presetBreak').value) || 0;
      if (eMin <= sMin) { showToast('퇴근 시각은 출근 시각보다 늦어야 해요.'); return; }
      if (eMin - sMin <= brk) { showToast('휴게시간이 근무시간보다 길어요.'); return; }
      var item = { name: $('presetName').value.trim().slice(0, 8), start: start, end: end, breakMin: brk };
      if (presetState.editingIdx >= 0) {
        presetState.list[presetState.editingIdx] = item;
        showToast('✏️ 시간대를 수정했습니다.');
      } else {
        if (presetState.list.length >= PRESET_MAX) { showToast('최대 ' + PRESET_MAX + '개까지 가능합니다.'); return; }
        presetState.list.push(item);
        showToast('＋ 시간대를 추가했습니다. (' + presetState.list.length + '/' + PRESET_MAX + ')');
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
        '<span>' + pad2(h) + '시</span><small class="muted">' + (h < 12 ? '오전' : '오후') + '</small></button>';
    }
    $('startHourMenu').innerHTML = shHtml;

    var ehHtml = '';
    for (var eh = 0; eh <= 24; eh++) {
      ehHtml += '<button type="button" class="scroll-option" role="option" data-eh="' + eh + '">' +
        '<span>' + pad2(eh) + '시</span><small class="muted">' + (eh === 24 ? '자정' : (eh < 12 ? '오전' : '오후')) + '</small></button>';
    }
    $('endHourMenu').innerHTML = ehHtml;

    var smHtml = MINUTE_STEPS.map(function (m) {
      return '<button type="button" class="scroll-option" role="option" data-sm="' + m + '">' +
        '<span>' + pad2(m) + '분</span></button>';
    }).join('');
    $('startMinMenu').innerHTML = smHtml;

    var emHtml = MINUTE_STEPS.map(function (m) {
      return '<button type="button" class="scroll-option" role="option" data-em="' + m + '">' +
        '<span>' + pad2(m) + '분</span></button>';
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

  function ensureCalendarAndShifts(payMonth, resetDefault) {
    var cal = E.buildMonthCalendar(payMonth);
    var prevCal = state.calendar;
    state.calendar = cal;

    if (resetDefault || !state.dailyShifts || state.dailyShifts.length === 0) {
      state.dailyShifts = cal.days.map(function (d) {
        return {
          off: d.isWeekend,
          start: '09:00',
          end: '14:00',
          breakMinutes: 0
        };
      });
      var firstWeekday = cal.days.findIndex(function (d) { return !d.isWeekend; });
      state.selectedDayIdx = firstWeekday >= 0 ? firstWeekday : 0;
      loadDayIntoEditor(state.selectedDayIdx);
    } else if (!prevCal || prevCal.payMonth !== cal.payMonth) {
      // 지급월이 바뀐 경우: 새 달의 요일(평일/주말)에 맞춰 기존 패턴 유지하며 재배치
      var sampleWeekday = { off: false, start: '09:00', end: '14:00', breakMinutes: 0 };
      var sampleWeekend = { off: true, start: '09:00', end: '14:00', breakMinutes: 0 };
      if (prevCal && state.dailyShifts.length === prevCal.days.length) {
        for (var i = 0; i < prevCal.days.length; i++) {
          if (!prevCal.days[i].isWeekend && !state.dailyShifts[i].off) {
            sampleWeekday = Object.assign({}, state.dailyShifts[i]);
            break;
          }
        }
        for (var j = 0; j < prevCal.days.length; j++) {
          if (prevCal.days[j].isWeekend) {
            sampleWeekend = Object.assign({}, state.dailyShifts[j]);
            break;
          }
        }
      }
      state.dailyShifts = cal.days.map(function (d) {
        return Object.assign({}, d.isWeekend ? sampleWeekend : sampleWeekday);
      });
      if (state.selectedDayIdx >= cal.daysInMonth) state.selectedDayIdx = 0;
      loadDayIntoEditor(state.selectedDayIdx);
    }

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
    renderTimeEditor();
  }

  function currentEditorShift() {
    var start = fmtTime(state.editor.startHour, state.editor.startMin);
    var end = state.editor.endHour === 24 ? '24:00' : fmtTime(state.editor.endHour, state.editor.endMin);
    var hrs = state.editor.off ? 0 : E.calcShiftHours(start, end, state.editor.breakMinutes);
    return {
      off: state.editor.off || hrs <= 0,
      start: start,
      end: end,
      breakMinutes: state.editor.breakMinutes,
      hours: hrs
    };
  }

  function renderTimeEditor() {
    var cal = state.calendar;
    var cd = cal && cal.days[state.selectedDayIdx];
    var sh = currentEditorShift();

    if (cd) {
      $('selDayBadge').textContent = cal.month + '월 ' + cd.date + '일 (' + cd.dayName + ') · ' + cd.week + '주차';
      $('selDayTitle').textContent = sh.off
        ? '현재 휴무일입니다 (시간을 선택하면 근무일로 변경됩니다)'
        : (sh.start + ' 출근 ~ ' + sh.end + ' 퇴근' + (sh.breakMinutes ? ' (휴게 ' + sh.breakMinutes + '분)' : ''));
    }

    var minMeal = E.toNumber($('pMealMinHours').value, 4);
    var mealTag = ($('pMeal').checked && !sh.off && sh.hours >= minMeal) ? ' · 🍚 식대 지급' : '';
    $('editorCalcPill').innerHTML = sh.off
      ? '🚫 <b>휴무 (0시간)</b>'
      : (sh.start + ' ~ ' + sh.end + (sh.breakMinutes ? ' (-' + sh.breakMinutes + '분)' : '') + ' · <b>' + E.formatNum(sh.hours, 2) + '시간</b>' + mealTag);

    $('startHourText').textContent = pad2(state.editor.startHour) + '시';
    $('startMinText').textContent = pad2(state.editor.startMin) + '분';
    $('endHourText').textContent = pad2(state.editor.endHour) + '시';
    $('endMinText').textContent = pad2(state.editor.endMin) + '분';

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
    state.dailyShifts[state.selectedDayIdx] = {
      off: sh.off,
      start: sh.start,
      end: sh.end,
      breakMinutes: sh.breakMinutes
    };
    renderTimeEditor();
    recalcPayroll();
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
    $('pMonthLabel').textContent = m ? (m[1] + '년 ' + Number(m[2]) + '월') : '월 선택';
  }

  // 주별 주휴 상태 문구 + (결근 주일 때) 예외 지급 버튼
  function weekStatus(w, r, idx) {
    if (!r.includeWeekly) return { text: '주휴 미포함', btn: '', cls: '' };
    var days = (w.workDays !== null && w.workDays !== undefined) ? (w.workDays + '/' + w.contractDays + '일 출근') : '';
    if (w.eligible && !w.excused) {
      return { text: '주휴 +' + E.formatWon(w.allowance) + '원' + (days ? ' · 개근 ' + days : ''), btn: '', cls: 'ok' };
    }
    if (w.excused) {
      return {
        text: '주휴 +' + E.formatWon(w.allowance) + '원 (결근 있으나 지급)',
        btn: '<button type="button" class="btn btn-xs wk-excuse-btn" data-week-excuse="' + idx + '">다시 제외하기</button>',
        cls: 'ok'
      };
    }
    if (!w.hoursOk) return { text: '주휴 없음 (15시간 미만)', btn: '', cls: '' };
    return {
      text: '주휴 없음 · ' + (days || '결근') + (w.partial ? '' : ''),
      btn: '<button type="button" class="btn btn-xs wk-excuse-btn" data-week-excuse="' + idx + '" title="공휴일·사장님 사정으로 쉰 주">이 주는 주휴 지급</button>',
      cls: 'bad'
    };
  }

  function renderMonthCalendar(r) {
    var cal = r.calendar || state.calendar;
    if (!cal) return;

    $('calMonthBadge').textContent = cal.month + '월 · ' + cal.weekCount + '개 주차';
    $('calBoardTitle').textContent = cal.year + '년 ' + cal.month + '월 출퇴근 달력 (총 ' + cal.weekCount + '개 주차 · ' + cal.daysInMonth + '일)';

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
      rowsHtml += '<td class="cal-wk-cell">' + (wi + 1) + '주차</td>';

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

        rowsHtml += '<td class="' + cls + '" data-day-idx="' + day.index + '">' +
          '<div class="cal-day-top">' +
            '<span class="cal-date-num' + dateColor + '">' + day.date + '일</span>' +
            (isMeal ? '<span class="cal-meal-icon" title="식대 지급 대상">🍚</span>' : '') +
          '</div>';

        if (day.off || day.hours <= 0) {
          rowsHtml += '<div class="cal-off-badge">휴무</div>';
        } else {
          rowsHtml +=
            '<div class="cal-shift-range">' + escHtml(day.start + '~' + day.end) + '</div>' +
            '<span class="cal-shift-hours">' + E.formatNum(day.hours, 1) + '시간' +
              (day.breakMinutes ? ' (-' + day.breakMinutes + 'm)' : '') +
            '</span>';
        }
        rowsHtml += '</td>';
      }

      var st = weekStatus(wkObj, r, wi);
      var mealSub = r.includeMeal ? ('🍚 식대 ' + wkObj.mealDays + '일') : '';

      rowsHtml += '<td class="cal-sum-cell' + (wkObj.eligible && r.includeWeekly ? ' eligible' : '') + (st.cls === 'bad' ? ' absent' : '') + '">' +
        '<b>' + E.formatNum(wkObj.hours, 1) + '시간</b>' +
        '<span class="cal-sum-sub">' + st.text + '</span>' +
        (st.btn ? '<span class="cal-sum-sub">' + st.btn + '</span>' : '') +
        (mealSub ? '<span class="cal-sum-sub">' + mealSub + '</span>' : '') +
        '</td>';

      rowsHtml += '</tr>';
    }

    $('monthCalBody').innerHTML = rowsHtml;
    renderMonthCards(r, cal, grid);
  }

  // 휴대폰용 주 단위 카드: 요일을 세로로 한 줄씩 보여줌 (CSS가 화면 폭에 따라 표/카드 중 하나만 표시)
  function renderMonthCards(r, cal, grid) {
    var box = $('monthCalCards');
    if (!box) return;
    var DOW = ['월', '화', '수', '목', '금', '토', '일'];
    var html = '';
    for (var wi = 0; wi < cal.weekCount; wi++) {
      var wk = r.weeks[wi] || { hours: 0, eligible: false, allowance: 0, mealDays: 0 };
      var st = weekStatus(wk, r, wi);
      var mealSub = r.includeMeal ? (' · 🍚 식대 ' + wk.mealDays + '일') : '';
      html += '<section class="wk-card">' +
        '<div class="wk-card-head"><b>' + (wi + 1) + '주차</b>' +
        '<span class="wk-card-sum' + (wk.eligible && r.includeWeekly ? ' eligible' : '') + '">' + E.formatNum(wk.hours, 1) + '시간</span></div>';
      for (var di = 0; di < 7; di++) {
        var day = grid[wi][di];
        if (!day) continue;
        var isSel = day.index === state.selectedDayIdx;
        var isMeal = r.includeMeal && day.mealEligible;
        var off = day.off || day.hours <= 0;
        html += '<button type="button" class="wk-day' + (isSel ? ' selected' : '') + (isMeal ? ' meal-ok' : '') + (off ? ' off-day' : '') +
          '" data-day-idx="' + day.index + '">' +
          '<span class="wk-day-date' + (di === 5 ? ' sat' : (di === 6 ? ' sun' : '')) + '">' +
            cal.month + '/' + day.date + ' (' + DOW[di] + ')</span>' +
          '<span class="wk-day-main">' + (off ? '휴무' : escHtml(day.start + '~' + day.end)) + '</span>' +
          '<span class="wk-day-hours">' + (off ? '' : E.formatNum(day.hours, 1) + '시간') + (isMeal ? ' 🍚' : '') + '</span>' +
          '</button>';
      }
      html += '<div class="wk-card-foot ' + st.cls + '"><span>' + st.text + mealSub + '</span>' + st.btn + '</div></section>';
    }
    box.innerHTML = html;
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
        ? ('일 ' + E.formatNum(r.mealMinHours, 1) + '시간 이상 근무 ' + r.mealDays + '일 × ' + E.formatWon(r.mealAmount) + '원 = +' + E.formatWon(r.mealAllowance) + '원')
        : '체크 시 하루 기준시간 이상 근무한 날에 식대를 추가 지급합니다';

      renderMonthCalendar(r);
      renderTimeEditor();
    }
  }

  function renderPayroll(r) {
    state.payroll = r;
    $('pContractLabel').textContent = '주 ' + state.contractDays + '일';
    syncModeAndHighlights(r);

    $('bannerText').innerHTML =
      '<span class="pay-label"><b>' + escHtml(r.name) + '</b>님에게 줄 돈 (실수령액)</span>' +
      '<b class="money">' + E.formatWon(r.net) + '<small>원</small></b>';

    $('slipName').textContent = r.name;
    $('slipMonth').textContent = r.payMonthLabel;
    $('slipWage').textContent = E.formatWon(r.hourlyWage) + '원';
    var modeLabel = r.mode === 'daily'
      ? ('일별 출퇴근 · ' + r.workDays + '일 / ' + r.weeks.length + '개 주차')
      : (r.mode === 'weekly' ? ('주차별 · ' + r.weeks.length + '개 주차') : '4주 균등');
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
          ? (w.eligible
              ? '주휴 +' + E.formatWon(w.allowance) + '원' + (w.excused ? ' (결근 있으나 지급)' : '')
              : (!w.hoursOk ? '15h 미만 (주휴 0원)'
                : '결근으로 주휴 없음' + (w.workDays !== null && w.workDays !== undefined ? ' (' + w.workDays + '/' + w.contractDays + '일)' : '')))
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
    E.CHECKLIST_GROUPS.forEach(function (g) {
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
    fh.textContent = c.fridgeOk ? '✓ 적정 (0~5°C)' : '⚠ 기준 이탈 (0~5°C 유지 필요)';

    var fzh = $('freezerHint');
    fzh.className = 'temp-hint ' + (c.freezerOk ? 'ok' : 'bad');
    fzh.textContent = c.freezerOk ? '✓ 적정 (-18°C 이하)' : '⚠ 기준 이탈 (-18°C 이하 유지 필요)';

    var banner = $('chkBanner');
    banner.className = 'banner chk-banner ' + (c.allPass ? 'ok' : 'bad');
    $('chkBannerText').textContent = c.allPass
      ? '✅ 위생 점검 ' + c.total + '개 항목 모두 적합합니다.'
      : '⚠️ 점검필요 항목이 ' + c.failCount + '건 있습니다. 체크하지 않은 항목과 온도를 확인하세요.';
    $('chkScore').textContent = '적합 ' + c.passCount + '/' + c.total;
    $('chkProgress').textContent = c.input.checks.length + ' / ' + c.total + ' 체크';

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
          '<td>' + escHtml(it.text) + (it.standard ? '<span class="item-std">기준: ' + escHtml(it.standard) + '</span>' : '') + '</td>' +
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
            '<div class="chk-item-std">' + (it.standard ? '기준: ' + escHtml(it.standard) + ' · ' : '') + escHtml(it.note) + '</div>' +
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

    ensureCalendarAndShifts($('pMonth').value, true);

    var savedStore = loadJson(KEYS.store, null);
    if (savedStore) {
      if (savedStore.store) $('cStore').value = savedStore.store;
      if (savedStore.inspector) $('cInspector').value = savedStore.inspector;
    }
    if (!$('cStore').value) $('cStore').value = '행복분식 강남점';
    if (!$('cInspector').value) $('cInspector').value = '김사장';
  }

  function bindEvents() {
    $('themeToggle').addEventListener('click', toggleTheme);
    $('fontToggle').addEventListener('click', toggleFontSize);

    // 우측 상단 뷰 전환 탭 (일별 출퇴근 시간표 크게 입력 <-> 표준 급여명세서 보기)
    $('btnViewSchedule').addEventListener('click', function () { setRightView('schedule'); });
    $('btnViewSlip').addEventListener('click', function () { setRightView('slip'); });
    $('btnOpenScheduleView').addEventListener('click', function () {
      setRightView('schedule');
      $('scheduleBoard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });

    // 달력 날짜 클릭 -> 해당 날짜 선택
    // 주 근무 약속일수 − / +
    function shiftContractDays(delta) {
      state.contractDays = Math.min(7, Math.max(1, state.contractDays + delta));
      recalcPayroll();
    }
    $('pContractMinus').addEventListener('click', function () { shiftContractDays(-1); });
    $('pContractPlus').addEventListener('click', function () { shiftContractDays(1); });

    // 결근 주의 "주휴 지급" 예외 버튼(달력 표/카드) 및 주차별 모드 결근 칩
    function onWeekToggleClick(ev) {
      var ex = ev.target.closest('[data-week-excuse]');
      if (ex) {
        var wi = Number(ex.getAttribute('data-week-excuse'));
        state.weekExcuse[wi] = !state.weekExcuse[wi];
        recalcPayroll();
        return;
      }
      var ab = ev.target.closest('[data-week-absent]');
      if (ab) {
        var ai = Number(ab.getAttribute('data-week-absent'));
        state.weekAbsent[ai] = !state.weekAbsent[ai];
        recalcPayroll();
      }
    }
    $('monthCalBody').addEventListener('click', onWeekToggleClick);
    $('monthCalCards').addEventListener('click', onWeekToggleClick);

    function onCalDayClick(ev) {
      var cell = ev.target.closest('[data-day-idx]');
      if (!cell) return;
      var idx = Number(cell.getAttribute('data-day-idx'));
      loadDayIntoEditor(idx);
      recalcPayroll();
    }
    $('monthCalBody').addEventListener('click', onCalDayClick);
    $('monthCalCards').addEventListener('click', onCalDayClick);

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

    // 빠른 시간대 프리셋 (사용자 정의, 최대 20개)
    initTimePresets();

    // 적용 범위 버튼들
    $('btnApplySelectedDay').addEventListener('click', function () {
      applyEditorToSelectedDay();
      var cd = state.calendar.days[state.selectedDayIdx];
      showToast('✓ ' + cd.date + '일(' + cd.dayName + ')에 적용되었습니다.');
    });

    $('btnApplyWeekday').addEventListener('click', function () {
      var sh = currentEditorShift();
      state.calendar.days.forEach(function (cd, i) {
        if (!cd.isWeekend) {
          state.dailyShifts[i] = { off: sh.off, start: sh.start, end: sh.end, breakMinutes: sh.breakMinutes };
        }
      });
      recalcPayroll();
      showToast('📅 평일(월~금) 전체에 ' + (sh.off ? '휴무' : (sh.start + '~' + sh.end)) + ' 일괄 적용!');
    });

    $('btnApplyWeekend').addEventListener('click', function () {
      var sh = currentEditorShift();
      state.calendar.days.forEach(function (cd, i) {
        if (cd.isWeekend) {
          state.dailyShifts[i] = { off: sh.off, start: sh.start, end: sh.end, breakMinutes: sh.breakMinutes };
        }
      });
      recalcPayroll();
      showToast('📅 주말(토·일) 전체에 ' + (sh.off ? '휴무' : (sh.start + '~' + sh.end)) + ' 일괄 적용!');
    });

    $('btnApplySameDow').addEventListener('click', function () {
      var sh = currentEditorShift();
      var targetDow = state.calendar.days[state.selectedDayIdx].dow;
      var dayName = E.DAY_NAMES[targetDow];
      state.calendar.days.forEach(function (cd, i) {
        if (cd.dow === targetDow) {
          state.dailyShifts[i] = { off: sh.off, start: sh.start, end: sh.end, breakMinutes: sh.breakMinutes };
        }
      });
      recalcPayroll();
      showToast('📅 이번 달 모든 ' + dayName + '요일에 ' + (sh.off ? '휴무' : (sh.start + '~' + sh.end)) + ' 일괄 적용!');
    });

    $('btnSetDayOff').addEventListener('click', function () {
      state.editor.off = true;
      applyEditorToSelectedDay();
      var cd = state.calendar.days[state.selectedDayIdx];
      showToast('🚫 ' + cd.date + '일(' + cd.dayName + ') 휴무 처리');
    });

    $('btnClearAllDays').addEventListener('click', function () {
      state.dailyShifts = state.calendar.days.map(function () {
        return { off: true, start: '09:00', end: '14:00', breakMinutes: 0 };
      });
      state.editor.off = true;
      recalcPayroll();
      showToast('📅 이번 달 전체를 휴무(0시간)로 초기화했습니다.');
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
      state.roster.forEach(function (x) { if (x && /^\d{4}-\d{2}$/.test(x.payMonth || '')) has[x.payMonth] = true; });
      $('mpYearLabel').textContent = mpYear + '년';
      var html = '';
      for (var mo = 1; mo <= 12; mo++) {
        var key = mpYear + '-' + pad2(mo);
        html += '<button type="button" class="mp-month' + (cur.y === mpYear && cur.m === mo ? ' current' : '') + (has[key] ? ' has' : '') +
          '" data-mp="' + key + '">' + mo + '월</button>';
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
      state.weekExcuse = [];
      state.weekAbsent = [];
      ensureCalendarAndShifts($('pMonth').value, false);
      recalcPayroll();
      showToast('📅 ' + state.calendar.year + '년 ' + state.calendar.month + '월 달력 (' + state.calendar.weekCount + '개 주차) 적용');
    });

    // 급여 폼 실시간 반응
    ['pName', 'pWage', 'pMealMinHours', 'pMealAmount'].forEach(function (id) {
      $(id).addEventListener('input', recalcPayroll);
    });
    ['pWeekly', 'pMeal'].forEach(function (id) {
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
      // 같은 사람·같은 달이 이미 있으면 새로 쌓지 않고 최신 내용으로 덮어씀 (엑셀 월별 탭 중복 방지)
      var dupIdx = -1;
      state.roster.forEach(function (x, i) {
        if (dupIdx < 0 && x.name === r.input.name && x.payMonth === r.input.payMonth) dupIdx = i;
      });
      if (dupIdx >= 0) {
        state.roster[dupIdx] = r.input;
      } else {
        state.roster.push(r.input);
      }
      saveJson(KEYS.roster, state.roster);
      renderRoster();
      showToast((dupIdx >= 0 ? '🔄 ' : '➕ ') + '정산 명단에 ' + r.name + '님(' + E.formatWon(r.net) + '원) ' + (dupIdx >= 0 ? '갱신' : '추가'));
    });

    $('rosterBody').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-del-roster]');
      if (!btn) return;
      var idx = Number(btn.getAttribute('data-del-roster'));
      if (idx >= 0 && idx < state.roster.length) {
        if (!window.confirm('"' + (state.roster[idx].name || '이 사람') + '"님을 정산 명단에서 삭제할까요?')) return;
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
      showToast('🗂️ 점검 보관함에 ' + (c.date || '오늘') + ' 점검표 저장 (' + c.verdict + ')');
    });

    $('archiveBody').addEventListener('click', function (ev) {
      var btn = ev.target.closest('[data-del-archive]');
      if (!btn) return;
      var idx = Number(btn.getAttribute('data-del-archive'));
      if (idx >= 0 && idx < state.archive.length) {
        if (!window.confirm('이 점검 기록을 삭제할까요?')) return;
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
      roster: state.roster,
      archive: state.archive,
      presets: presetState.list,
      store: loadJson(KEYS.store, {})
    };
  }

  function cloudTables() {
    var roster = [['이름', '지급월', '총 근무시간(h)', '시급(원)', '주휴수당(원)', '식대(원)', '세전 합계(원)', '공제(원)', '실수령액(원)']];
    state.roster.forEach(function (inp) {
      var r = E.calculatePayroll(inp);
      roster.push([r.name, r.payMonthLabel, r.totalHours, r.hourlyWage, r.weeklyAllowance, r.mealAllowance, r.gross, r.tax.total, r.net]);
    });
    var archive = [['점검일자', '매장명', '점검자', '냉장(°C)', '냉동(°C)', '적합 항목', '결과', '점검필요 항목', '특이사항']];
    state.archive.forEach(function (inp) {
      var c = E.buildChecklist(inp);
      var fails = c.items.filter(function (it) { return !it.ok; }).map(function (it) { return it.no + '. ' + it.text; }).join('\n');
      archive.push([c.date || '-', c.store, c.inspector, c.fridgeTemp === null ? '' : c.fridgeTemp, c.freezerTemp === null ? '' : c.freezerTemp,
        c.passCount + ' / ' + c.total, c.verdict, fails || '-', c.memo || '-']);
    });
    return { roster: roster.length > 1 ? roster : [], archive: archive.length > 1 ? archive : [] };
  }

  function cloudApply(d) {
    d = d || {};
    syncSuspended = true;
    try {
      state.roster = Array.isArray(d.roster) ? d.roster : [];
      state.archive = Array.isArray(d.archive) ? d.archive : [];
      saveJson(KEYS.roster, state.roster);
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
      renderRoster();
      renderArchive();
      recalcChecklist();
    } finally {
      syncSuspended = false;
    }
  }

  function renderCloudUi(st) {
    var btn = $('cloudBtn');
    var body = $('cloudBody');
    if (!btn || !body) return;
    var connected = !!(st && st.connected);
    var kind = st ? st.kind : 'off';
    var clock = fmtClock(st && st.lastSaved);

    if (!connected && kind !== 'saving') { btn.textContent = '☁️ 구글 저장'; btn.className = 'cloud-btn'; }
    else if (kind === 'saving') { btn.textContent = '☁️ 저장 중…'; btn.className = 'cloud-btn'; }
    else if (kind === 'needLogin' || kind === 'error') { btn.textContent = '⚠️ 다시 연결'; btn.className = 'cloud-btn bad'; }
    else { btn.textContent = '☁️ 저장됨' + (clock ? ' ' + clock : ''); btn.className = 'cloud-btn ok'; }

    var html;
    if (!connected) {
      html =
        '<p class="cloud-lead">알바 명단과 점검 기록을 <b>내 구글 드라이브</b>에 자동으로 저장합니다. 휴대폰을 바꾸거나 다른 컴퓨터에서 열어도 같은 기록을 볼 수 있어요.</p>' +
        '<ul class="cloud-points">' +
        '<li>내 구글 드라이브에 <b>"사장님 도우미 데이터"</b> 파일이 만들어집니다</li>' +
        '<li>이 앱이 만든 파일 외에는 볼 수 없습니다</li>' +
        '<li>저장된 내용은 개발자도 볼 수 없습니다</li>' +
        '<li>언제든 연동을 끊을 수 있습니다</li>' +
        '</ul>' +
        '<button type="button" class="btn btn-primary cloud-big" data-cloud="connect"' + (kind === 'saving' ? ' disabled' : '') + '>구글 계정으로 연동하기</button>' +
        (kind === 'error' && st.text ? '<p class="cloud-warn">' + escHtml(st.text) + '</p>' : '');
    } else {
      var head, cls = 'ok';
      if (kind === 'saving') { head = '⏳ ' + escHtml(st.text || '저장 중…'); cls = ''; }
      else if (kind === 'needLogin') { head = '⚠️ 구글 연결을 다시 해 주세요'; cls = 'bad'; }
      else if (kind === 'error') { head = '⚠️ 저장하지 못했습니다'; cls = 'bad'; }
      else { head = '✅ 구글 시트에 자동 저장 중'; }
      html =
        '<p class="cloud-state ' + cls + '">' + head + '</p>' +
        '<p class="cloud-sub">' + (clock ? '마지막 저장 ' + clock + ' · ' : '') + '내용을 바꾸면 몇 초 뒤 자동으로 저장됩니다.</p>' +
        ((kind === 'needLogin' || kind === 'error') && st.text ? '<p class="cloud-warn">' + escHtml(st.text) + '</p>' : '') +
        '<div class="cloud-actions">' +
        ((kind === 'needLogin' || kind === 'error')
          ? '<button type="button" class="btn btn-primary" data-cloud="save">다시 연결하고 저장하기</button>'
          : '<button type="button" class="btn btn-primary" data-cloud="save">지금 저장</button>') +
        '<button type="button" class="btn" data-cloud="open">📄 구글 시트 열어보기</button>' +
        '<button type="button" class="btn" data-cloud="load">⬇️ 시트에서 다시 불러오기</button>' +
        '<button type="button" class="btn btn-ghost" data-cloud="off">연동 끊기</button>' +
        '</div>';
    }
    html +=
      '<div class="cloud-backup">' +
      '<h3 class="cloud-backup-title">💾 백업 파일</h3>' +
      '<p class="cloud-sub">구글 계정을 바꾸거나 다른 기기로 옮길 때 쓰세요. 모든 기록이 파일 하나로 저장됩니다.</p>' +
      '<div class="cloud-actions">' +
      '<button type="button" class="btn" data-cloud="backup-save">⬇️ 백업 파일 내려받기</button>' +
      '<button type="button" class="btn" data-cloud="backup-load">⬆️ 백업 파일 불러오기</button>' +
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
    showToast('💾 백업 파일을 내려받았습니다 (' + state.roster.length + '명 · 점검 ' + state.archive.length + '일)');
  }

  function backupRestore(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var r = E.parseBackup(String(reader.result || ''));
      if (!r.ok) { window.alert(r.error); return; }
      var msg = '백업 파일의 기록으로 바꿉니다.\n\n' +
        '불러올 기록: 정산 명단 ' + r.counts.roster + '명 · 점검 보관함 ' + r.counts.archive + '일\n' +
        '지금 화면의 기록: 정산 명단 ' + state.roster.length + '명 · 점검 보관함 ' + state.archive.length + '일 (사라집니다)\n\n계속할까요?';
      if (!window.confirm(msg)) return;
      cloudApply(r.data);
      if (window.AlbaCloud) window.AlbaCloud.markDirty();
      showToast('⬆️ 백업 파일을 불러왔습니다' + (r.counts.skipped ? ' (읽을 수 없는 ' + r.counts.skipped + '건 제외)' : ''));
    };
    reader.onerror = function () { window.alert('파일을 읽지 못했습니다.'); };
    reader.readAsText(file);
  }

  function initCloud() {
    var C = window.AlbaCloud;
    if (!C) { var b = $('cloudBtn'); if (b) b.hidden = true; return; }
    C.init({
      getData: cloudData,
      getTables: cloudTables,
      applyData: cloudApply,
      confirm: function (m) { return window.confirm(m); },
      onStatus: renderCloudUi
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
        C.connect().then(function (ok) { if (ok) showToast('☁️ 구글 시트 연동 완료'); });
      } else if (act === 'save') {
        C.saveNow().then(function (ok) { if (ok) showToast('☁️ 구글 시트에 저장했습니다'); });
      } else if (act === 'open') {
        var u = C.sheetUrl();
        if (u) window.open(u, '_blank', 'noopener');
      } else if (act === 'load') {
        if (!window.confirm('구글 시트에 저장된 내용으로 이 화면의 기록을 바꿉니다.\n계속할까요?')) return;
        C.loadFromSheet().then(function (r) {
          showToast(r === 'ok' ? '⬇️ 구글 시트에서 불러왔습니다' : (r === 'empty' ? '시트에 저장된 기록이 없습니다' : '불러오지 못했습니다'));
        });
      } else if (act === 'off') {
        if (!window.confirm('구글 연동을 끊을까요?\n이 기기의 기록과 구글 드라이브의 파일은 그대로 남습니다.')) return;
        C.disconnect();
        showToast('구글 연동을 끊었습니다');
      }
    });
    $('backupFile').addEventListener('change', function (ev) {
      backupRestore(ev.target.files && ev.target.files[0]);
      ev.target.value = '';
    });
    renderCloudUi(C.getStatus());
  }

  syncThemeBtn();
  syncFontBtn();
  initTabs();
  initTimePickerChips();
  buildChecklistForm();
  initDefaults();
  bindEvents();
  recalcPayroll();
  recalcChecklist();
  renderRoster();
  renderArchive();
  checkServerHealth();
  initCloud();
  if (window.AlbaCloud) window.AlbaCloud.resume();
})();
