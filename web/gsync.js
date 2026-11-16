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
        s.onerror = function () { gisPromise = null; reject(new Error(tr('구글 로그인 창을 불러오지 못했습니다. 인터넷 연결을 확인해 주세요.'))); };
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
  function tr(s, v) { var E = (typeof window !== 'undefined' && window.AlbaEngine) || null; return E && E.t ? E.t(s, v) : (v ? s.replace(/\{(\w+)\}/g, function (m, k) { return v[k] === undefined ? m : v[k]; }) : s); }
  var FILE_NAME = '사장님 도우미 데이터';
  var LEGACY_TABS = ['정산 명단'];   // 예전 버전이 만들던 탭 (저장할 때 정리)
  var SHEET_DATA = '데이터';
  var SHEET_PUNCH = '출퇴근기록';   // 나중에 출퇴근 프로그램이 한 줄씩 추가하는 탭 (앱은 처음에 머리글만 만들고 그 뒤로는 건드리지 않음)
  var PUNCH_HEAD = ['기록시각', '알바생 고유코드', '이름', '구분(출근/퇴근)', '입력방식', '처리결과', '메모'];
  var SHEET_ADMIN = '관리자';
  var SHEET_DEV = '기기';           // 출퇴근 기기 지정: A1 기기ID | B1 이름 | C1 마지막 응답 시각 | D1 앱 버전
  var SHEET_REQ = '수정요청';       // 다른 기기가 보낸 수정 요청 (덧붙이기만). 상태 칸은 사람이 보는 참고용, 진실은 데이터의 reqLog
  var REQ_HEAD = ['요청ID', '보낸 시각', '기기ID', '기기 이름', '설명', '변경(JSON)', '상태', '처리 시각', '사유'];       // 관리자 비밀번호 복구용 탭: B1 칸이 비밀번호 (사장님이 시트에서 고치면 앱의 '시트에서 다시 불러오기'로 적용)
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
    if (/popup_closed|popup_failed|access_denied/.test(m)) return tr('구글 로그인이 취소되었습니다.');
    if (/interaction_required|login_required|consent_required|immediate_failed/.test(m)) return tr('구글 로그인이 필요합니다.');
    if (/^http 403/i.test(m)) return tr('구글에서 접근이 거절되었습니다. 잠시 후 다시 시도해 주세요.');
    if (/^http 429/i.test(m)) return tr('요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
    if (/Failed to fetch|NetworkError|network/i.test(m)) return tr('인터넷 연결을 확인해 주세요.');
    return m || tr('알 수 없는 오류');
  }

  /* ---------------- 토큰 ---------------- */
  /* 구글 접속 토큰(약 1시간 유효)을 이 기기에 잠깐 보관: 새로고침해도 유효한 동안은 다시 로그인하지 않는다 */
  var TOKEN_KEY = 'alba.cloud.tok';
  var refreshTimer = null;
  function loadStoredToken() {
    try {
      var t = JSON.parse(deps.storage.get(TOKEN_KEY) || 'null');
      if (t && t.token && t.exp > deps.now() + 60000) { token = t.token; tokenExp = t.exp; }
    } catch (e) {}
  }
  function storeToken() {
    try { deps.storage.set(TOKEN_KEY, JSON.stringify({ token: token, exp: tokenExp })); } catch (e) {}
  }
  function scheduleRefresh() {
    if (refreshTimer) { clearT(refreshTimer); refreshTimer = null; }
    var wait = Math.max(30000, tokenExp - deps.now() - 5 * 60000);   // 만료 5분 전에 조용히 갱신 시도
    refreshTimer = setT(function () {
      refreshTimer = null;
      if (!meta.connected) return;
      fetchToken('silent').then(function () { setStatus('saved', ''); }).catch(function () { setStatus('needLogin', tr('구글 로그인이 필요합니다.')); });
    }, wait);
  }
  function fetchToken(mode) {
    return deps.requestToken(mode).then(function (r) {
      token = r.token;
      tokenExp = deps.now() + r.expiresIn * 1000;
      storeToken();
      scheduleRefresh();
      return token;
    });
  }
  function getToken(mode) {
    if (token && deps.now() < tokenExp - 60000) return Promise.resolve(token);
    return fetchToken(mode);
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
  function stampMs(st) { return Date.parse(String(st || '').split('#')[0]) || 0; }
  function pullStamp(mode) {
    return api('GET', SHEETS + '/' + meta.sheetId + '/values/' + encodeURIComponent(SHEET_DATA + '!A2'), undefined, mode).then(function (r) {
      return r && r.values && r.values[0] ? String(r.values[0][0] || '').split('|')[0] : '';
    });
  }
  function pull(mode) {
    var range = encodeURIComponent(SHEET_DATA + '!A1:A300');
    return api('GET', SHEETS + '/' + meta.sheetId + '/values/' + range, undefined, mode).then(function (r) {
      var rows = (r.values || []).map(function (x) { return x[0] === undefined ? '' : String(x[0]); });
      var lineage = String(rows[1] || '').split('|').filter(Boolean);   // 저장 표시|이 저장이 바탕으로 한 이전 저장 표시들…
      var stamp = lineage[0] || '';
      var json = rows.slice(2).join('');
      if (!json) return null;
      try { return { stamp: stamp, lineage: lineage, data: JSON.parse(json) }; } catch (e) { return null; }
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

  /* 시트에 저장하는 데이터 = 앱 데이터 + 요청 처리 기록(reqLog: 출퇴근 기기만 씀, 이 모듈이 보관) */
  function dataOut() {
    var d = host.getData();
    if (meta.reqLog) { var o = {}; Object.keys(d || {}).forEach(function (k) { o[k] = d[k]; }); o.reqLog = meta.reqLog; return o; }
    return d;
  }
  function toHost(d) {
    if (d && isObj(d.reqLog)) meta.reqLog = d.reqLog;
    host.applyData(d);
  }

  /* 시트의 탭 구성을 맞추고(추가/삭제/순서), 바뀐 탭만 다시 쓴다 */
  var LOST_WRITER = { lost: true };
  function push(mode, force) {
    if (role() === 'requester') return flushRequests();
    if (force || !meta.stamp || !meta.sheetId) return pushNow(mode);
    // 출퇴근 기기는 쓰기 직전에 '아직 내가 지정 기기인지' 확인 (교체됐으면 쓰지 않고 요청 기기로)
    var fence = role() === 'writer' ? readHead(mode, 0).then(function (h) { updateDev(h.dev); if (role() !== 'writer') throw LOST_WRITER; }) : Promise.resolve();
    return fence.then(function () {
      if (meta.replayStamp) return replayPending().then(function () { return push2(mode); });
      return push2(mode);
    }).catch(function (e) { if (e === LOST_WRITER) return loseWriter(); throw e; });
  }
  function push2(mode) {
    // 내가 마지막으로 맞춘 뒤 다른 기기가 저장했으면 덮어쓰지 않고 합친 뒤 저장
    return pull(mode).then(function (remote) {
      if (remote && remote.stamp === meta.stamp) confirmWritten();
      if (!remote || remote.stamp === meta.stamp || !hasContent(remote.data)) return pushNow(mode);
      settleWritten(remote);
      var merged = mergeData(loadBase(), JSON.parse(JSON.stringify(dataOut())), remote.data);
      saveBase(JSON.stringify(remote.data));   // 지금 시트 내용을 봤으니 이게 새 기준
      meta.stamp = remote.stamp; meta.lineage = remote.lineage; writeMeta();
      toHost(merged);
      merges++;
      return replayAfter(remote.stamp).then(function () { return pushNow(mode); });
    });
  }
  /* 장부 재생: 실패하면(일시 네트워크 오류 등) 기억해 두었다가 다음 새로 받기 때 다시 시도 */
  //    (meta.replayStamp에 남겨 앱을 껐다 켜도 이어서, 저장하기 전에도 먼저 재생 → 빠진 출퇴근이 새 저장에 묻히지 않게)
  function replayAfter(stamp) {
    if (!host.replayPunchLog || !meta.sheetId) return Promise.resolve();
    var rng = encodeURIComponent(SHEET_PUNCH + '!A2:G');
    return api('GET', SHEETS + '/' + meta.sheetId + '/values/' + rng, undefined, 'silent').then(function (res) {
      host.replayPunchLog((res && res.values) || [], stampMs(stamp));
      if (meta.replayStamp) { delete meta.replayStamp; writeMeta(); }
    }).catch(function () { if (!meta.replayStamp || stampMs(stamp) < stampMs(meta.replayStamp)) { meta.replayStamp = stamp; writeMeta(); } });
  }
  function replayPending() { return meta.replayStamp ? replayAfter(meta.replayStamp) : Promise.resolve(); }
  var merges = 0;

  /* 데이터 저장과 함께 쓸 칸들 (수정요청 상태 칸 등). 저장이 실패하거나 앱이 꺼져도 다음 저장 때 쓰도록 meta에 보관 */
  function pendWrites() { return Array.isArray(meta.pendWrites) ? meta.pendWrites : []; }
  function pushNow(mode) {
    var data = dataOut();
    var json = JSON.stringify(data);
    // 저장 표시: 시각 + 기기별 임의 글자 (두 기기가 같은 순간에 저장해도 표시가 겹치지 않게)
    var stamp = new Date(deps.now()).toISOString() + '#' + Math.random().toString(36).slice(2, 8);
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
    if (role() === 'writer') wanted.splice(wanted.indexOf(punchTab) + 1, 0, { name: SHEET_REQ, rows: [REQ_HEAD], bold: [0], createOnly: true });
    var adminPin = host.getAdminPin ? String(host.getAdminPin() || '') : '';
    if (adminPin) {
      // 관리자 탭은 처음 만들 때만 적고, 그 뒤로는 앱이 덮어쓰지 않음 (사장님이 시트에서 고친 값을 지키기 위해)
      wanted.splice(wanted.indexOf(punchTab) + 1, 0, {
        name: SHEET_ADMIN, bold: [0], createOnly: true,
        rows: [['관리자 비밀번호', adminPin], ['※ 잊었다면 위 오른쪽 칸을 새 비밀번호(4자 이상)로 고치세요. 그다음 매장 기기의 잠금 창에서 [비밀번호를 잊었어요]를 누르면 적용됩니다.']]
      });
    }
    // 데이터 탭은 300줄을 한 번에 통째로 씀 (빈 줄까지): 두 기기가 동시에 저장해도 긴 내용의 꼬리가 남아 내용이 섞이지 않게
    var prev = meta.lineage && meta.lineage.length ? meta.lineage : (meta.stamp ? [meta.stamp] : []);
    var lineage = [stamp].concat(prev).slice(0, 40);
    var dataRows = [['사장님 도우미 데이터 — 이 탭은 앱이 사용하는 저장 공간입니다. 수정하지 마세요.'], [lineage.join('|')]].concat(chunks);
    while (dataRows.length < 300) dataRows.push(['']);
    wanted.push({ name: SHEET_DATA, rows: dataRows, bold: [], always: true });
    var wantedNames = {};
    wanted.forEach(function (t) { wantedNames[t.name] = true; });
    wantedNames[SHEET_ADMIN] = true;   // 이 기기에 비밀번호가 없어도(저장소를 지운 경우 등) 시트의 복구용 탭은 지우지 않음

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
      // 데이터 탭은 늘 300줄을 통째로 덮어쓰므로 지우지 않음 (지운 직후 끊기면 시트가 잠깐 비는 일 방지)
      var names = changed.filter(function (t) { return t.name !== SHEET_DATA; }).map(function (t) { return t.name; });
      var clear = names.length ? api('POST', SHEETS + '/' + id + '/values:batchClear', { ranges: names }, mode) : Promise.resolve();
      var extra = pendWrites().slice(), nExtra = extra.length;
      if (role() === 'writer') extra.push({ range: SHEET_DEV + '!C1:D1', values: [[new Date(deps.now()).toISOString(), appVer()]] });   // 응답 시각
      return clear.then(function () {
        return api('POST', SHEETS + '/' + id + '/values:batchUpdate', {
          valueInputOption: 'RAW',
          data: changed.map(function (t) { return { range: t.name + '!A1', values: t.rows && t.rows.length ? t.rows : [['']] }; }).concat(extra)
        }, mode).then(function (r) {
          meta.pendWrites = pendWrites().slice(nExtra);
          if (role() === 'writer') meta.lastBeat = deps.now();
          return r;
        });
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
      saveWritten(json);   // 기준은 다음 확인 때 확정 (그사이 다른 기기가 덮어썼다면 내 변경을 다시 합쳐 올림)
      meta.stamp = stamp;
      meta.lineage = lineage;
      meta.dirty = false;
      meta.lastSaved = deps.now();
      notice = removedOld ? tr('5년이 지난 {n}개 달의 탭을 구글 시트에서 정리했습니다. (이 기기의 기록은 그대로입니다)', { n: removedOld }) : '';
      writeMeta();
    });
  }

  /* ---------- 세 갈래 합치기 ----------
     base: 이 기기가 마지막으로 시트와 맞췄을 때 내용, local: 지금 이 기기, remote: 지금 시트(다른 기기가 저장).
     양쪽에서 바뀐 부분을 모두 살린다. 알바생·목록은 id(없으면 내용)로 맞추고, 같은 길이 배열(날짜별 근무)은 칸별로 합친다.
     같은 칸을 양쪽이 다르게 바꾼 경우만 이 기기 쪽을 남긴다. */
  function jeq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function keyedArr(a) { return Array.isArray(a) && a.length > 0 && a.every(function (x) { return isObj(x) && typeof x.id === 'string' && x.id; }); }
  /* 합치는 중 '같은 칸을 양쪽이 서로 다르게 바꿔 이 기기 값으로 정한 곳'을 모음 → 화면에서 알림 */
  var conflictSink = null;
  function noteConflict(path, l, r) { if (conflictSink) conflictSink.push({ path: path.slice(), local: l, remote: r }); }
  /* 처리 끝 표시(묘비)처럼 늘어나기만 하는 목록: 양쪽 합집합 (최근 200개) */
  function unionList(a, b) {
    var out = [], seen = {};
    (Array.isArray(a) ? a : []).concat(Array.isArray(b) ? b : []).forEach(function (x) { var k = JSON.stringify(x); if (!seen[k]) { seen[k] = true; out.push(x); } });
    out.sort(function (x, y) { x = String(x); y = String(y); return x < y ? -1 : x > y ? 1 : 0; });   // 어느 기기에서 합쳐도 같은 순서
    return out.slice(-200);
  }
  function merge3(b, l, r, path) {
    path = path || [];
    if (jeq(l, r)) return l;
    if (b !== undefined && jeq(l, b)) return r;
    if (b !== undefined && jeq(r, b)) return l;
    if (l === undefined) return b === undefined ? r : undefined;   // 이 기기가 지움(시트는 그대로면 위에서 처리) / 새로 생긴 건 살림
    if (r === undefined) return b === undefined ? l : undefined;
    if (isObj(l) && isObj(r)) {
      var bo = isObj(b) ? b : {}, out = {}, seen = {};
      Object.keys(l).concat(Object.keys(r)).forEach(function (k) {
        if (seen[k]) return;
        seen[k] = true;
        var v = k === 'pendingDone' && (Array.isArray(l[k]) || Array.isArray(r[k])) ? unionList(l[k], r[k]) : merge3(bo[k], l[k], r[k], path.concat([k]));
        // 한쪽은 칸을 지웠는데 다른 쪽은 그 칸을 새로 바꿨으면 새 값을 남김 (예: 옛 기기가 지난 출근을 퇴근 처리 ↔ 다른 기기에서 오늘 새로 출근)
        if (v === undefined && bo[k] !== undefined) {
          if (l[k] === undefined && r[k] !== undefined && !jeq(r[k], bo[k])) v = r[k];
          else if (r[k] === undefined && l[k] !== undefined && !jeq(l[k], bo[k])) v = l[k];
        }
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    if (Array.isArray(l) && Array.isArray(r)) {
      var ba = Array.isArray(b) ? b : [];
      if ((keyedArr(l) || l.length === 0) && (keyedArr(r) || r.length === 0) && (keyedArr(l) || keyedArr(r))) {
        var idx = function (a) { var m = {}; a.forEach(function (x) { m[x.id] = x; }); return m; };
        var bm = keyedArr(ba) ? idx(ba) : {}, lm = idx(l), rm = idx(r), res = [], done = {};
        l.concat(r).forEach(function (x) {
          if (done[x.id]) return;
          done[x.id] = true;
          var v = merge3(bm[x.id], lm[x.id], rm[x.id], path.concat([x.id]));
          if (v !== undefined) res.push(v);
        });
        return res;
      }
      if (l.length === r.length && (ba.length === l.length || !Array.isArray(b))) {
        return l.map(function (x, i) {
          // 날짜별 근무 칸처럼 자리로 맞추는 객체는 통째 단위로 비교 (출근은 이 기기, 퇴근은 저 기기 값이 섞인 근무가 생기지 않게)
          if (isObj(x) && isObj(r[i]) && !jeq(x, r[i]) && !jeq(x, ba[i]) && !jeq(r[i], ba[i])) {
            // 기준이 없는 칸(양쪽이 같은 달 기록을 새로 만듦): 한쪽만 근무를 넣었으면 그 근무를 살림 (휴무 칸은 기본값)
            if (ba[i] === undefined && x.off === true && r[i].off !== true) return r[i];
            if (ba[i] === undefined && r[i].off === true && x.off !== true) return x;
            noteConflict(path.concat([i]), x, r[i]);
            return x;
          }
          var v = merge3(ba[i], x, r[i], path.concat([i])); return v === undefined ? null : v;
        });
      }
      // 내용으로 맞추는 목록 (점검 보관함 등): 이 기기 목록 + 시트에서 새로 생긴 것 − 시트에서 지운 것
      var key = function (x) { return JSON.stringify(x); };
      var inB = {}, inL = {}, inR = {};
      ba.forEach(function (x) { inB[key(x)] = true; });
      l.forEach(function (x) { inL[key(x)] = true; });
      r.forEach(function (x) { inR[key(x)] = true; });
      var res2 = l.filter(function (x) { return !(inB[key(x)] && !inR[key(x)]); });
      r.forEach(function (x) { if (!inB[key(x)] && !inL[key(x)]) res2.push(x); });
      return res2;
    }
    noteConflict(path, l, r);
    return l;   // 같은 칸을 양쪽이 다르게 바꿈 → 이 기기 쪽 (화면에 알림)
  }
  /* 예전 버전이 저장한 '퇴근 확인 필요' 항목에는 id가 없음 → 합치기 전에 붙여서 항목끼리 맞출 수 있게 */
  function fixPend(d) {
    if (d && Array.isArray(d.workers)) d.workers.forEach(function (w) {
      if (w && Array.isArray(w.pending)) w.pending.forEach(function (p) { if (isObj(p) && !p.id && p.date && p.start) p.id = p.date + ' ' + p.start; });
    });
    return d;
  }
  /* 겹친 수정 기록: 데이터의 conflicts 목록(모든 기기에 공유)에 남겨 사장님이 고르게 함. 출퇴근 내부 상태(근무 중·마지막 기록 등)는 제외 */
  var SKIP_CONFLICT = { lastTs: 1, lastKind: 1, punch: 1, pending: 1, pendingDone: 1, code: 1, conflicts: 1 };
  function hashStr(t) { var h = 5381; for (var i = 0; i < t.length; i++) h = ((h << 5) + h + t.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
  function mergeData(b, l, r) {
    conflictSink = [];
    try {
      var m = merge3(fixPend(b), fixPend(l), fixPend(r), []);
      var found = conflictSink.filter(function (c) { return !c.path.some(function (k) { return SKIP_CONFLICT[k]; }); });
      if (found.length && isObj(m)) {
        var list = Array.isArray(m.conflicts) ? m.conflicts.slice() : [];
        var have = {};
        list.forEach(function (c) { if (c && c.id) have[c.id] = true; });
        found.forEach(function (c) {
          var id = 'c' + hashStr(JSON.stringify([c.path, c.local, c.remote]));
          if (have[id]) return;
          have[id] = true;
          list.push({ id: id, at: new Date(deps.now()).toISOString(), path: c.path, local: c.local === undefined ? null : c.local, remote: c.remote === undefined ? null : c.remote });
        });
        m.conflicts = list.slice(-30);
        if (host && host.onConflicts) { try { host.onConflicts(found.length); } catch (e) {} }
      }
      return m;
    } finally { conflictSink = null; }
  }
  var BASE_KEY = 'alba.cloud.base', WRITTEN_KEY = 'alba.cloud.written';
  function saveBase(json) { try { deps.storage.set(BASE_KEY, json); deps.storage.remove(WRITTEN_KEY); } catch (e) {} }
  /* 방금 시트에 쓴 내용: 거의 동시에 다른 기기가 덮어썼을 수 있으므로, 시트에 내 저장 표시가 그대로 있는 걸 다시 확인한 뒤에 기준으로 삼는다 */
  function saveWritten(json) { try { deps.storage.set(WRITTEN_KEY, json); } catch (e) {} }
  function confirmWritten() { try { var w = deps.storage.get(WRITTEN_KEY); if (w) saveBase(w); } catch (e) {} }
  /* 다른 기기가 저장한 시트를 봤을 때: 그 저장이 내 마지막 저장을 바탕으로 했으면(계보에 있음) 내 저장은 살아 있음 → 기준 확정,
     없으면 내 저장은 동시 저장에 덮인 것 → 예전 기준으로 다시 합쳐 내 변경을 되살림 */
  function settleWritten(remote) {
    var w = null;
    try { w = deps.storage.get(WRITTEN_KEY); } catch (e) {}
    if (!w || !remote) return;
    if (remote.stamp === meta.stamp || (remote.lineage || []).indexOf(meta.stamp) >= 0) saveBase(w);
    else { try { deps.storage.remove(WRITTEN_KEY); } catch (e) {} }
  }
  function loadBase() { try { var t = deps.storage.get(BASE_KEY); return t ? JSON.parse(t) : undefined; } catch (e) { return undefined; } }

  /* ================= 단일 저장: 수정 요청(ops) =================
     path 칸: 객체 키(문자열) · 날짜 칸 같은 자리 배열(숫자) · id 있는 목록의 항목({id})
     op: {path, before, after}  → 지금 값이 before와 같을 때만 after로 (null = 없음)
         {path, add: 항목} / {path, del: 항목} → id 없는 목록(점검 보관함 등): 내용으로 넣고 빼기 */
  function canon(x) {
    if (x === undefined) return 'null';
    if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
    if (isObj(x)) return '{' + Object.keys(x).filter(function (k) { return x[k] !== undefined; }).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(x[k]); }).join(',') + '}';
    return JSON.stringify(x);
  }
  function ceq(a, b) { return canon(a) === canon(b); }
  var POSITIONAL = { dailyShifts: 1, weekExcuse: 1 };
  var SETLIKE = { archive: 1, pendingDone: 1 };
  var SKIP_DIFF = { lastTs: 1, lastKind: 1, punch: 1 };   // 요청 기기는 출퇴근을 못 찍으므로 출퇴근 상태는 요청에 넣지 않음
  function clone(x) { return x === undefined ? undefined : JSON.parse(JSON.stringify(x)); }
  function diffOps(b, c, path, out, all) {
    out = out || []; path = path || [];
    if (ceq(b, c)) return out;
    var last = path[path.length - 1];
    if (!all && typeof last === 'string' && SKIP_DIFF[last] && path.length > 2) return out;
    if (path.length === 1 && last === 'reqLog') return out;
    if (isObj(b) && isObj(c)) {
      var seen = {};
      Object.keys(b).concat(Object.keys(c)).forEach(function (k) {
        if (seen[k]) return; seen[k] = true;
        diffOps(b[k], c[k], path.concat([k]), out, all);
      });
      return out;
    }
    if (Array.isArray(b) && Array.isArray(c)) {
      if ((keyedArr(b) || !b.length) && (keyedArr(c) || !c.length) && (keyedArr(b) || keyedArr(c))) {
        var bm = {}, cm = {}, ids = [], have = {};
        b.forEach(function (x) { bm[x.id] = x; if (!have[x.id]) { have[x.id] = 1; ids.push(x.id); } });
        c.forEach(function (x) { cm[x.id] = x; if (!have[x.id]) { have[x.id] = 1; ids.push(x.id); } });
        ids.forEach(function (id) {
          var p = path.concat([{ id: id }]);
          if (bm[id] === undefined || cm[id] === undefined) { if (!ceq(bm[id], cm[id])) out.push({ path: p, before: bm[id] === undefined ? null : bm[id], after: cm[id] === undefined ? null : cm[id] }); }
          else diffOps(bm[id], cm[id], p, out, all);
        });
        return out;
      }
      if (POSITIONAL[last] && b.length === c.length) {
        c.forEach(function (x, i) { if (!ceq(b[i], x)) out.push({ path: path.concat([i]), before: b[i] === undefined ? null : b[i], after: x === undefined ? null : x }); });
        return out;
      }
      if (SETLIKE[last]) {
        var bc = {}, cc = {};
        b.forEach(function (x) { var k = canon(x); bc[k] = (bc[k] || 0) + 1; });
        c.forEach(function (x) { var k = canon(x); cc[k] = (cc[k] || 0) + 1; });
        b.forEach(function (x) { var k = canon(x); if ((cc[k] || 0) < bc[k]) { out.push({ path: path, del: x }); bc[k]--; } });
        var used = {};
        c.forEach(function (x) { var k = canon(x); used[k] = (used[k] || 0) + 1; if (used[k] > (bc[k] || 0)) out.push({ path: path, add: x }); });
        return out;
      }
    }
    out.push({ path: path, before: b === undefined ? null : b, after: c === undefined ? null : c });
    return out;
  }
  /* path를 따라가 부모와 마지막 열쇠를 찾음. 없으면 null */
  function locate(root, path) {
    var cur = root;
    for (var i = 0; i < path.length - 1; i++) {
      cur = step(cur, path[i]);
      if (cur === undefined || cur === null || typeof cur !== 'object') return null;
    }
    return { parent: cur, key: path[path.length - 1] };
  }
  function step(cur, k) {
    if (isObj(k)) { if (!Array.isArray(cur)) return undefined; for (var j = 0; j < cur.length; j++) if (cur[j] && cur[j].id === k.id) return cur[j]; return undefined; }
    return cur[k];
  }
  function getAt(root, path) { if (!path.length) return root; var loc = locate(root, path); return loc ? step(loc.parent, loc.key) : undefined; }
  /* ops를 data에 적용 (data는 바꾸지 않고 새 사본 반환). 하나라도 지금 값이 before와 다르면 전부 취소 → {ok:false, path} */
  function applyOps(data, ops) {
    var d = clone(data) || {};
    for (var i = 0; i < (ops || []).length; i++) {
      var op = ops[i];
      if (!op || !Array.isArray(op.path)) return { ok: false, path: [] };
      if (op.add !== undefined || op.del !== undefined) {
        var arr = getAt(d, op.path);
        if (arr === undefined || arr === null) {
          if (op.del !== undefined) continue;   // 목록이 없으면 지울 것도 없음
          var lp = locate(d, op.path);
          if (!lp || Array.isArray(lp.parent) && !isObj(lp.key)) return { ok: false, path: op.path };
          lp.parent[lp.key] = arr = [];
        }
        if (!Array.isArray(arr)) return { ok: false, path: op.path };
        var k = canon(op.add !== undefined ? op.add : op.del), at = -1;
        for (var j = 0; j < arr.length; j++) if (canon(arr[j]) === k) { at = j; break; }
        if (op.add !== undefined) { if (at < 0) arr.push(clone(op.add)); }
        else if (at >= 0) arr.splice(at, 1);
        continue;
      }
      var loc = locate(d, op.path);
      if (!loc) return { ok: false, path: op.path };
      var cur = step(loc.parent, loc.key);
      if (!ceq(cur, op.before)) return { ok: false, path: op.path };
      var after = op.after === null || op.after === undefined ? undefined : clone(op.after);
      if (isObj(loc.key)) {   // id 목록의 항목
        if (!Array.isArray(loc.parent)) return { ok: false, path: op.path };
        var idx = -1;
        for (var q = 0; q < loc.parent.length; q++) if (loc.parent[q] && loc.parent[q].id === loc.key.id) { idx = q; break; }
        if (after === undefined) { if (idx >= 0) loc.parent.splice(idx, 1); }
        else if (idx >= 0) loc.parent[idx] = after; else loc.parent.push(after);
      } else if (Array.isArray(loc.parent)) {
        loc.parent[loc.key] = after === undefined ? null : after;
      } else if (after === undefined) delete loc.parent[loc.key];
      else loc.parent[loc.key] = after;
    }
    return { ok: true, data: d };
  }

  function hasContent(d) {
    return !!d && ((d.workers && d.workers.length) || (d.roster && d.roster.length) || (d.archive && d.archive.length));
  }

  function applyRemote(r, replace) {
    // replace: 사용자가 '시트 기록으로 바꾸기'를 고른 경우 → 합치지 않고 그대로
    // 이 기기가 쓴 내용이 다른 기기의 동시 저장에 덮였을 수 있으니, 마지막으로 확인한 기준과 비교해 이 기기 변경이 빠졌으면 다시 합친다
    if (role() === 'requester') return requesterApply(r);
    var local = JSON.parse(JSON.stringify(dataOut()));
    if (!replace) settleWritten(r);
    var merged = replace ? r.data : mergeData(loadBase(), local, r.data);
    var lost = !replace && JSON.stringify(merged) !== JSON.stringify(r.data);
    toHost(merged);
    lastJson = JSON.stringify(r.data);
    saveBase(JSON.stringify(r.data));
    if (lost) { merges++; meta.dirty = true; writeMeta(); schedule(); }
    meta.stamp = r.stamp;
    meta.lineage = r.lineage || [r.stamp];
    if (!lost) meta.dirty = false;
    meta.lastSaved = deps.now();
    writeMeta();
    // 저장 이후에 찍힌 출퇴근은 '출퇴근기록' 장부로 다시 맞춘다 (실패해도 불러오기는 그대로 성공, 다음 새로 받기 때 재시도)
    return replayAfter(r.stamp);
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


  /* ================= 단일 저장: 기기 역할 =================
     none: 출퇴근 기기 미지정(또는 미연동) → 예전처럼 모든 기기가 저장(3방향 합치기)
     writer: 시트 '기기' 탭 A1이 내 기기ID → 데이터 탭을 쓰는 유일한 기기 (수정 요청을 받아 적용)
     requester: 다른 기기가 지정됨 → 데이터는 읽기만, 수정은 '수정요청' 탭에 요청으로 보냄 */
  var DEVICE_KEY = 'alba.deviceId', DEVNAME_KEY = 'alba.deviceName', REQQ_KEY = 'alba.reqQueue';
  function myId() {
    var v = deps.storage.get(DEVICE_KEY);
    if (!v || !/^d[0-9a-z]{6,}$/.test(v)) { v = 'd' + deps.now().toString(36) + Math.random().toString(36).slice(2, 8); deps.storage.set(DEVICE_KEY, v); }
    return v;
  }
  function myName() { return String(deps.storage.get(DEVNAME_KEY) || '').slice(0, 30); }
  function appVer() { return host && host.version ? String(host.version) : ''; }
  function role() {
    if (!meta.connected || !meta.sheetId || !meta.dev || !meta.dev.id) return 'none';
    return meta.dev.id === myId() ? 'writer' : 'requester';
  }
  function updateDev(d) {
    if (!d) return;
    var before = role(), prev = meta.dev || {};
    meta.dev = { id: String(d.id || ''), name: String(d.name || ''), beat: String(d.beat || ''), ver: String(d.ver || '') };
    writeMeta();
    var after = role();
    if (host && host.onDevice && (before !== after || prev.name !== meta.dev.name || prev.beat !== meta.dev.beat || prev.id !== meta.dev.id)) host.onDevice(deviceInfo());
  }
  function deviceInfo() {
    var q = loadQ();
    return { role: role(), myId: myId(), myName: myName(), dev: meta.dev || { id: '', name: '', beat: '', ver: '' }, queued: q.length, unsent: q.filter(function (x) { return !x.sent; }).length };
  }

  /* 저장 표시 + 기기 탭 (+ 출퇴근 기기는 수정요청 줄) 을 한 번에 읽기. 탭이 아직 없으면 있는 것만 */
  var tabMissing = { dev: 0, req: 0 };   // 없던 탭: 5분마다 다시 확인
  function readHead(mode, reqFrom) {
    var now = deps.now();
    var withDev = !(tabMissing.dev && now - tabMissing.dev < 300000);
    var withReq = reqFrom && withDev && !(tabMissing.req && now - tabMissing.req < 300000);
    var ranges = [SHEET_DATA + '!A2'];
    if (withDev) ranges.push(SHEET_DEV + '!A1:D1');
    if (withReq) ranges.push(SHEET_REQ + '!A' + reqFrom + ':I' + (reqFrom + 199));
    var url = SHEETS + '/' + meta.sheetId + '/values:batchGet?' + ranges.map(function (r) { return 'ranges=' + encodeURIComponent(r); }).join('&');
    return api('GET', url, undefined, mode).then(function (r) {
      var vr = (r && r.valueRanges) || [];
      var st = vr[0] && vr[0].values && vr[0].values[0] ? String(vr[0].values[0][0] || '').split('|')[0] : '';
      var dv = withDev && vr[1] && vr[1].values && vr[1].values[0] ? vr[1].values[0] : null;
      if (withDev) tabMissing.dev = 0;
      if (withReq) tabMissing.req = 0;
      return { stamp: st, dev: withDev ? { id: dv ? dv[0] : '', name: dv ? dv[1] : '', beat: dv ? dv[2] : '', ver: dv ? dv[3] : '' } : null, reqRows: withReq ? ((vr[2] && vr[2].values) || []) : null, reqFrom: reqFrom };
    }, function (e) {
      if (!e || e.status !== 400) throw e;
      // 없는 탭이 섞여 있음 → 줄여서 다시
      if (withReq) { tabMissing.req = now; return readHead(mode, reqFrom); }
      if (withDev) { tabMissing.dev = now; return readHead(mode, 0); }
      throw e;
    });
  }

  function ensureTab(name, head, mode) {
    return api('GET', SHEETS + '/' + meta.sheetId + '?fields=' + encodeURIComponent('sheets.properties(sheetId,title)'), undefined, mode).then(function (info) {
      var has = (info.sheets || []).some(function (x) { return x.properties.title === name; });
      if (has) return null;
      return api('POST', SHEETS + '/' + meta.sheetId + ':batchUpdate', { requests: [{ addSheet: { properties: { title: name } } }] }, mode).then(function () {
        if (name === SHEET_DEV) tabMissing.dev = 0;
        if (name === SHEET_REQ) tabMissing.req = 0;
        if (!head) return null;
        return api('PUT', SHEETS + '/' + meta.sheetId + '/values/' + encodeURIComponent(name + '!A1') + '?valueInputOption=RAW', { values: [head] }, mode);
      });
    });
  }

  /* ---------- 요청 기기 ---------- */
  function loadQ() { try { var q = JSON.parse(deps.storage.get(REQQ_KEY) || '[]'); return Array.isArray(q) ? q.filter(function (x) { return x && x.id && Array.isArray(x.ops); }) : []; } catch (e) { return []; } }
  function saveQ(q) { deps.storage.set(REQQ_KEY, JSON.stringify(q)); }
  var reqBaseline = null, reqTimer = null, flushing = false;
  function withoutLog(d) { if (!isObj(d) || !('reqLog' in d)) return d; var o = {}; Object.keys(d).forEach(function (k) { if (k !== 'reqLog') o[k] = d[k]; }); return o; }
  /* 시트 데이터 위에 아직 결과를 모르는 내 요청을 차례로 얹어 화면에 보여 줌 */
  function showView(sheetData, q) {
    var view = withoutLog(clone(sheetData));
    q.forEach(function (it) { var r = applyOps(view, it.ops); if (r.ok) view = r.data; });
    host.applyData(view);
    reqBaseline = JSON.stringify(host.getData());
  }
  function requesterApply(remote) {
    // 아직 요청으로 만들지 않은 화면 수정이 있으면 먼저 요청으로 (새로 받은 내용에 덮여 사라지지 않게)
    if (reqTimer) { clearT(reqTimer); reqTimer = null; buildRequest(); }
    meta.stamp = remote.stamp; meta.lineage = remote.lineage || [remote.stamp];
    var log = (remote.data && remote.data.reqLog) || {};
    meta.reqLog = isObj(log) ? log : null;
    var applied = {}, rejected = {};
    (log.applied || []).forEach(function (id) { applied[id] = true; });
    (log.rejected || []).forEach(function (x) { if (x && x.id) rejected[x.id] = x.reason || ''; });
    var keep = [];
    loadQ().forEach(function (it) {
      if (applied[it.id]) { if (host.onRequest) host.onRequest({ kind: 'applied', item: it }); return; }
      if (rejected[it.id] !== undefined) { if (host.onRequest) host.onRequest({ kind: 'rejected', item: it, reason: rejected[it.id] }); return; }
      keep.push(it);
    });
    saveQ(keep);
    showView(remote.data, keep);
    lastJson = JSON.stringify(remote.data);
    saveBase(lastJson);
    meta.dirty = false;
    meta.lastSaved = deps.now();
    writeMeta();
    if (host.onDevice) host.onDevice(deviceInfo());
    return flushRequests();
  }
  function scheduleRequest() {
    if (reqTimer) clearT(reqTimer);
    reqTimer = setT(function () { reqTimer = null; buildRequest(); }, 1500);
  }
  /* 화면에서 바뀐 곳을 계산해 요청 한 줄로 */
  function buildRequest(note) {
    if (role() !== 'requester' && !note) return null;
    var base = reqBaseline || (lastJson ? JSON.stringify(withoutLog(JSON.parse(lastJson))) : null);
    if (!base) return null;
    var cur = clone(host.getData());
    var ops = diffOps(JSON.parse(base), cur, [], [], !!note);   // 출퇴근 기기에서 넘어가는 경우엔 출퇴근 상태(근무 중 등)도 함께
    if (!ops.length) return null;
    var it = { id: 'r' + deps.now().toString(36) + Math.random().toString(36).slice(2, 7), ts: new Date(deps.now()).toISOString(), ops: ops, desc: host.describeOps ? String(host.describeOps(ops) || '') : '', sent: false };
    if (note) it.note = note;
    var q = loadQ();
    q.push(it);
    saveQ(q);
    reqBaseline = JSON.stringify(cur);
    if (host.onRequest) host.onRequest({ kind: 'queued', item: it });
    if (host.onDevice) host.onDevice(deviceInfo());
    flushRequests();
    return it;
  }
  function tsLocal(ms) { var d = new Date(ms), p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); }
  function flushRequests() {
    if (flushing || !meta.connected || !meta.sheetId) return Promise.resolve();
    var q = loadQ().filter(function (x) { return !x.sent; });
    if (!q.length) return Promise.resolve();
    flushing = true;
    var rows = q.map(function (it) {
      var js = JSON.stringify(it.ops);
      return [it.id, tsLocal(Date.parse(it.ts) || deps.now()), myId(), myName(), (it.note ? '[' + it.note + '] ' : '') + (it.desc || ''), js, '', '', ''];
    });
    var big = rows.filter(function (r) { return r[5].length > 45000; });
    if (big.length) {   // 칸 하나에 못 넣는 큰 요청: 버리고 알림
      var bad = {}; big.forEach(function (r) { bad[r[0]] = true; });
      var q2 = loadQ().filter(function (x) { if (bad[x.id] && host.onRequest) host.onRequest({ kind: 'rejected', item: x, reason: tr('한 번에 바꾼 내용이 너무 많아요. 나눠서 고쳐 주세요.') }); return !bad[x.id]; });
      saveQ(q2);
      rows = rows.filter(function (r) { return !bad[r[0]]; });
      if (!rows.length) { flushing = false; return Promise.resolve(); }
    }
    var url = SHEETS + '/' + meta.sheetId + '/values/' + encodeURIComponent(SHEET_REQ + '!A:I') + ':append?valueInputOption=RAW&insertDataOption=INSERT_ROWS';
    var send = function () { return api('POST', url, { values: rows }, 'silent'); };
    return send().catch(function (e) {
      if (e && e.status === 400) return ensureTab(SHEET_REQ, REQ_HEAD, 'silent').then(send);
      throw e;
    }).then(function () {
      var sent = {}; rows.forEach(function (r) { sent[r[0]] = true; });
      saveQ(loadQ().map(function (x) { if (sent[x.id]) x.sent = true; return x; }));
      if (host.onDevice) host.onDevice(deviceInfo());
      return true;
    }).catch(function () { return false; /* 다음 새로 받기 때 다시 */ }).then(function (ok) {
      flushing = false;
      if (ok && loadQ().some(function (x) { return !x.sent; })) return flushRequests();   // 보내는 사이 새로 생긴 요청
    });
  }

  /* ---------- 출퇴근 기기 ---------- */
  function processRequests(h) {
    var rows = h && h.reqRows;
    if (!rows || !rows.length) return Promise.resolve(false);
    var log = isObj(meta.reqLog) ? clone(meta.reqLog) : {};
    log.applied = Array.isArray(log.applied) ? log.applied : [];
    log.rejected = Array.isArray(log.rejected) ? log.rejected : [];
    var cursor = h.reqFrom;
    var done = {};
    log.applied.forEach(function (id) { done[id] = '적용됨'; });
    log.rejected.forEach(function (x) { if (x && x.id) done[x.id] = '거절'; });
    var data = clone(withoutLog(host.getData()));
    var changed = false, any = false, writes = [];
    var when = tsLocal(deps.now());
    rows.forEach(function (row, i) {
      var rowNo = cursor + i;
      var id = String((row && row[0]) || '').trim();
      if (!id || id === REQ_HEAD[0]) return;
      if (done[id]) { if (!row[6]) { writes.push({ range: SHEET_REQ + '!G' + rowNo + ':I' + rowNo, values: [[done[id], when, '']] }); any = true; } return; }
      var ops = null;
      try { ops = JSON.parse(String(row[5] || '')); } catch (e) { ops = null; }
      var res = Array.isArray(ops) ? applyOps(data, ops) : { ok: false, path: [] };
      any = true;
      if (res.ok) {
        data = res.data; changed = true;
        log.applied.push(id); done[id] = '적용됨';
        writes.push({ range: SHEET_REQ + '!G' + rowNo + ':I' + rowNo, values: [['적용됨', when, '']] });
      } else {
        var reason = host.describeFail ? String(host.describeFail(res.path, data) || '') : '';
        reason = reason || tr('그 사이 다른 곳에서 바뀌었어요');
        log.rejected.push({ id: id, reason: reason }); done[id] = '거절';
        writes.push({ range: SHEET_REQ + '!G' + rowNo + ':I' + rowNo, values: [['거절', when, reason]] });
      }
    });
    log.cursor = cursor + rows.length;
    log.applied = log.applied.slice(-300);
    log.rejected = log.rejected.slice(-100);
    var moved = !meta.reqLog || meta.reqLog.cursor !== log.cursor;
    if (!any && !moved) return Promise.resolve(false);
    meta.reqLog = log;
    if (changed && host.onRequestsApplied) { try { host.onRequestsApplied(withoutLog(host.getData()), data); } catch (e) {} }
    if (changed) host.applyData(data);
    meta.pendWrites = pendWrites().concat(writes).slice(-500);
    meta.dirty = true;
    writeMeta();
    return doSave('silent');
  }
  function heartbeat() {
    if (role() !== 'writer' || deps.now() - (meta.lastBeat || 0) < 60000) return Promise.resolve();
    meta.lastBeat = deps.now();
    return api('PUT', SHEETS + '/' + meta.sheetId + '/values/' + encodeURIComponent(SHEET_DEV + '!C1:D1') + '?valueInputOption=RAW',
      { values: [[new Date(deps.now()).toISOString(), appVer()]] }, 'silent').catch(function () {});
  }
  /* 다른 기기가 출퇴근 기기로 지정됨 → 저장 못 한 내 변경은 요청으로 보내고 요청 기기로 */
  function loseWriter() {
    var it = null;
    if (meta.dirty && lastJson) {
      reqBaseline = JSON.stringify(withoutLog(JSON.parse(lastJson)));
      it = buildRequest(tr('출퇴근 기기가 바뀌어 요청으로 보냄'));
    }
    meta.dirty = false;
    writeMeta();
    if (host.onDevice) host.onDevice(deviceInfo());
    if (it && host.onRequest) host.onRequest({ kind: 'converted', item: it });
    return pull('silent').then(function (remote) { if (remote) return requesterApply(remote); });
  }
  /* 이 기기를 출퇴근 기기로 지정 */
  function designate(name) {
    if (!meta.connected || !meta.sheetId) return Promise.resolve(false);
    name = String(name || '').trim().slice(0, 30) || tr('매장 기기');
    deps.storage.set(DEVNAME_KEY, name);
    if (role() === 'requester' && reqTimer) { clearT(reqTimer); reqTimer = null; buildRequest(); }   // 아직 요청으로 안 만든 화면 수정부터
    return getToken('user').then(function () {
      return ensureTab(SHEET_DEV, null, 'user');
    }).then(function () {
      return pull('user');
    }).then(function (remote) {
      if (role() === 'requester' && remote) {
        // 요청 기기였으면: 이미 결과가 난 내 요청은 정리하고, 아직 처리 안 된 내 요청은 이 기기가 직접 적용(또는 거절)한 것으로 기록
        var log = remote.data && isObj(remote.data.reqLog) ? clone(remote.data.reqLog) : {};
        log.applied = Array.isArray(log.applied) ? log.applied : [];
        log.rejected = Array.isArray(log.rejected) ? log.rejected : [];
        var known = {};
        log.applied.forEach(function (id) { known[id] = 'a'; });
        log.rejected.forEach(function (x) { if (x && x.id) known[x.id] = x.reason || ''; });
        var view = withoutLog(clone(remote.data));
        loadQ().forEach(function (it) {
          if (known[it.id] === 'a') { if (host.onRequest) host.onRequest({ kind: 'applied', item: it }); return; }
          if (known[it.id] !== undefined) { if (host.onRequest) host.onRequest({ kind: 'rejected', item: it, reason: known[it.id] }); return; }
          var r = applyOps(view, it.ops);
          if (r.ok) { view = r.data; if (it.sent) log.applied.push(it.id); }
          else {
            var why = tr('그 사이 다른 곳에서 바뀌었어요');
            if (it.sent) log.rejected.push({ id: it.id, reason: why });
            if (host.onRequest) host.onRequest({ kind: 'rejected', item: it, reason: why });
          }
        });
        log.applied = log.applied.slice(-300); log.rejected = log.rejected.slice(-100);
        meta.stamp = remote.stamp; meta.lineage = remote.lineage || [remote.stamp];
        meta.reqLog = log;
        host.applyData(view);
        lastJson = JSON.stringify(remote.data);
        saveBase(lastJson);
        saveQ([]);
      } else if (remote && remote.stamp !== meta.stamp) {
        return applyRemote(remote);
      }
    }).then(function () {
      return api('PUT', SHEETS + '/' + meta.sheetId + '/values/' + encodeURIComponent(SHEET_DEV + '!A1:D1') + '?valueInputOption=RAW',
        { values: [[myId(), name, new Date(deps.now()).toISOString(), appVer()]] }, 'user');
    }).then(function () {
      meta.lastBeat = deps.now();
      updateDev({ id: myId(), name: name, beat: new Date(deps.now()).toISOString(), ver: appVer() });
      meta.dirty = true;
      writeMeta();
      return doSave('user');
    }).then(function () { return true; }, function (e) { setStatus('error', friendly(e)); return false; });
  }
  /* 지정 해제 (출퇴근 기기를 아무도 아닌 상태로) */
  function undesignate() {
    if (!meta.connected || !meta.sheetId) return Promise.resolve(false);
    return api('PUT', SHEETS + '/' + meta.sheetId + '/values/' + encodeURIComponent(SHEET_DEV + '!A1:D1') + '?valueInputOption=RAW',
      { values: [['', '', '', '']] }, 'user').then(function () {
      updateDev({ id: '', name: '', beat: '', ver: '' });
      return true;
    }, function () { return false; });
  }

  /* ---------------- 공개 기능 ---------------- */
  function connect() {
    if (!deps.available()) {
      setStatus('error', tr('이 기능은 인터넷 주소(https)로 접속했을 때만 사용할 수 있습니다.'));
      return Promise.resolve(false);
    }
    setStatus('saving', tr('구글 연결 중…'));
    var asRequester = false;
    return getToken(meta.connected ? 'user' : 'first').then(function () {
      return ensureSheet('user');
    }).then(function () {
      // 이미 다른 기기가 출퇴근 기기로 지정돼 있으면 이 기기는 요청 기기: 시트를 덮어쓰지 않고 받아 오기만
      return readHead('user', 0).then(function (h) {
        meta.dev = h.dev ? { id: String(h.dev.id || ''), name: String(h.dev.name || ''), beat: String(h.dev.beat || ''), ver: String(h.dev.ver || '') } : meta.dev;
        asRequester = !!(meta.dev && meta.dev.id && meta.dev.id !== myId());
      }, function () {});
    }).then(function () {
      return withSheetRetry(function () { return pull('user'); }, 'user');
    }).then(function (remote) {
      if (asRequester) { meta.connected = true; writeMeta(); return remote ? requesterApply(remote) : null; }
      var local = dataOut();
      // 이미 연동돼 있던 기기가 다시 로그인한 경우: 묻지 않고 '앱을 열 때'와 같은 규칙으로 맞춘다
      // (이 기기에 저장 안 된 변경이 있으면 이 기기 우선 → 시트에 저장 / 다른 기기가 더 최근에 저장했으면 시트 내용 / 아니면 이 기기 내용 유지)
      if (meta.connected && meta.sheetId && remote && hasContent(remote.data)) {
        if (meta.dirty) return push('user');
        if (remote.stamp !== (meta.stamp || '')) return applyRemote(remote);   // 저장 때마다 시각이 달라지므로 '다르면 다른 기기가 저장한 것' (기기 시계가 어긋나도 안전)
        if (JSON.stringify(remote.data) !== JSON.stringify(local)) return push('user');
        lastJson = JSON.stringify(local);
        saveBase(lastJson);
        return null;
      }
      if (remote && hasContent(remote.data)) {
        var same = JSON.stringify(remote.data) === JSON.stringify(local);
        if (!same && hasContent(local)) {
          var useRemote = host.confirm(tr('이 구글 계정에 저장된 기록이 이미 있습니다.\n\n[확인] 구글 시트에 저장된 기록을 불러옵니다 (이 기기의 기록은 대체됩니다)\n[취소] 이 기기의 기록을 구글 시트에 저장합니다 (시트의 기존 기록은 대체됩니다)'));
          if (useRemote) return applyRemote(remote, true);
          else return push('user', true);   // 사용자가 '이 기기 기록으로' 고름 → 합치지 않고 그대로 저장
        } else if (!same) {
          return applyRemote(remote, true);
        } else {
          lastJson = JSON.stringify(local);
          saveBase(lastJson);
          meta.stamp = remote.stamp;
          meta.lineage = remote.lineage;
          meta.dirty = false;
        }
        return null;
      }
      return push('user');
    }).then(function () {
      meta.connected = true;
      if (!meta.lastSaved) meta.lastSaved = deps.now();
      writeMeta();
      if (asRequester) { if (host.onDevice) host.onDevice(deviceInfo()); return null; }
      return readHead('user', 0).then(function (h) {
        updateDev(h.dev);
        if (role() === 'requester') return pull('user').then(function (remote) { if (remote) return requesterApply(remote); });
      }, function () {});
    }).then(function () {
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
    setStatus('saving', tr('구글 시트 확인 중…'));
    return getToken('silent').then(function () {
      return readHead('silent', 0).then(function (h) { updateDev(h.dev); }, function () {});
    }).then(function () {
      return withSheetRetry(function () { return pull('silent'); }, 'silent');
    }).then(function (remote) {
      if (role() === 'requester') return remote ? requesterApply(remote) : flushRequests();
      if (meta.dirty) return push('silent');          // 이 기기에 저장 안 된 변경이 있으면 우선
      if (remote && remote.stamp !== (meta.stamp || '')) return applyRemote(remote);   // 시계 순서가 아니라 '내가 마지막으로 저장한 것과 다른가'로 판단
      else { lastJson = JSON.stringify(dataOut()); saveBase(lastJson); return replayPending(); }
    }).then(function () {
      setStatus('saved', '');
    }).catch(function (e) {
      setStatus('needLogin', friendly(e));
    });
  }

  function doSave(mode) {
    if (!meta.connected) return Promise.resolve(false);
    if (role() === 'requester') return flushRequests().then(function () { return true; });
    if (saving) { again = true; return Promise.resolve(false); }
    saving = true;
    setStatus('saving', tr('저장 중…'));
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

  /* 다른 기기가 저장한 내용을 주기적으로 받아오기 (앱이 화면에 떠 있을 때 30초마다·화면으로 돌아올 때)
     이 기기에 저장 안 된 변경이 있으면 받아오지 않고 저장(→ 합치기)을 먼저 한다. 입력·팝업 중이면 다음 기회로 미룸 */
  var refreshing = false;
  function refresh() {
    if (!meta.connected || !meta.sheetId || !deps.available()) return Promise.resolve(false);
    if (saving || refreshing) return Promise.resolve(false);
    if (!token || tokenExp - deps.now() < 60000) return Promise.resolve(false);   // 토큰 갱신은 화면 터치 때 (팝업 차단 방지)
    if (meta.dirty && role() !== 'requester') { schedule(); return Promise.resolve(false); }
    if (host.isBusy && host.isBusy()) return Promise.resolve(false);
    refreshing = true;
    var wasWriter = role() === 'writer';
    var cur = meta.reqLog && meta.reqLog.cursor ? meta.reqLog.cursor : 2;
    return readHead('silent', wasWriter ? cur : 0).then(function (h) {
      if (h.dev) updateDev(h.dev);
      if (wasWriter && role() !== 'writer') return loseWriter().then(function () { return null; });
      if (role() === 'requester') {
        if (!h.stamp || h.stamp === (meta.stamp || '')) return flushRequests().then(function () { return null; });
        return pull('silent');
      }
      var st = h.stamp;
      if (!st || st === (meta.stamp || '')) {   // 바뀐 게 없으면 데이터는 안 읽음 (지난번 장부 재생이 실패했으면 그것만 다시)
        if (st) confirmWritten();
        var p0 = st && meta.replayStamp ? replayPending() : Promise.resolve();
        if (role() !== 'writer') return p0.then(function () { return null; });
        return p0.then(function () { return processRequests(h); }).then(function () { return heartbeat(); }).then(function () { return null; });
      }
      return pull('silent');
    }).then(function (remote) {
      if (!remote || remote.stamp === (meta.stamp || '') || saving) return false;
      if (meta.dirty && role() !== 'requester') return false;
      if (host.isBusy && host.isBusy()) return false;
      return applyRemote(remote).then(function () { setStatus('saved', ''); return true; });
    }).catch(function () { return false; }).then(function (v) { refreshing = false; return v; });
  }

  /* 앱에서 저장할 내용이 바뀔 때마다 호출 */
  function markDirty() {
    if (!meta.connected || !host) return;
    if (role() === 'requester') { scheduleRequest(); return; }
    var json = JSON.stringify(dataOut());
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

  /* 앱에서 알바생/기록을 지우면 시트 '출퇴근기록' 장부에서도 그 사람(codes) 줄을 지운다. codes가 비면 전부 지운다 */
  function purgePunchLog(codes, beforeTs) {
    if (!meta.connected || !meta.sheetId) return Promise.resolve(false);
    var rng = SHEET_PUNCH + '!A2:G';
    return api('GET', SHEETS + '/' + meta.sheetId + '/values/' + encodeURIComponent(rng), undefined, 'silent').then(function (res) {
      var rows = (res && res.values) || [];
      // beforeTs 가 있으면 그 시각 이전 줄만 지움 (나중에 다시 시도할 때, 그 사이 새로 찍힌 기록은 지키기 위해)
      var keep = rows.filter(function (r) {
        if (beforeTs && String(r[0] || '') >= beforeTs) return true;
        return codes && codes.length ? codes.indexOf(String(r[1] || '').trim()) < 0 : false;
      });
      if (keep.length === rows.length) return true;
      return api('POST', SHEETS + '/' + meta.sheetId + '/values:batchClear', { ranges: [rng] }, 'silent').then(function () {
        if (!keep.length) return true;
        return api('PUT', SHEETS + '/' + meta.sheetId + '/values/' + encodeURIComponent(SHEET_PUNCH + '!A2') + '?valueInputOption=RAW', { values: keep }, 'silent').then(function () { return true; });
      });
    }).catch(function () { return false; });
  }

  /* 관리자 비밀번호 복구: 시트 '관리자' 탭 B1 칸 읽기/쓰기 */
  function readAdminPin(mode) {
    if (!meta.connected || !meta.sheetId) return Promise.reject(new Error('not connected'));
    var rng = encodeURIComponent(SHEET_ADMIN + '!B1');
    return api('GET', SHEETS + '/' + meta.sheetId + '/values/' + rng, undefined, mode || 'silent').then(function (r) {
      var v = r && r.values && r.values[0] && r.values[0][0];
      return v === undefined || v === null ? '' : String(v).trim();
    });
  }
  function setAdminPin(pin) {
    if (!meta.connected || !meta.sheetId) return Promise.resolve(false);
    var rng = encodeURIComponent(SHEET_ADMIN + '!B1');
    return api('PUT', SHEETS + '/' + meta.sheetId + '/values/' + rng + '?valueInputOption=RAW', { values: [[pin || '']] }, 'silent')
      .then(function () { return true; })
      .catch(function () { return doSave('silent'); });   // 탭이 아직 없으면 다음 저장이 만들면서 현재 비밀번호를 적음
  }

  /* 화면을 누를 때마다(사용자 동작 안에서) 토큰이 곧 만료되거나 이미 풀렸으면 조용히 갱신.
     타이머로 갱신하면 브라우저가 구글 창을 팝업 차단해서 실패하므로, 알바생·사장님이 누르는 순간을 이용한다. */
  var lastGesture = 0;
  function renewOnGesture() {
    if (!meta.connected || !meta.sheetId || !deps.available()) return Promise.resolve(false);
    var now = deps.now();
    var lost = status.kind === 'needLogin';
    var soon = !token || tokenExp - now < 10 * 60000;
    if (!lost && !soon) return Promise.resolve(false);
    if (now - lastGesture < 20000) return Promise.resolve(false);   // 너무 자주 시도하지 않음
    lastGesture = now;
    return fetchToken('silent').then(function () {
      if (lost || meta.dirty) return resume().then(function () { return true; });
      setStatus('saved', '');
      return true;
    }, function () {
      if (lost || !token || tokenExp <= deps.now()) setStatus('needLogin', tr('구글 로그인이 필요합니다.'));
      return false;
    });
  }

  function saveNow() {
    if (saveTimer) { clearT(saveTimer); saveTimer = null; }
    if (role() === 'requester') { if (reqTimer) { clearT(reqTimer); reqTimer = null; } buildRequest(); }
    return doSave('user');
  }

  function loadFromSheet() {
    setStatus('saving', tr('불러오는 중…'));
    return getToken('user').then(function () {
      return withSheetRetry(function () { return pull('user'); }, 'user');
    }).then(function (remote) {
      if (!remote) { setStatus('saved', ''); return 'empty'; }
      return applyRemote(remote, true).then(function () { setStatus('saved', ''); return 'ok'; });
    }).catch(function (e) {
      setStatus('error', friendly(e));
      return 'error';
    });
  }

  function disconnect() {
    if (saveTimer) { clearT(saveTimer); saveTimer = null; }
    if (token) deps.revoke(token);
    token = null; tokenExp = 0;
    if (refreshTimer) { clearT(refreshTimer); refreshTimer = null; }
    deps.storage.remove(TOKEN_KEY);
    meta = { connected: false, sheetId: '', stamp: '', dirty: false, lastSaved: 0 };
    deps.storage.remove(META_KEY);
    lastJson = null;
    lastTabs = {};
    punchHeaderOk = {};
    if (reqTimer) { clearT(reqTimer); reqTimer = null; }
    reqBaseline = null;
    deps.storage.remove(REQQ_KEY);
    notice = '';
    setStatus('off');
  }

  return {
    init: function (h) { host = h; loadStoredToken(); },
    connect: connect,
    resume: resume,
    markDirty: markDirty,
    saveNow: saveNow,
    renewOnGesture: renewOnGesture,
    refresh: refresh,
    merge3: merge3,
    mergeData: mergeData,
    diffOps: diffOps,
    applyOps: applyOps,
    designate: designate,
    undesignate: undesignate,
    deviceInfo: function () { return deviceInfo(); },
    role: function () { return role(); },
    setDeviceName: function (n) { deps.storage.set(DEVNAME_KEY, String(n || '').trim().slice(0, 30)); },
    pendingRequests: function () { return loadQ(); },
    mergeCount: function () { return merges; },
    appendPunch: appendPunch,
    purgePunchLog: purgePunchLog,
    readAdminPin: readAdminPin,
    setAdminPin: setAdminPin,
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
