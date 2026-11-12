/*
 * web/gsync.js — 구글 계정 연동 (내 구글 드라이브의 스프레드시트에 자동 저장/불러오기)
 *
 *  - 서버 없이 브라우저에서 구글로 직접 통신합니다. (개발자 서버를 거치지 않음)
 *  - 권한은 drive.file 하나뿐: 이 앱이 만든 파일만 접근할 수 있습니다.
 *  - 구글 로그인 스크립트(accounts.google.com)는 사용자가 연동을 켠 뒤에만 불러옵니다.
 *  - 저장 위치: "사장님 도우미 데이터" 스프레드시트
 *       [2026-11] 같은 월별 탭 : 그 달 정산 요약 + 날짜별 근무 기록 (바뀐 달만 다시 씀)
 *       [알바생] [점검 보관함]  : 사람이 보기 쉬운 표 (앱이 자동으로 다시 씀, 알바생 탭에 고유코드 포함)
 *       [출퇴근기록]            : 출퇴근 프로그램이 한 줄씩 추가할 자리 (앱은 머리글만 만들고 이후 건드리지 않음)
 *       [데이터]                : 앱이 읽는 원본 (수정하지 마세요)
 *  - 월별 탭은 5년(60개월)이 지나면 시트에서만 자동 정리합니다. (앱 안의 기록은 지우지 않음)
 *  - 여러 기기에서 쓰면 마지막에 저장한 내용이 우선합니다.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory;
  } else {
    root.AlbaCloud = factory(browserDeps(root));
  }

  function browserDeps(w) {
    var CLIENT_ID = '310549146073-aqe3emsj9jboa7a1kt95qll9u5lfu9e6.apps.googleusercontent.com';
    var SCOPE = 'https://www.googleapis.com/auth/drive.file';
    var gisPromise = null;
    var tokenClient = null;
    var onToken = null, onError = null;

    function loadGis() {
      if (w.google && w.google.accounts && w.google.accounts.oauth2) return Promise.resolve();
      if (gisPromise) return gisPromise;
      gisPromise = new Promise(function (resolve, reject) {
        var s = w.document.createElement('script');
        s.src = 'https://accounts.google.com/gsi/client';
        s.async = true;
        s.onload = function () { resolve(); };
        s.onerror = function () { gisPromise = null; reject(new Error('구글 로그인 창을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.')); };
        w.document.head.appendChild(s);
      });
      return gisPromise;
    }

    return {
      fetch: function (u, o) { return w.fetch(u, o); },
      storage: {
        get: function (k) { try { return w.localStorage.getItem(k); } catch (e) { return null; } },
        set: function (k, v) { try { w.localStorage.setItem(k, v); } catch (e) {} },
        remove: function (k) { try { w.localStorage.removeItem(k); } catch (e) {} }
      },
      now: function () { return Date.now(); },
      available: function () { return w.location.protocol === 'https:' || w.location.hostname === 'localhost'; },
      // mode: 'first' (계정 선택) | 'user' (사용자가 누른 버튼) | 'silent' (화면 없이 갱신 시도)
      requestToken: function (mode) {
        return loadGis().then(function () {
          return new Promise(function (resolve, reject) {
            if (!tokenClient) {
              tokenClient = w.google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPE,
                callback: function (r) { if (onToken) onToken(r); },
                error_callback: function (e) { if (onError) onError(e); }
              });
            }
            onToken = function (r) {
              if (r && r.error) reject(new Error(r.error));
              else resolve({ token: r.access_token, expiresIn: Number(r.expires_in) || 3600 });
            };
            onError = function (e) { reject(new Error((e && e.type) || 'popup_closed')); };
            tokenClient.requestAccessToken({ prompt: mode === 'first' ? 'select_account' : (mode === 'silent' ? 'none' : '') });
          });
        });
      },
      revoke: function (token) {
        try { if (w.google && w.google.accounts) w.google.accounts.oauth2.revoke(token, function () {}); } catch (e) {}
      }
    };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function create(deps) {
  'use strict';

  var META_KEY = 'alba.cloud.v1';
  var FILE_NAME = '사장님 도우미 데이터';
  var LEGACY_TABS = ['정산 명단'];   // 예전 버전이 만들던 탭 (저장할 때 정리)
  var SHEET_DATA = '데이터';
  var SHEET_PUNCH = '출퇴근기록';   // 나중에 출퇴근 프로그램이 한 줄씩 추가하는 탭 (앱은 처음에 머리글만 만들고 그 뒤로는 건드리지 않음)
  var PUNCH_HEAD = ['기록시각', '알바생 고유코드', '이름', '구분(출근/퇴근)', '입력방식', '처리결과', '메모'];
  var MONTH_TAB = /^\d{4}-\d{2}$/;
  var RETAIN_MONTHS = 60;
  var CHUNK = 40000;
  var SAVE_DELAY = 3000;

  var host = null;
  var meta = readMeta();       // { connected, sheetId, stamp, dirty, lastSaved }
  var token = null, tokenExp = 0;
  var saveTimer = null, saving = false, again = false;
  var lastJson = null;         // 마지막으로 시트와 맞춘 데이터(JSON 문자열)
  var punchHeaderOk = {};      // 시트 id → 이번 실행에서 출퇴근기록 머리글을 확인했는지
  var lastTabs = {};           // 탭 이름 → 마지막으로 시트에 쓴 내용(JSON). 바뀐 탭만 다시 쓰기 위함
  var notice = '';             // 시트 정리 안내 (5년 지난 월 탭 삭제 등)
  var status = { kind: 'off', text: '' };

  function readMeta() {
    try {
      var m = JSON.parse(deps.storage.get(META_KEY) || 'null');
      if (m && typeof m === 'object') return m;
    } catch (e) {}
    return { connected: false, sheetId: '', stamp: '', dirty: false, lastSaved: 0 };
  }
  function writeMeta() { deps.storage.set(META_KEY, JSON.stringify(meta)); }

  function setStatus(kind, text) {
    status = { kind: kind, text: text || '', lastSaved: meta.lastSaved || 0, sheetId: meta.sheetId || '', connected: !!meta.connected, notice: notice };
    if (host && host.onStatus) host.onStatus(status);
  }

  function friendly(e) {
    var m = String((e && e.message) || e || '');
    if (/popup_closed|popup_failed|access_denied/.test(m)) return '구글 로그인이 취소되었습니다.';
    if (/interaction_required|login_required|consent_required|immediate_failed/.test(m)) return '구글 로그인이 필요합니다.';
    if (/^http 403/i.test(m)) return '구글에서 접근이 거절되었습니다. 잠시 후 다시 시도해 주세요.';
    if (/^http 429/i.test(m)) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return '인터넷 연결을 확인해 주세요.';
    return m || '알 수 없는 오류';
  }

  /* ---------------- 토큰 ---------------- */
  function getToken(mode) {
    if (token && deps.now() < tokenExp - 60000) return Promise.resolve(token);
    return deps.requestToken(mode).then(function (r) {
      token = r.token;
      tokenExp = deps.now() + r.expiresIn * 1000;
      return token;
    });
  }

  function api(method, url, body, mode, retried) {
    return getToken(mode || 'silent').then(function (t) {
      var opt = { method: method, headers: { Authorization: 'Bearer ' + t } };
      if (body !== undefined) {
        opt.headers['Content-Type'] = 'application/json';
        opt.body = JSON.stringify(body);
      }
      return deps.fetch(url, opt);
    }).then(function (res) {
      if (res.status === 401 && !retried) {
        token = null;
        return api(method, url, body, mode, true);
      }
      if (!res.ok) {
        var err = new Error('http ' + res.status);
        err.status = res.status;
        return res.text().then(function () { throw err; }, function () { throw err; });
      }
      return res.json();
    });
  }

  var SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

  /* ---------------- 시트 찾기/만들기 ---------------- */
  function findSheet(mode) {
    var q = "name = '" + FILE_NAME + "' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false";
    var url = 'https://www.googleapis.com/drive/v3/files?q=' + encodeURIComponent(q) +
      '&fields=' + encodeURIComponent('files(id,name,modifiedTime)') + '&orderBy=' + encodeURIComponent('modifiedTime desc') + '&pageSize=5';
    return api('GET', url, undefined, mode).then(function (r) {
      return r.files && r.files.length ? r.files[0].id : '';
    });
  }

  function createSheet(mode) {
    var body = {
      properties: { title: FILE_NAME, locale: 'ko_KR' },
      sheets: [{ properties: { title: SHEET_DATA } }]
    };
    return api('POST', SHEETS, body, mode).then(function (r) { return r.spreadsheetId; });
  }

  function ensureSheet(mode) {
    if (meta.sheetId) return Promise.resolve(meta.sheetId);
    return findSheet(mode).then(function (id) {
      return id || createSheet(mode);
    }).then(function (id) {
      meta.sheetId = id;
      writeMeta();
      return id;
    });
  }

  /* ---------------- 읽기/쓰기 ---------------- */
  function pull(mode) {
    var range = encodeURIComponent(SHEET_DATA + '!A1:A300');
    return api('GET', SHEETS + '/' + meta.sheetId + '/values/' + range, undefined, mode).then(function (r) {
      var rows = (r.values || []).map(function (x) { return x[0] === undefined ? '' : String(x[0]); });
      var stamp = rows[1] || '';
      var json = rows.slice(2).join('');
      if (!json) return null;
      try { return { stamp: stamp, data: JSON.parse(json) }; } catch (e) { return null; }
    });
  }

  /* 이번 달 기준 가장 오래 남길 달 (이번 달 포함 60개월) */
  function cutoffMonth() {
    var d = new Date(deps.now());
    var t = new Date(d.getFullYear(), d.getMonth() - (RETAIN_MONTHS - 1), 1);
    return t.getFullYear() + '-' + (t.getMonth() + 1 < 10 ? '0' : '') + (t.getMonth() + 1);
  }

  function tabKey(t) { return JSON.stringify([t.rows, t.bold || []]); }

  function colorFmt() { return { textFormat: { bold: true }, backgroundColor: { red: 0.88, green: 0.92, blue: 1 } }; }

  /* 시트의 탭 구성을 맞추고(추가/삭제/순서), 바뀐 탭만 다시 쓴다 */
  function push(mode) {
    var data = host.getData();
    var json = JSON.stringify(data);
    var stamp = new Date(deps.now()).toISOString();
    var chunks = [];
    for (var i = 0; i < json.length; i += CHUNK) chunks.push([json.slice(i, i + CHUNK)]);
    var tables = host.getTables ? host.getTables() : { sheets: [] };
    var cutoff = cutoffMonth();
    var id = meta.sheetId;

    // 시트에 둘 탭: 5년 이내 월 탭 + 그 외 표 탭 (오래된 월 탭은 시트에서만 뺌)
    var wanted = (tables.sheets || []).filter(function (t) { return !MONTH_TAB.test(t.name) || t.name >= cutoff; });
    // 알바생 탭 바로 뒤에 둔다: 이미 있으면 내용은 절대 다시 쓰지 않는다 (createOnly)
    var punchTab = { name: SHEET_PUNCH, rows: [PUNCH_HEAD], bold: [0], createOnly: true };
    var wi = -1;
    wanted.forEach(function (t, k) { if (t.name === '알바생') wi = k; });
    wanted.splice(wi >= 0 ? wi + 1 : wanted.length, 0, punchTab);
    wanted.push({ name: SHEET_DATA, rows: [['사장님 도우미 데이터 — 이 탭은 앱이 사용하는 저장 공간입니다. 수정하지 마세요.'], [stamp]].concat(chunks), bold: [], always: true });
    var wantedNames = {};
    wanted.forEach(function (t) { wantedNames[t.name] = true; });

    var removedOld = 0;
    var existing = {};
    var created = {};   // 이번 저장에서 새로 만든 탭: 이름 → sheetId

    return api('GET', SHEETS + '/' + id + '?fields=' + encodeURIComponent('sheets.properties(sheetId,title,index)'), undefined, mode).then(function (info) {
      (info.sheets || []).forEach(function (s) { existing[s.properties.title] = s.properties.sheetId; });

      var reqs = [];
      var addNames = [];
      wanted.forEach(function (t) {
        if (existing[t.name] === undefined) { reqs.push({ addSheet: { properties: { title: t.name } } }); addNames.push(t.name); }
      });
      Object.keys(existing).forEach(function (name) {
        var stale = LEGACY_TABS.indexOf(name) >= 0 || (MONTH_TAB.test(name) && !wantedNames[name]);
        if (!stale) return;
        reqs.push({ deleteSheet: { sheetId: existing[name] } });
        if (MONTH_TAB.test(name) && name < cutoff) removedOld++;
        delete existing[name];
        delete lastTabs[name];
      });
      if (!reqs.length) return null;
      return api('POST', SHEETS + '/' + id + ':batchUpdate', { requests: reqs }, mode).then(function (res) {
        var ri = 0;
        reqs.forEach(function (rq, k) {
          if (rq.addSheet) {
            var rp = (res.replies || [])[k];
            var sid = rp && rp.addSheet && rp.addSheet.properties ? rp.addSheet.properties.sheetId : undefined;
            if (sid !== undefined) { existing[rq.addSheet.properties.title] = sid; created[rq.addSheet.properties.title] = sid; }
          }
          ri++;
        });
        // 순서: 최근 월 → 알바생 → 점검 보관함 → 데이터
        var order = wanted.map(function (t) { return t.name; });
        var orderReqs = [];
        order.forEach(function (name, idx) {
          if (existing[name] !== undefined) orderReqs.push({ updateSheetProperties: { properties: { sheetId: existing[name], index: idx }, fields: 'index' } });
        });
        return orderReqs.length ? api('POST', SHEETS + '/' + id + ':batchUpdate', { requests: orderReqs }, mode) : null;
      });
    }).then(function () {
      // 예전에 만든 '출퇴근기록' 탭의 머리글이 새 열 구성과 다르면 첫 줄만 고친다 (아래 기록은 건드리지 않음)
      if (punchHeaderOk[id] || created[SHEET_PUNCH] !== undefined) { punchHeaderOk[id] = true; return null; }
      var rng = encodeURIComponent(SHEET_PUNCH + '!A1:Z1');
      return api('GET', SHEETS + '/' + id + '/values/' + rng, undefined, mode).then(function (r) {
        var cur = (r.values && r.values[0]) || [];
        var same = cur.length === PUNCH_HEAD.length && PUNCH_HEAD.every(function (h, k) { return cur[k] === h; });
        punchHeaderOk[id] = true;
        if (same) return null;
        return api('POST', SHEETS + '/' + id + '/values:batchUpdate', {
          valueInputOption: 'RAW', data: [{ range: SHEET_PUNCH + '!A1', values: [PUNCH_HEAD] }]
        }, mode);
      });
    }).then(function () {
      // 바뀐 탭만 골라서 쓴다 (새로 만든 탭은 무조건)
      var changed = wanted.filter(function (t) {
        if (t.createOnly) return created[t.name] !== undefined;
        return t.always || created[t.name] !== undefined || lastTabs[t.name] !== tabKey(t);
      });
      if (!changed.length) return null;
      var names = changed.map(function (t) { return t.name; });
      return api('POST', SHEETS + '/' + id + '/values:batchClear', { ranges: names }, mode).then(function () {
        return api('POST', SHEETS + '/' + id + '/values:batchUpdate', {
          valueInputOption: 'RAW',
          data: changed.map(function (t) { return { range: t.name + '!A1', values: t.rows && t.rows.length ? t.rows : [['']] }; })
        }, mode);
      }).then(function () {
        // 서식: 먼저 전체 서식을 지운 뒤 제목/머리글 줄만 굵게
        var fmt = [];
        changed.forEach(function (t) {
          var sid = existing[t.name];
          if (sid === undefined || t.name === SHEET_DATA) return;
          fmt.push({ repeatCell: { range: { sheetId: sid }, cell: {}, fields: 'userEnteredFormat' } });
          (t.bold || []).forEach(function (ri) {
            fmt.push({ repeatCell: { range: { sheetId: sid, startRowIndex: ri, endRowIndex: ri + 1 },
              cell: { userEnteredFormat: colorFmt() }, fields: 'userEnteredFormat(textFormat,backgroundColor)' } });
          });
        });
        return fmt.length ? api('POST', SHEETS + '/' + id + ':batchUpdate', { requests: fmt }, mode).catch(function () { /* 서식 실패는 저장 실패가 아님 */ }) : null;
      }).then(function () {
        changed.forEach(function (t) { lastTabs[t.name] = tabKey(t); });
      });
    }).then(function () {
      lastJson = json;
      meta.stamp = stamp;
      meta.dirty = false;
      meta.lastSaved = deps.now();
      notice = removedOld ? ('5년이 지난 ' + removedOld + '개 달의 탭을 구글 시트에서 정리했습니다. (이 기기의 기록은 그대로입니다)') : '';
      writeMeta();
    });
  }

  function hasContent(d) {
    return !!d && ((d.workers && d.workers.length) || (d.roster && d.roster.length) || (d.archive && d.archive.length));
  }

  function applyRemote(r) {
    host.applyData(r.data);
    lastJson = JSON.stringify(host.getData());
    meta.stamp = r.stamp;
    meta.dirty = false;
    meta.lastSaved = deps.now();
    writeMeta();
  }

  /* 시트가 사라졌을 때(사용자가 삭제) 새로 연결 */
  function withSheetRetry(fn, mode) {
    return fn().catch(function (e) {
      if (e && (e.status === 404 || e.status === 403) && meta.sheetId) {
        meta.sheetId = '';
        writeMeta();
        return ensureSheet(mode).then(fn);
      }
      throw e;
    });
  }

  /* ---------------- 공개 기능 ---------------- */
  function connect() {
    if (!deps.available()) {
      setStatus('error', '이 기능은 인터넷 주소(https)로 접속했을 때만 사용할 수 있습니다.');
      return Promise.resolve(false);
    }
    setStatus('saving', '구글 연결 중…');
    return getToken(meta.connected ? 'user' : 'first').then(function () {
      return ensureSheet('user');
    }).then(function () {
      return withSheetRetry(function () { return pull('user'); }, 'user');
    }).then(function (remote) {
      var local = host.getData();
      if (remote && hasContent(remote.data)) {
        var same = JSON.stringify(remote.data) === JSON.stringify(local);
        if (!same && hasContent(local)) {
          var useRemote = host.confirm('이 구글 계정에 저장된 기록이 이미 있습니다.\n\n[확인] 구글 시트에 저장된 기록을 불러옵니다 (이 기기의 기록은 대체됩니다)\n[취소] 이 기기의 기록을 구글 시트에 저장합니다 (시트의 기존 기록은 대체됩니다)');
          if (useRemote) applyRemote(remote);
          else return push('user');
        } else if (!same) {
          applyRemote(remote);
        } else {
          lastJson = JSON.stringify(local);
          meta.stamp = remote.stamp;
          meta.dirty = false;
        }
        return null;
      }
      return push('user');
    }).then(function () {
      meta.connected = true;
      if (!meta.lastSaved) meta.lastSaved = deps.now();
      writeMeta();
      setStatus('saved', '');
      return true;
    }).catch(function (e) {
      setStatus(meta.connected ? 'needLogin' : 'error', friendly(e));
      return false;
    });
  }

  /* 앱을 열 때: 연동되어 있으면 최신 내용을 받아 온다 */
  function resume() {
    if (!meta.connected || !meta.sheetId) { setStatus('off'); return Promise.resolve(); }
    if (!deps.available()) { setStatus('off'); return Promise.resolve(); }
    setStatus('saving', '구글 시트 확인 중…');
    return getToken('silent').then(function () {
      return withSheetRetry(function () { return pull('silent'); }, 'silent');
    }).then(function (remote) {
      if (meta.dirty) return push('silent');          // 이 기기에 저장 안 된 변경이 있으면 우선
      if (remote && remote.stamp > (meta.stamp || '')) applyRemote(remote);
      else lastJson = JSON.stringify(host.getData());
    }).then(function () {
      setStatus('saved', '');
    }).catch(function (e) {
      setStatus('needLogin', friendly(e));
    });
  }

  function doSave(mode) {
    if (!meta.connected) return Promise.resolve(false);
    if (saving) { again = true; return Promise.resolve(false); }
    saving = true;
    setStatus('saving', '저장 중…');
    return withSheetRetry(function () { return push(mode); }, mode).then(function () {
      setStatus('saved', '');
      return true;
    }).catch(function (e) {
      meta.dirty = true;
      writeMeta();
      setStatus(mode === 'silent' ? 'needLogin' : 'error', friendly(e));
      return false;
    }).then(function (ok) {
      saving = false;
      if (again) { again = false; schedule(); }
      return ok;
    });
  }

  var setT = deps.setTimeout || function (f, ms) { return setTimeout(f, ms); };
  var clearT = deps.clearTimeout || function (t) { clearTimeout(t); };

  function schedule() {
    if (saveTimer) clearT(saveTimer);
    saveTimer = setT(function () { saveTimer = null; doSave('silent'); }, SAVE_DELAY);
  }

  /* 앱에서 저장할 내용이 바뀔 때마다 호출 */
  function markDirty() {
    if (!meta.connected || !host) return;
    var json = JSON.stringify(host.getData());
    if (json === lastJson) return;
    meta.dirty = true;
    writeMeta();
    schedule();
  }

  /* 출퇴근 기록 한 줄씩 '출퇴근기록' 탭 맨 아래에 덧붙임 (연동 중일 때만). 실패하면 거절 → 호출한 쪽이 보관했다가 다시 시도 */
  function appendPunch(rows) {
    if (!meta.connected || !meta.sheetId) return Promise.reject(new Error('not connected'));
    if (!rows || !rows.length) return Promise.resolve();
    var url = SHEETS + '/' + meta.sheetId + '/values/' + encodeURIComponent(SHEET_PUNCH + '!A:G') +
      ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
    return api('POST', url, { values: rows }, 'silent');
  }

  function saveNow() {
    if (saveTimer) { clearT(saveTimer); saveTimer = null; }
    return doSave('user');
  }

  function loadFromSheet() {
    setStatus('saving', '불러오는 중…');
    return getToken('user').then(function () {
      return withSheetRetry(function () { return pull('user'); }, 'user');
    }).then(function (remote) {
      if (!remote) { setStatus('saved', ''); return 'empty'; }
      applyRemote(remote);
      setStatus('saved', '');
      return 'ok';
    }).catch(function (e) {
      setStatus('error', friendly(e));
      return 'error';
    });
  }

  function disconnect() {
    if (saveTimer) { clearT(saveTimer); saveTimer = null; }
    if (token) deps.revoke(token);
    token = null; tokenExp = 0;
    meta = { connected: false, sheetId: '', stamp: '', dirty: false, lastSaved: 0 };
    deps.storage.remove(META_KEY);
    lastJson = null;
    lastTabs = {};
    punchHeaderOk = {};
    notice = '';
    setStatus('off');
  }

  return {
    init: function (h) { host = h; },
    connect: connect,
    resume: resume,
    markDirty: markDirty,
    saveNow: saveNow,
    appendPunch: appendPunch,
    loadFromSheet: loadFromSheet,
    disconnect: disconnect,
    isConnected: function () { return !!meta.connected; },
    getStatus: function () {
      status.lastSaved = meta.lastSaved || 0;
      status.connected = !!meta.connected;
      status.sheetId = meta.sheetId || '';
      return status;
    },
    sheetUrl: function () { return meta.sheetId ? 'https://docs.google.com/spreadsheets/d/' + meta.sheetId + '/edit' : ''; }
  };
});
