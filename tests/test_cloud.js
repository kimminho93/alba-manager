/* tests/test_cloud.js — 구글 시트 연동 로직(web/gsync.js) 테스트: 가짜 구글 서버로 검증 */
'use strict';
const assert = require('assert');
const create = require('../web/gsync.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.stack || e)); process.exit(1); }
}

/* ---- 가짜 구글 드라이브/시트 (탭 추가·삭제·순서·서식까지 흉내) ---- */
function cellRef(range) {
  const m = /!([A-Z]+)(\d+)?/.exec(range);
  if (!m) return { r: 0, c: 0 };
  const c = m[1].split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return { r: m[2] ? Number(m[2]) - 1 : 0, c };
}
function writeAt(t, range, values) {
  const { r, c } = cellRef(range);
  values.forEach((row, k) => {
    if (c === 0 && !/!A\d+:[B-Z]/.test(range) && !/!A\d+:A/.test(range)) { t.rows[r + k] = row; return; }
    const cur = (t.rows[r + k] || []).slice();
    row.forEach((v, j) => { cur[c + j] = v; });
    t.rows[r + k] = cur;
  });
}
function readAt(t, range) {
  const m = /!([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/.exec(range);
  const { r, c } = cellRef(range);
  const r2 = m && m[4] ? Number(m[4]) - 1 : r;
  const c2 = m && m[3] ? m[3].split('').reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1 : c;
  const out = [];
  for (let i = r; i <= Math.min(r2, t.rows.length - 1); i++) out.push((t.rows[i] || []).slice(c, c2 + 1));
  while (out.length && !out[out.length - 1].some(v => v !== undefined && v !== '')) out.pop();
  return out.map(row => row.map(v => (v === undefined ? '' : v)));
}
function makeGoogle() {
  const g = { files: {}, next: 1, sid: 100, fail401Once: false, calls: [], writes: [] };
  g.fetch = async (url, opt) => {
    opt = opt || {};
    g.calls.push((opt.method || 'GET') + ' ' + url.replace(/\?.*/, ''));
    if (!/^Bearer tok/.test((opt.headers || {}).Authorization || '')) return res(401, {});
    if (g.fail401Once) { g.fail401Once = false; return res(401, {}); }
    const u = new URL(url);
    if (u.hostname === 'www.googleapis.com' && u.pathname === '/drive/v3/files') {
      const found = Object.keys(g.files).filter(id => !g.files[id].deleted).map(id => ({ id, name: g.files[id].title }));
      return res(200, { files: found });
    }
    if (u.pathname === '/v4/spreadsheets' && opt.method === 'POST') {
      const body = JSON.parse(opt.body);
      const id = 'sheet' + (g.next++);
      g.files[id] = { title: body.properties.title, tabs: [] };
      body.sheets.forEach(sh => g.files[id].tabs.push({ id: g.sid++, title: sh.properties.title, rows: [], formats: 0 }));
      return res(200, { spreadsheetId: id });
    }
    const m = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(u.pathname);
    if (m) {
      const f = g.files[m[1]];
      if (!f || f.deleted) return res(404, {});
      const rest = decodeURIComponent(m[2]);
      const tab = t => f.tabs.find(x => x.title === t);
      if (rest === '' && (opt.method || 'GET') === 'GET') {
        return res(200, { sheets: f.tabs.map((t, i) => ({ properties: { sheetId: t.id, title: t.title, index: i } })) });
      }
      if (rest === ':batchUpdate') {
        const replies = [];
        JSON.parse(opt.body).requests.forEach(rq => {
          if (rq.addSheet) {
            const t = { id: g.sid++, title: rq.addSheet.properties.title, rows: [], formats: 0 };
            f.tabs.push(t);
            replies.push({ addSheet: { properties: { sheetId: t.id, title: t.title } } });
          } else if (rq.deleteSheet) {
            f.tabs = f.tabs.filter(t => t.id !== rq.deleteSheet.sheetId);
            replies.push({});
          } else if (rq.updateSheetProperties) {
            const t = f.tabs.find(x => x.id === rq.updateSheetProperties.properties.sheetId);
            f.tabs = f.tabs.filter(x => x !== t);
            f.tabs.splice(rq.updateSheetProperties.properties.index, 0, t);
            replies.push({});
          } else if (rq.repeatCell) {
            const t = f.tabs.find(x => x.id === rq.repeatCell.range.sheetId);
            if (t) t.formats++;
            replies.push({});
          } else replies.push({});
        });
        return res(200, { replies });
      }
      if (rest === '/values:batchClear') {
        JSON.parse(opt.body).ranges.forEach(r => { const pm = /^(.+)!A2:G$/.exec(r); if (pm) { const pt = tab(pm[1]); pt.rows = pt.rows.slice(0, 1); return; } const t = tab(r); if (!t) throw new Error('없는 탭 clear: ' + r); t.rows = []; });
        return res(200, {});
      }
      if (rest === '/values:batchUpdate') {
        if (g.failDataWrite > 0) { g.failDataWrite--; return res(503, {}); }
        const bodyData = JSON.parse(opt.body).data;
        if (bodyData.some(d => !tab(d.range.split('!')[0]))) return res(400, {});
        bodyData.forEach(d => {
          const name = d.range.split('!')[0];
          const t = tab(name);
          writeAt(t, d.range, d.values);   // 시작 칸부터 덮어씀 (아래 줄은 그대로)
          g.writes.push(name);
        });
        return res(200, {});
      }
      if (rest === '/values:batchGet') {
        const ranges = u.searchParams.getAll('ranges');
        if (ranges.some(r => !tab(r.split('!')[0]))) return res(400, {});
        g.headReads = (g.headReads || 0) + 1;
        return res(200, { valueRanges: ranges.map(r => ({ range: r, values: readAt(tab(r.split('!')[0]), r) })) });
      }
      const gp = /^\/values\/(.+![A-Z]+\d+(?::[A-Z]+\d+)?)$/.exec(decodeURIComponent(rest.split('?')[0]));
      if (gp && opt.method === 'PUT' && /![A-Z]+\d+(:[A-Z]+\d+)?$/.test(gp[1]) && !/!A2$|!B1$/.test(gp[1])) {
        const t = tab(gp[1].split('!')[0]);
        if (!t) return res(400, {});
        if (g.failDevPut > 0 && gp[1].indexOf('A1:D1') >= 0) { g.failDevPut--; return res(503, {}); }
        writeAt(t, gp[1], JSON.parse(opt.body).values);
        return res(200, {});
      }
      const ra = /^\/values\/(.+)!A:I:append$/.exec(decodeURIComponent(rest.split('?')[0]));
      if (ra) {
        const t = tab(ra[1]);
        if (!t) return res(400, {});
        if (g.failReqAppend > 0) { g.failReqAppend--; return res(503, {}); }
        JSON.parse(opt.body).values.forEach(row => t.rows.push(row));
        return res(200, {});
      }
      const bm = /^\/values\/(.+)!B1$/.exec(rest);
      if (bm) {
        const t = tab(bm[1]);
        if (!t) return res(400, {});
        if ((opt.method || 'GET') === 'PUT') { t.rows[0] = t.rows[0] || []; t.rows[0][1] = JSON.parse(opt.body).values[0][0]; return res(200, {}); }
        const v = t.rows[0] && t.rows[0][1];
        return res(200, v === undefined || v === '' ? {} : { values: [[v]] });
      }
      const um = /^\/values\/(.+)!A2$/.exec(rest.split('?')[0]);
      if (um && (opt.method || 'GET') === 'PUT') { const t = tab(um[1]); JSON.parse(opt.body).values.forEach((row, k) => { t.rows[1 + k] = row; }); return res(200, {}); }
      const am = /^\/values\/(.+)!A:G:append$/.exec(decodeURIComponent(rest.split('?')[0]));
      if (am) {
        const t = tab(am[1]);
        if (!t) return res(400, {});
        JSON.parse(opt.body).values.forEach(row => t.rows.push(row));
        return res(200, {});
      }
      const hm = /^\/values\/(.+)!A1:Z1$/.exec(rest);
      if (hm) { const t = tab(hm[1]); return res(200, t && t.rows[0] ? { values: [t.rows[0]] } : {}); }
      const lm = /^\/values\/(.+)!A2:G$/.exec(decodeURIComponent(rest));
      if (lm && (opt.method || 'GET') === 'GET' && g.failPunchGet > 0) { g.failPunchGet--; return res(503, {}); }
      if (lm) { const t = tab(lm[1]); return res(200, { values: t ? t.rows.slice(1) : [] }); }
      const sm = /^\/values\/(.+)!A2$/.exec(decodeURIComponent(rest));
      if (sm) { const t = tab(sm[1]); g.stampReads = (g.stampReads || 0) + 1; return res(200, t && t.rows[1] ? { values: [[t.rows[1][0]]] } : {}); }
      const vm = /^\/values\/(.+)!A1:A300$/.exec(rest);
      if (vm) g.fullReads = (g.fullReads || 0) + 1;
      if (vm) { const t = tab(vm[1]); return res(200, { values: t ? t.rows : [] }); }
      const og = /^\/values\/(.+)!([A-Z]+)(\d+):([A-Z]+)$/.exec(decodeURIComponent(rest.split('?')[0]));   // 열 끝까지 (예: A1:A)
      if (og && (opt.method || 'GET') === 'GET') {
        const t = tab(og[1]);
        if (!t) return res(400, {});
        return res(200, { values: readAt(t, og[1] + '!' + og[2] + og[3] + ':' + og[4] + Math.max(1, t.rows.length)) });
      }
    }
    return res(404, {});
  };
  g.tabNames = id => g.files[id].tabs.map(t => t.title);
  g.rows = (id, name) => (g.files[id].tabs.find(t => t.title === name) || { rows: null }).rows;
  return g;
}
function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/* ---- 가짜 기기(브라우저 저장소 + 앱 데이터) ---- */
function worker(name, months) {
  return { id: 'id-' + name, name, contractDays: 5, wage: 10320, months: months || {} };
}
// 앱이 만드는 월별 탭을 흉내: 알바생이 기록을 가진 달마다 탭 하나
function tablesFor(data) {
  const set = {};
  data.workers.forEach(w => Object.keys(w.months).forEach(k => { set[k] = true; }));
  const sheets = Object.keys(set).sort().reverse().map(pm => ({
    name: pm,
    rows: [[pm + ' 정산'], ['이름', '실수령액']].concat(data.workers.filter(w => w.months[pm]).map(w => [w.name, w.months[pm].net || 0])),
    bold: [0, 1]
  }));
  sheets.push({ name: '알바생', rows: [['이름']].concat(data.workers.map(w => [w.name])), bold: [0] });
  sheets.push({ name: '점검 보관함', rows: [['(저장된 점검 기록이 없습니다)']], bold: [0] });
  return { sheets };
}

function makeDevice(google, opts) {
  opts = opts || {};
  const store = opts.store || {};
  const timers = [];
  const dev = { data: { workers: [], archive: [], presets: [], store: {} }, tokenFail: false, tokens: 0, confirmAnswer: true, statuses: [] };
  const clock = { t: Date.UTC(2026, 10, 12, 3, 0, 0) };
  const deps = {
    fetch: (u, o) => google.fetch(u, o),   // 시험 중에 g.fetch 를 바꿔 끼우면 곧바로 적용
    storage: { get: k => (k in store ? store[k] : null), set: (k, v) => { store[k] = v; }, remove: k => { delete store[k]; } },
    now: () => clock.t,
    available: () => true,
    requestToken: async mode => {
      if (dev.tokenFail) throw new Error(mode === 'silent' ? 'interaction_required' : 'popup_closed');
      dev.tokens++;
      return { token: 'tok' + dev.tokens, expiresIn: 3600 };
    },
    revoke: () => { dev.revoked = true; },
    setTimeout: (f, ms) => { timers.push({ f, ms }); return timers.length; },
    clearTimeout: () => {}
  };
  dev.cloud = create(deps);
  dev.timers = timers;
  dev.clock = clock;
  dev.store = store;
  dev.cloud.init({
    getAdminPin: () => dev.pin || '',
    getData: () => JSON.parse(JSON.stringify(dev.data)),
    getTables: () => tablesFor(dev.data),
    applyData: d => { dev.data = JSON.parse(JSON.stringify(d)); },
    replayPunchLog: (rows, afterMs) => { dev.replayed = { rows, afterMs }; },
    confirm: () => dev.confirmAnswer,
    onStatus: s => { dev.statuses.push(s.kind); dev.lastStatus = s; }
  });
  return dev;
}

(async () => {
  console.log('=== [4] 구글 시트 연동 로직 테스트 (가짜 구글 서버) ===');

  await test('처음 연동: 시트 자동 생성 + 월별 탭/알바생/점검 보관함/데이터 탭 기록 (최근 달이 앞)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-10': { net: 1 }, '2026-11': { net: 2 } }), worker('영희', { '2026-11': { net: 3 } })];
    assert.strictEqual(await a.cloud.connect(), true);
    assert.strictEqual(Object.keys(g.files).length, 1);
    assert.strictEqual(g.files.sheet1.title, '사장님 도우미 데이터');
    assert.deepStrictEqual(g.tabNames('sheet1'), ['2026-11', '2026-10', '알바생', '출퇴근기록', '점검 보관함', '데이터']);
    assert.deepStrictEqual(g.rows('sheet1', '2026-11').slice(2), [['철수', 2], ['영희', 3]]);
    assert.ok(g.rows('sheet1', '데이터').length >= 3);
    assert.ok(g.files.sheet1.tabs[0].formats > 0);     // 머리글 서식
    assert.ok(a.cloud.isConnected());
    assert.ok(/docs\.google\.com\/spreadsheets\/d\/sheet1/.test(a.cloud.sheetUrl()));
  });

  await test('다른 기기에서 같은 계정으로 연동하면 저장된 기록을 불러옴 (시트는 새로 만들지 않음)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    a.data.store = { store: '행복분식', inspector: '김사장' };
    await a.cloud.connect();
    const b = makeDevice(g);
    assert.strictEqual(await b.cloud.connect(), true);
    assert.strictEqual(Object.keys(g.files).length, 1);
    assert.strictEqual(b.data.workers.length, 1);
    assert.strictEqual(b.data.workers[0].name, '철수');
    assert.strictEqual(b.data.store.store, '행복분식');
  });

  await test('한 달만 고치면 그 달 탭(과 데이터 탭)만 다시 씀 — 나머지 달 탭은 건드리지 않음', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-09': { net: 1 }, '2026-10': { net: 2 }, '2026-11': { net: 3 } })];
    await a.cloud.connect();
    g.writes.length = 0;
    a.data.workers[0].months['2026-11'].net = 99;
    a.cloud.markDirty();
    assert.strictEqual(await a.cloud.saveNow(), true);
    assert.deepStrictEqual(g.writes.slice().sort(), ['2026-11', '데이터']);
    assert.deepStrictEqual(g.rows('sheet1', '2026-11').slice(2), [['철수', 99]]);
    assert.deepStrictEqual(g.rows('sheet1', '2026-10').slice(2), [['철수', 2]]);
  });

  await test('새 달 기록을 만들면 탭이 자동으로 추가되고 순서가 맞춰짐', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-10': { net: 2 } })];
    await a.cloud.connect();
    a.data.workers[0].months['2026-11'] = { net: 5 };
    a.cloud.markDirty();
    await a.cloud.saveNow();
    assert.deepStrictEqual(g.tabNames('sheet1'), ['2026-11', '2026-10', '알바생', '출퇴근기록', '점검 보관함', '데이터']);
  });

  await test('알바생을 지워 기록이 없어진 달의 탭은 시트에서도 사라짐', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-10': { net: 2 } }), worker('영희', { '2026-09': { net: 1 } })];
    await a.cloud.connect();
    assert.ok(g.tabNames('sheet1').includes('2026-09'));
    a.data.workers.pop();
    a.cloud.markDirty();
    await a.cloud.saveNow();
    assert.ok(!g.tabNames('sheet1').includes('2026-09'));
    assert.ok(g.tabNames('sheet1').includes('2026-10'));
  });

  await test('5년(60개월) 지난 달 탭은 시트에서만 정리되고 안내가 나옴 — 앱 안 기록은 그대로', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    // 2026-11 기준 보관 시작은 2021-12
    a.data.workers = [worker('철수', { '2021-11': { net: 1 }, '2021-12': { net: 2 }, '2026-11': { net: 3 } })];
    await a.cloud.connect();
    assert.ok(!g.tabNames('sheet1').includes('2021-11'));      // 처음부터 시트에는 올리지 않음
    assert.ok(g.tabNames('sheet1').includes('2021-12'));
    // 예전에 올라가 있던 오래된 탭이 있으면 저장할 때 지워짐
    g.files.sheet1.tabs.push({ id: 999, title: '2020-05', rows: [['옛날']], formats: 0 });
    a.data.workers[0].months['2026-11'].net = 4;
    a.cloud.markDirty();
    await a.cloud.saveNow();
    assert.ok(!g.tabNames('sheet1').includes('2020-05'));
    assert.ok(/5년이 지난 1개 달/.test(a.lastStatus.notice));
    // 이 기기의 기록은 그대로
    assert.ok(a.data.workers[0].months['2021-11']);
    // 데이터 탭(앱 원본)에는 오래된 달도 남아 있어 다른 기기로 옮길 때 사라지지 않음
    const raw = g.rows('sheet1', '데이터').slice(2).map(r => r[0]).join('');
    assert.ok(raw.indexOf('2021-11') >= 0);
  });

  await test('출퇴근기록 탭: 머리글만 만들고, 밖에서 추가한 기록은 이후 저장에도 지우거나 덮어쓰지 않음', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    assert.ok(g.tabNames('sheet1').includes('출퇴근기록'));
    assert.strictEqual(g.rows('sheet1', '출퇴근기록')[0][1], '알바생 고유코드');
    assert.strictEqual(g.rows('sheet1', '출퇴근기록')[0][5], '처리결과');
    // 출퇴근 프로그램이 한 줄 추가했다고 가정
    g.files.sheet1.tabs.find(t => t.title === '출퇴근기록').rows.push(['2026-11-12 09:01', 'ABCD2345', '철수', '출근', 'QR', '']);
    g.writes.length = 0;
    a.data.workers[0].months['2026-11'].net = 77;
    a.cloud.markDirty();
    await a.cloud.saveNow();
    assert.ok(!g.writes.includes('출퇴근기록'));
    assert.strictEqual(g.rows('sheet1', '출퇴근기록').length, 2);
    assert.strictEqual(g.rows('sheet1', '출퇴근기록')[1][2], '철수');
    // 순서: 알바생 바로 뒤
    const names = g.tabNames('sheet1');
    assert.strictEqual(names[names.indexOf('알바생') + 1], '출퇴근기록');
  });

  await test('출퇴근 기록은 출퇴근기록 탭 맨 아래에 한 줄씩 덧붙고, 연동 전에는 거절됨', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await assert.rejects(() => a.cloud.appendPunch([['x']]));
    await a.cloud.connect();
    await a.cloud.appendPunch([['2026-11-12 09:01:10', 'ABCD2345', '철수', '출근', '이름+비밀번호', '정상', '']]);
    await a.cloud.appendPunch([['2026-11-12 18:00:02', 'ABCD2345', '철수', '퇴근', '이름+비밀번호', '정상', '']]);
    const rows = g.rows('sheet1', '출퇴근기록');
    assert.strictEqual(rows.length, 3);
    assert.strictEqual(rows[2][3], '퇴근');
    // 이후 일반 저장이 덧붙인 줄을 지우지 않음
    a.data.workers[0].months['2026-11'].net = 9;
    a.cloud.markDirty();
    await a.cloud.saveNow();
    assert.strictEqual(g.rows('sheet1', '출퇴근기록').length, 3);
  });

  await test('관리자 비밀번호: 시트 관리자 탭 B1에 적히고, 사장님이 시트에서 고친 값은 앱이 덮어쓰지 않으며, 읽어 올 수 있음', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    assert.ok(!g.tabNames('sheet1').includes('관리자'));          // 비밀번호가 없으면 탭도 없음
    a.pin = '1234';
    await a.cloud.setAdminPin('1234');                              // 탭이 아직 없으니 저장하면서 만들어짐
    assert.ok(g.tabNames('sheet1').includes('관리자'));
    assert.strictEqual(g.rows('sheet1', '관리자')[0][1], '1234');
    const names = g.tabNames('sheet1');
    assert.strictEqual(names[names.indexOf('출퇴근기록') + 1], '관리자');
    g.rows('sheet1', '관리자')[0][1] = 'abcd';                      // 사장님이 시트에서 직접 고침
    a.data.workers[0].months['2026-11'].net = 50;
    a.cloud.markDirty();
    await a.cloud.saveNow();
    assert.strictEqual(await a.cloud.readAdminPin('user'), 'abcd');  // 일반 저장이 덮어쓰지 않음
    await a.cloud.setAdminPin('9999');                              // 앱에서 바꾸면 B1 칸이 갱신
    assert.strictEqual(g.rows('sheet1', '관리자')[0][1], '9999');
    a.pin = '';                                                      // 이 기기에서 비밀번호가 사라져도(저장소 삭제 등) 시트 탭은 지우지 않음
    a.data.workers[0].months['2026-11'].net = 51;
    a.cloud.markDirty();
    await a.cloud.saveNow();
    assert.ok(g.tabNames('sheet1').includes('관리자'));
    assert.strictEqual(await a.cloud.readAdminPin('user'), '9999');
  });

  await test('예전에 만든 시트(출퇴근기록 탭 없음)도 다음 저장 때 탭이 생김', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    g.files.sheet1.tabs = g.files.sheet1.tabs.filter(t => t.title !== '출퇴근기록');
    a.data.workers[0].months['2026-11'].net = 3;
    a.cloud.markDirty();
    await a.cloud.saveNow();
    assert.ok(g.tabNames('sheet1').includes('출퇴근기록'));
    assert.strictEqual(g.rows('sheet1', '출퇴근기록').length, 1);
  });

  await test('예전 머리글(처리결과 열 없음)의 출퇴근기록 탭은 머리글 첫 줄만 고치고 아래 기록은 그대로 둠', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    const tab = g.files.sheet1.tabs.find(t => t.title === '출퇴근기록');
    tab.rows = [['기록시각', '알바생 고유코드', '이름', '구분(출근/퇴근)', '입력방식', '메모'], ['2026-11-12 09:01', 'ABCD2345', '철수', '출근', 'QR', '']];
    const b = makeDevice(g);                       // 새 실행(확인 기록 없음)
    await b.cloud.connect();
    b.data.workers[0].months['2026-11'].net = 5;
    b.cloud.markDirty();
    await b.cloud.saveNow();
    const rows = g.rows('sheet1', '출퇴근기록');
    assert.strictEqual(rows[0][5], '처리결과');
    assert.strictEqual(rows[1][2], '철수');
    assert.strictEqual(rows[1][3], '출근');
  });

  await test('예전 버전이 만든 "정산 명단" 탭은 새 저장 때 정리됨', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    g.files.sheet1.tabs.push({ id: 998, title: '정산 명단', rows: [['옛']], formats: 0 });
    a.data.workers[0].months['2026-11'].net = 3;
    a.cloud.markDirty();
    await a.cloud.saveNow();
    assert.ok(!g.tabNames('sheet1').includes('정산 명단'));
  });

  await test('예전 형식(정산 명단 roster)으로 저장된 시트도 기록이 있는 것으로 인식해 불러옴', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data = { roster: [{ name: '옛철수', payMonth: '2026-10' }], archive: [], presets: [], store: {} };
    a.cloud.init({
      getData: () => JSON.parse(JSON.stringify(a.data)),
      getTables: () => ({ sheets: [] }),
      applyData: d => { a.data = JSON.parse(JSON.stringify(d)); },
      confirm: () => true,
      onStatus: () => {}
    });
    await a.cloud.connect();
    const b = makeDevice(g);
    assert.strictEqual(await b.cloud.connect(), true);
    assert.strictEqual(b.data.roster.length, 1);      // 앱(cloudApply)이 이것을 알바생 기록으로 변환
  });

  await test('변경 후 저장 → 다른 기기를 열면 최신 내용을 받아 옴', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    const b = makeDevice(g);
    await b.cloud.connect();
    a.clock.t += 60000;
    a.data.workers.push(worker('민수', { '2026-11': { net: 7 } }));
    a.cloud.markDirty();
    assert.strictEqual(await a.cloud.saveNow(), true);
    b.clock.t += 120000;
    await b.cloud.resume();
    assert.strictEqual(b.data.workers.length, 2);
  });

  await test('양쪽에 기록이 다르면 확인창: [확인]=시트 우선, [취소]=이 기기 우선', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('시트쪽', { '2026-11': { net: 1 } })];
    await a.cloud.connect();
    const b = makeDevice(g);
    b.data.workers = [worker('기기쪽', { '2026-11': { net: 1 } })];
    b.confirmAnswer = true;
    await b.cloud.connect();
    assert.strictEqual(b.data.workers[0].name, '시트쪽');

    const c = makeDevice(g);
    c.data.workers = [worker('기기쪽', { '2026-11': { net: 1 } })];
    c.confirmAnswer = false;
    await c.cloud.connect();
    assert.strictEqual(c.data.workers[0].name, '기기쪽');
    const d = makeDevice(g);
    await d.cloud.connect();
    assert.strictEqual(d.data.workers[0].name, '기기쪽');
  });

  await test('저장 중 401(열쇠 만료)이 나면 새 열쇠로 한 번 다시 시도', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    a.data.workers.push(worker('영희', { '2026-11': { net: 3 } }));
    a.cloud.markDirty();
    g.fail401Once = true;
    assert.strictEqual(await a.cloud.saveNow(), true);
    assert.strictEqual(g.rows('sheet1', '2026-11').length, 4);
  });

  await test('자동 저장이 로그인 문제로 실패하면 "다시 연결" 상태가 되고, 변경 내용은 보관', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    a.data.workers.push(worker('영희', { '2026-11': { net: 3 } }));
    a.cloud.markDirty();
    a.clock.t += 2 * 3600 * 1000;
    a.tokenFail = true;
    const ok = await a.cloud.saveNow();
    assert.strictEqual(ok, false);
    assert.ok(['error', 'needLogin'].includes(a.cloud.getStatus().kind));
    assert.ok(JSON.parse(a.store['alba.cloud.v1']).dirty);
    a.tokenFail = false;
    assert.strictEqual(await a.cloud.saveNow(), true);
    assert.strictEqual(g.rows('sheet1', '2026-11').length, 4);
    assert.strictEqual(JSON.parse(a.store['alba.cloud.v1']).dirty, false);
  });

  await test('앱을 다시 열 때 저장 안 된 변경이 있으면 시트 내용으로 덮어쓰지 않고 먼저 저장', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    a.data.workers.push(worker('오프라인에서 추가', { '2026-11': { net: 3 } }));
    a.cloud.markDirty();
    assert.ok(a.timers.length >= 1);
    const b = makeDevice(g, { store: a.store });
    b.data = JSON.parse(JSON.stringify(a.data));
    await b.cloud.resume();
    assert.strictEqual(g.rows('sheet1', '2026-11').length, 4);
  });

  await test('구글 드라이브에서 시트를 지워도 다음 저장 때 새로 만들어 이어서 저장', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    g.files.sheet1.deleted = true;
    a.data.workers.push(worker('영희', { '2026-11': { net: 3 } }));
    a.cloud.markDirty();
    assert.strictEqual(await a.cloud.saveNow(), true);
    assert.ok(g.files.sheet2);
    assert.strictEqual(g.rows('sheet2', '2026-11').length, 4);
    assert.deepStrictEqual(g.tabNames('sheet2'), ['2026-11', '알바생', '출퇴근기록', '점검 보관함', '데이터']);
  });

  await test('내용을 바꾸면 3초 뒤 자동 저장이 실행됨 (같은 내용이면 저장하지 않음)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    const n0 = a.timers.length;
    a.cloud.markDirty();
    assert.strictEqual(a.timers.length, n0);
    a.data.workers.push(worker('영희', { '2026-11': { net: 3 } }));
    a.cloud.markDirty();
    assert.strictEqual(a.timers.length, n0 + 1);
    assert.strictEqual(a.timers[n0].ms, 3000);
    await a.timers[n0].f();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(g.rows('sheet1', '2026-11').length, 4);
  });

  await test('연동 끊기: 열쇠 폐기 + 연동 정보 삭제 (구글 파일은 그대로)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    a.cloud.disconnect();
    assert.strictEqual(a.revoked, true);
    assert.strictEqual(a.cloud.isConnected(), false);
    assert.strictEqual(a.store['alba.cloud.v1'], undefined);
    assert.ok(g.files.sheet1);
    a.data.workers.push(worker('영희'));
    a.cloud.markDirty();
    const before = g.calls.length;
    assert.strictEqual(await a.cloud.saveNow(), false);
    assert.strictEqual(g.calls.length, before);
  });

  await test('다시 로그인(불러오기) 때 출퇴근기록 장부를 읽어 저장 이후 기록을 복구하도록 넘김', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', { '2026-11': { net: 2 } })];
    await a.cloud.connect();
    const stamp = Date.parse(JSON.parse(a.store['alba.cloud.v1']).stamp.split('#')[0]);
    await a.cloud.appendPunch([['2026-11-12 12:00:00', 'C1', '철수', '출근', '이름+비밀번호', '정상', '']]);
    const b = makeDevice(g);                       // 새 기기(저장소 비어 있음)로 로그인
    b.confirmAnswer = true;
    await b.cloud.connect();
    assert.ok(b.replayed, '장부 재생이 호출되어야 함');
    assert.strictEqual(b.replayed.rows.length, 1);
    assert.strictEqual(b.replayed.rows[0][3], '출근');
    assert.strictEqual(b.replayed.afterMs, stamp);
    b.replayed = null;
    assert.strictEqual(await b.cloud.loadFromSheet(), 'ok');   // [시트에서 불러오기]도 마찬가지
    assert.ok(b.replayed);
  });

  await test('이미 연동된 기기가 다시 로그인해도 묻지 않고, 이 기기의 저장 안 된 출퇴근 상태를 지키지 않고 덮어쓰지 않음', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', {})];
    await a.cloud.connect();
    // 출근을 찍었지만 시트 저장 전(저장 대기 중)에 로그인 창이 뜬 상황
    a.data.workers[0].punch = { date: '2026-11-12', time: '09:30', at: '09:05' };
    a.data.workers[0].password = '1234';
    a.cloud.markDirty();
    let asked = 0;
    a.confirmAnswer = true;
    const origConfirm = a.confirmAnswer;
    a.tokenFail = true;                       // 토큰 만료 → 다시 로그인 필요
    await a.cloud.resume();
    a.tokenFail = false;
    await a.cloud.connect();                  // 사용자가 [다시 로그인]
    assert.strictEqual(a.data.workers[0].password, '1234');
    assert.deepStrictEqual(a.data.workers[0].punch, { date: '2026-11-12', time: '09:30', at: '09:05' });
    const saved = JSON.parse(g.rows('sheet1', '데이터').slice(2).map(r => r[0]).join(''));
    assert.strictEqual(saved.workers[0].password, '1234');   // 시트에도 반영됨
  });

  await test('검토 반영: 퇴근 확인 필요(pending) 목록은 항목별로 합침 — 양쪽 추가 모두 살림, 처리한 항목은 되살아나지 않음', async () => {
    const m = makeDevice(makeGoogle()).cloud.merge3;
    const P1 = { id: '2026-11-12 18:00', date: '2026-11-12', start: '18:00' }, P2 = { id: '2026-11-13 19:00', date: '2026-11-13', start: '19:00' };
    // 기준엔 없음, 두 기기가 각각 다른 항목 추가 → 둘 다
    assert.deepStrictEqual(m({ pending: [] }, { pending: [P1] }, { pending: [P2] }).pending, [P1, P2]);
    assert.deepStrictEqual(m(undefined, { pending: [P1] }, { pending: [P2] }).pending, [P1, P2]);
    // 묘비 목록은 합집합 (길이가 같아도 칸별로 합치지 않음)
    assert.deepStrictEqual(m(undefined, { pendingDone: ['2026-11-15 18:00'] }, { pendingDone: ['2026-11-15 19:00'] }).pendingDone, ['2026-11-15 18:00', '2026-11-15 19:00']);
    assert.deepStrictEqual(m({ pendingDone: ['2026-11-01 09:00'] }, { pendingDone: ['2026-11-15 19:00'] }, { pendingDone: ['2026-11-15 18:00'] }).pendingDone, ['2026-11-15 18:00', '2026-11-15 19:00']);
    // 이 기기가 P1 확인(빈 목록), 다른 기기는 P2 추가 → P2만
    assert.deepStrictEqual(m({ pending: [P1] }, { pending: [] }, { pending: [P1, P2] }).pending, [P2]);
    // 반대 방향
    assert.deepStrictEqual(m({ pending: [P1] }, { pending: [P1, P2] }, { pending: [] }).pending, [P2]);
    // 예전 버전이 저장한 id 없는 항목도 id를 붙여 같은 항목으로 맞춤 (중복 생기지 않음)
    const md = makeDevice(makeGoogle()).cloud.mergeData;
    const old = { date: '2026-11-12', start: '18:00' };
    const out = md({ workers: [{ id: 'a', pending: [Object.assign({}, old)] }] }, { workers: [{ id: 'a', pending: [P1, P2] }] }, { workers: [{ id: 'a', pending: [Object.assign({}, old)] }] });
    assert.deepStrictEqual(out.workers[0].pending.map(p => p.id), [P1.id, P2.id]);
  });

  await test('합치기(merge3): 양쪽 변경 모두 살림 · 지운 것은 지움 · 같은 칸 충돌만 이 기기 우선', async () => {
    const m = makeDevice(makeGoogle()).cloud.merge3;
    const b = { workers: [{ id: 'a', name: '가', wage: 1, months: { '2026-11': { d: [1, 2, 3] } } }, { id: 'b', name: '나', wage: 1 }, { id: 'c', name: '다' }], archive: [{ x: 1 }], settings: { u: 30, g: 0 } };
    const l = JSON.parse(JSON.stringify(b)), r = JSON.parse(JSON.stringify(b));
    l.workers[0].wage = 2;                          // 이 기기: 가 시급
    l.workers[0].months['2026-11'].d[0] = 9;        // 이 기기: 가 1일
    r.workers[0].punch = { date: '2026-11-16', time: '09:00' };   // 다른 기기: 가 출근
    r.workers[0].months['2026-11'].d[2] = 7;        // 다른 기기: 가 3일
    r.workers[1].wage = 5;                          // 다른 기기: 나 시급
    l.workers.push({ id: 'd', name: '라' });         // 이 기기: 새 알바생
    r.workers.push({ id: 'e', name: '마' });         // 다른 기기: 새 알바생
    l.workers = l.workers.filter(w => w.id !== 'c'); // 이 기기: 다 삭제
    l.archive.push({ x: 2 }); r.archive.push({ x: 3 });   // 양쪽 보관함 추가
    r.settings.g = 5; l.settings.u = 15;
    const o = m(b, l, r);
    const by = id => o.workers.find(w => w.id === id);
    assert.strictEqual(by('a').wage, 2);
    assert.deepStrictEqual(by('a').punch, { date: '2026-11-16', time: '09:00' });
    assert.deepStrictEqual(by('a').months['2026-11'].d, [9, 2, 7]);
    assert.strictEqual(by('b').wage, 5);
    assert.ok(by('d') && by('e'));
    assert.strictEqual(by('c'), undefined);
    assert.deepStrictEqual(o.archive, [{ x: 1 }, { x: 2 }, { x: 3 }]);
    assert.deepStrictEqual(o.settings, { u: 15, g: 5 });
    // 같은 칸 충돌 → 이 기기
    const l2 = JSON.parse(JSON.stringify(b)), r2 = JSON.parse(JSON.stringify(b));
    l2.workers[1].wage = 7; r2.workers[1].wage = 8;
    assert.strictEqual(m(b, l2, r2).workers.find(w => w.id === 'b').wage, 7);
    // 다른 기기가 지운 알바생을 이 기기가 안 건드렸으면 지움 / 다른 기기가 퇴근 처리(punch 삭제)한 것도 반영
    const l3 = JSON.parse(JSON.stringify(r)), r3 = JSON.parse(JSON.stringify(r));
    r3.workers = r3.workers.filter(w => w.id !== 'e'); delete r3.workers[0].punch;
    const o3 = m(r, l3, r3);
    assert.strictEqual(o3.workers.find(w => w.id === 'e'), undefined);
    assert.strictEqual(o3.workers[0].punch, undefined);
    // 기준이 없으면(업데이트 직후) 지운 건 못 알아보지만 양쪽 추가·변경은 살림
    const o4 = m(undefined, l, r);
    assert.ok(o4.workers.find(w => w.id === 'd') && o4.workers.find(w => w.id === 'e'));
  });

  await test('갤럭시에서 출근 → 옛 화면의 아이패드가 다른 걸 고쳐 저장해도 출근이 사라지지 않음', async () => {
    const g = makeGoogle();
    const galaxy = makeDevice(g);
    galaxy.data.workers = [worker('철수', { '2026-11': { net: 1 } }), worker('영희', {})];
    await galaxy.cloud.connect();
    const ipad = makeDevice(g);
    await ipad.cloud.connect();                         // 아이패드: 이때 내용을 받아 둠 (이후 새로고침 안 함)
    galaxy.clock.t += 60000; ipad.clock.t += 60000;
    galaxy.data.workers[0].punch = { date: '2026-11-16', time: '09:00', at: '08:58' };   // 갤럭시: 철수 출근
    galaxy.cloud.markDirty(); await galaxy.cloud.saveNow();
    galaxy.clock.t += 60000; ipad.clock.t += 60000;
    ipad.data.workers[1].wage = 11000;                  // 아이패드(옛 화면): 영희 시급 수정
    ipad.cloud.markDirty(); await ipad.cloud.saveNow();
    const sid = JSON.parse(galaxy.store['alba.cloud.v1']).sheetId;
    const sheet = JSON.parse(g.rows(sid, '데이터').slice(2).map(r => r[0]).join(''));
    assert.deepStrictEqual(sheet.workers[0].punch, { date: '2026-11-16', time: '09:00', at: '08:58' }, '갤럭시 출근이 사라짐');
    assert.strictEqual(sheet.workers[1].wage, 11000);
    assert.deepStrictEqual(ipad.data, sheet);           // 아이패드 화면에도 출근이 보임
    assert.strictEqual(ipad.cloud.mergeCount(), 1);
    // 갤럭시가 30초 새로 받기 → 영희 시급도 보임
    galaxy.clock.t += 30000;
    assert.strictEqual(await galaxy.cloud.refresh(), true);
    assert.deepStrictEqual(galaxy.data, sheet);
    assert.strictEqual(await galaxy.cloud.refresh(), false);   // 바뀐 게 없으면 그대로
  });

  await test('오래 꺼 둔 기기: 옛 출근을 퇴근 처리한 변경과 다른 기기의 오늘 출근이 겹쳐도 오늘 출근을 지우지 않음', async () => {
    const m = makeDevice(makeGoogle()).cloud.merge3;
    const old = { date: '2026-11-12', time: '18:00', at: '17:55' }, today = { date: '2026-11-16', time: '09:00', at: '08:58' };
    const b = { workers: [{ id: 'a', name: '철수', punch: old, months: {} }] };
    const l = { workers: [{ id: 'a', name: '철수', pending: [{ date: '2026-11-12', start: '18:00' }], months: {} }] };   // 옛 기기: 자동 퇴근
    const r = { workers: [{ id: 'a', name: '철수', punch: today, months: { '2026-11': { d: 1 } } }] };                // 다른 기기: 그사이 퇴근·오늘 출근
    const o = m(b, l, r).workers[0];
    assert.deepStrictEqual(o.punch, today);
    assert.deepStrictEqual(o.months, { '2026-11': { d: 1 } });
    // 반대 방향도 같음
    assert.deepStrictEqual(m(b, r, l).workers[0].punch, today);
    // 둘 다 지웠으면 지움 / 한쪽만 지우고 다른 쪽 그대로면 지움
    assert.strictEqual(m(b, l, l).workers[0].punch, undefined);
    assert.strictEqual(m(b, l, b).workers[0].punch, undefined);
  });

  await test('2차 검토: 같은 날 근무 칸을 두 기기가 다르게 고치면 섞지 않고, 겹친 수정 목록(conflicts)에 덮인 값을 남김', async () => {
    const md = makeDevice(makeGoogle()).cloud.mergeData;
    const cell = (s, e, b) => ({ off: false, start: s, end: e, breakMinutes: b || 0 });
    const off = { off: true, start: '', end: '', breakMinutes: 0 };
    const mk = sh => ({ workers: [{ id: 'a', name: '김', months: { '2026-11': { wage: 10320, dailyShifts: sh } } }] });
    // 점장(이 기기): 출근을 08:30으로, 태블릿(시트): 퇴근 14:00 기록
    const base = mk([off, cell('09:00', '12:00')]);
    const l = mk([off, cell('08:30', '12:00')]);
    const r = mk([off, cell('09:00', '14:00')]);
    const m = md(base, l, r);
    assert.deepStrictEqual(m.workers[0].months['2026-11'].dailyShifts[1], cell('08:30', '12:00'));   // 섞이지 않음 (08:30~14:00 같은 제3의 값 없음)
    assert.strictEqual(m.conflicts.length, 1);
    assert.deepStrictEqual(m.conflicts[0].path, ['workers', 'a', 'months', '2026-11', 'dailyShifts', 1]);
    assert.deepStrictEqual(m.conflicts[0].remote, cell('09:00', '14:00'));
    // 다른 칸만 바꾼 정상 경우엔 충돌 없음
    const m2 = md(base, mk([cell('10:00', '11:00'), cell('09:00', '12:00')]), mk([off, cell('09:00', '14:00')]));
    assert.strictEqual(m2.conflicts, undefined);
    assert.deepStrictEqual(m2.workers[0].months['2026-11'].dailyShifts, [cell('10:00', '11:00'), cell('09:00', '14:00')]);
    // 첫 달 기록을 양쪽이 만들며 시급이 다름 → 겹친 수정으로 남음
    const m3 = md({ workers: [{ id: 'a', months: {} }] }, { workers: [{ id: 'a', months: { '2026-11': { wage: 10000 } } }] }, { workers: [{ id: 'a', months: { '2026-11': { wage: 12000 } } }] });
    assert.strictEqual(m3.workers[0].months['2026-11'].wage, 10000);
    assert.deepStrictEqual(m3.conflicts.map(c => [c.path.join('/'), c.remote]), [['workers/a/months/2026-11/wage', 12000]]);
    // 첫 달 기록을 양쪽이 만들 때: 태블릿 퇴근 칸(근무)과 점장 쪽 기본 휴무 칸 → 근무가 살아남음, 충돌 아님
    const m6 = md({ workers: [{ id: 'a', months: {} }] }, { workers: [{ id: 'a', months: { '2026-11': { wage: 12000, dailyShifts: [off, off] } } }] }, { workers: [{ id: 'a', months: { '2026-11': { wage: 12000, dailyShifts: [off, cell('09:00', '14:00')] } } }] });
    assert.deepStrictEqual(m6.workers[0].months['2026-11'].dailyShifts, [off, cell('09:00', '14:00')]);
    assert.strictEqual(m6.conflicts, undefined);
    // 같은 충돌은 한 번만, 출퇴근 내부 상태(lastTs 등)는 알리지 않음
    const m4 = md(Object.assign(base, { conflicts: [] }), Object.assign(l, { conflicts: m.conflicts }), r);
    assert.strictEqual(m4.conflicts.length, 1);
    const m5 = md({ workers: [{ id: 'a', lastTs: '1' }] }, { workers: [{ id: 'a', lastTs: '2' }] }, { workers: [{ id: 'a', lastTs: '3' }] });
    assert.strictEqual(m5.conflicts, undefined);
  });

  /* ===== 3차: 단일 저장(출퇴근 기기만 저장, 다른 기기는 수정 요청) ===== */
  const cell = (s, e) => ({ off: false, start: s, end: e, breakMinutes: 0 });
  const OFF = { off: true, start: '09:00', end: '14:00', breakMinutes: 0 };
  const shifts = () => Array.from({ length: 30 }, () => Object.assign({}, OFF));
  async function shop() {
    const g = makeGoogle();
    const tab = makeDevice(g);   // 매장 태블릿
    tab.data.workers = [worker('김', { '2026-11': { wage: 10320, dailyShifts: shifts() } }), worker('이', { '2026-11': { wage: 10320, dailyShifts: shifts() } })];
    await tab.cloud.connect();
    assert.strictEqual(await tab.cloud.designate('매장 태블릿'), true);
    const ph = makeDevice(g);    // 점장 폰
    ph.events = [];
    ph.host = null;
    await ph.cloud.connect();
    const sid = JSON.parse(tab.store['alba.cloud.v1']).sheetId;
    const tick = async (d, ms) => { d.clock.t += ms || 31000; return d.cloud.refresh(); };
    return { g, tab, ph, sid, tick };
  }
  const W = (d, n) => d.data.workers.find(w => w.name === n);
  const dataTab = (g, sid) => JSON.parse(g.rows(sid, '데이터').slice(2).map(r => r[0]).join(''));

  await test('3차 단일 저장: 지정하면 기기 탭에 기록, 다른 기기는 요청 기기가 되고 데이터 탭을 쓰지 않음', async () => {
    const { g, tab, ph, sid } = await shop();
    assert.strictEqual(tab.cloud.role(), 'writer');
    assert.strictEqual(ph.cloud.role(), 'requester');
    assert.strictEqual(g.rows(sid, '기기')[0][1], '매장 태블릿');
    assert.strictEqual(ph.cloud.deviceInfo().dev.name, '매장 태블릿');
    assert.deepStrictEqual(ph.data.workers.map(w => w.name), ['김', '이']);   // 읽기는 됨
    const before = JSON.stringify(g.rows(sid, '데이터'));
    W(ph, '김').months['2026-11'].dailyShifts[15] = cell('09:00', '13:00');
    ph.cloud.markDirty(); await ph.cloud.saveNow();
    assert.strictEqual(JSON.stringify(g.rows(sid, '데이터')), before, '요청 기기는 데이터 탭을 쓰지 않음');
    const req = g.rows(sid, '수정요청');
    assert.strictEqual(req.length, 2);
    const ops = JSON.parse(req[1][5]);
    assert.deepStrictEqual(ops, [{ path: ['workers', { id: 'id-김' }, 'months', '2026-11', 'dailyShifts', 15], before: OFF, after: cell('09:00', '13:00') }]);
    assert.strictEqual(ph.cloud.deviceInfo().queued, 1);
  });

  await test('3차 단일 저장: 출퇴근 기기가 요청을 적용·기록하고, 요청 기기는 결과를 받아 대기 목록을 비움', async () => {
    const { g, tab, ph, sid, tick } = await shop();
    W(ph, '김').months['2026-11'].dailyShifts[15] = cell('09:00', '13:00');
    W(ph, '이').wage = 11000;
    ph.cloud.markDirty(); await ph.cloud.saveNow();
    await tick(tab);
    assert.deepStrictEqual(W(tab, '김').months['2026-11'].dailyShifts[15], cell('09:00', '13:00'));
    assert.strictEqual(W(tab, '이').wage, 11000);
    assert.deepStrictEqual(dataTab(g, sid).workers.find(w => w.name === '김').months['2026-11'].dailyShifts[15], cell('09:00', '13:00'));
    assert.strictEqual(g.rows(sid, '수정요청')[1][6], '적용됨');
    const log = dataTab(g, sid).reqLog;
    assert.strictEqual(log.applied.length, 1);
    assert.strictEqual(log.cursor, 3);
    // 다시 새로 받아도 두 번 적용하지 않음
    W(tab, '김').months['2026-11'].dailyShifts[15] = cell('10:00', '13:00'); tab.cloud.markDirty(); await tab.cloud.saveNow();
    await tick(tab);
    assert.deepStrictEqual(W(tab, '김').months['2026-11'].dailyShifts[15], cell('10:00', '13:00'));
    // 요청 기기: 결과 받음
    const got = [];
    ph.cloud.__onReq = got;
    await tick(ph);
    assert.strictEqual(ph.cloud.deviceInfo().queued, 0);
    assert.deepStrictEqual(W(ph, '김').months['2026-11'].dailyShifts[15], cell('10:00', '13:00'));
  });

  await test('3차 단일 저장: 그 사이 같은 칸이 바뀌었으면 요청 전체 거절 (일부만 적용 없음), 요청 기기 화면은 되돌아감', async () => {
    const { g, tab, ph, sid, tick } = await shop();
    W(ph, '김').months['2026-11'].dailyShifts[15] = cell('09:00', '13:00');
    W(ph, '이').wage = 11000;
    ph.cloud.markDirty(); await ph.cloud.saveNow();
    // 태블릿에서 그 사이 김의 16일 퇴근이 찍힘
    W(tab, '김').months['2026-11'].dailyShifts[15] = cell('09:00', '14:00'); tab.cloud.markDirty(); await tab.cloud.saveNow();
    await tick(tab);
    assert.deepStrictEqual(W(tab, '김').months['2026-11'].dailyShifts[15], cell('09:00', '14:00'));
    assert.strictEqual(W(tab, '이').wage, 10320, '같은 요청의 다른 변경도 적용 안 됨');
    assert.strictEqual(g.rows(sid, '수정요청')[1][6], '거절');
    await tick(ph);
    assert.strictEqual(ph.cloud.deviceInfo().queued, 0);
    assert.deepStrictEqual(W(ph, '김').months['2026-11'].dailyShifts[15], cell('09:00', '14:00'));
    assert.strictEqual(W(ph, '이').wage, 10320);
  });

  await test('3차 단일 저장: 같은 칸을 연달아 두 번 고치면 둘 다 순서대로 적용, 대기 중에도 화면엔 내 수정이 보임', async () => {
    const { tab, ph, tick } = await shop();
    W(ph, '김').months['2026-11'].dailyShifts[15] = cell('09:00', '16:00'); ph.cloud.markDirty(); await ph.cloud.saveNow();
    W(ph, '김').months['2026-11'].dailyShifts[15] = cell('09:00', '17:00'); ph.cloud.markDirty(); await ph.cloud.saveNow();
    // 태블릿이 아직 처리 전에 요청 기기가 새로 받아도 내 수정은 그대로 보임
    tab.data.workers[1].name = '이영'; tab.cloud.markDirty(); await tab.cloud.saveNow();
    await tick(ph);
    assert.deepStrictEqual(W(ph, '김').months['2026-11'].dailyShifts[15], cell('09:00', '17:00'));
    assert.ok(W(ph, '이영'));
    await tick(tab);
    assert.deepStrictEqual(W(tab, '김').months['2026-11'].dailyShifts[15], cell('09:00', '17:00'));
    await tick(ph);
    assert.strictEqual(ph.cloud.deviceInfo().queued, 0);
  });

  await test('3차 단일 저장: 점검 보관함을 양쪽에서 동시에 추가·삭제해도 거절 없이 모두 반영', async () => {
    const { tab, ph, tick } = await shop();
    tab.data.archive = [{ date: '2026-11-01' }]; tab.cloud.markDirty(); await tab.cloud.saveNow();
    await tick(ph);
    ph.data.archive.push({ date: '2026-11-16', who: '점장' }); ph.cloud.markDirty(); await ph.cloud.saveNow();
    ph.data.archive = ph.data.archive.filter(x => x.date !== '2026-11-01'); ph.cloud.markDirty(); await ph.cloud.saveNow();
    tab.data.archive.push({ date: '2026-11-16', who: '태블릿' }); tab.cloud.markDirty(); await tab.cloud.saveNow();
    await tick(tab);
    assert.deepStrictEqual(tab.data.archive.map(x => x.who).sort(), ['점장', '태블릿']);
  });

  await test('3차 단일 저장: 알바생 추가·삭제도 요청으로', async () => {
    const { tab, ph, tick } = await shop();
    ph.data.workers.push(worker('박', {}));
    ph.data.workers = ph.data.workers.filter(w => w.name !== '이');
    ph.cloud.markDirty(); await ph.cloud.saveNow();
    await tick(tab);
    assert.deepStrictEqual(tab.data.workers.map(w => w.name), ['김', '박']);
  });

  await test('3차 단일 저장: 요청을 못 보내면(인터넷 끊김) 보관했다가 다음에 보냄, 그 사이에도 화면엔 보임', async () => {
    const { g, tab, ph, sid, tick } = await shop();
    g.failReqAppend = 1;
    W(ph, '김').wage = 12000; ph.cloud.markDirty(); await ph.cloud.saveNow();
    assert.strictEqual(ph.cloud.deviceInfo().unsent, 1);
    assert.strictEqual((g.rows(sid, '수정요청') || []).length <= 1, true);
    await tick(ph);
    assert.strictEqual(ph.cloud.deviceInfo().unsent, 0);
    await tick(tab);
    assert.strictEqual(W(tab, '김').wage, 12000);
  });

  await test('3차 단일 저장: 처리 기록(reqLog)에 있으면 상태 칸만 고치고 다시 적용하지 않음 (저장 직후 상태 칸 쓰기 전에 꺼진 경우)', async () => {
    const { g, tab, ph, sid, tick } = await shop();
    W(ph, '김').wage = 12000; ph.cloud.markDirty(); await ph.cloud.saveNow();
    await tick(tab);
    // 상태 칸이 지워지고(꺼짐 흉내) 커서가 처음으로 돌아가도
    g.rows(sid, '수정요청')[1][6] = '';
    const m = JSON.parse(tab.store['alba.cloud.v1']);
    W(tab, '김').wage = 13000; tab.cloud.markDirty(); await tab.cloud.saveNow();
    const meta = JSON.parse(tab.store['alba.cloud.v1']);
    meta.reqLog.cursor = 2; tab.store['alba.cloud.v1'] = JSON.stringify(meta);
    const tab2 = makeDevice(g, { store: tab.store });   // 다시 켬
    tab2.data = JSON.parse(JSON.stringify(tab.data));
    await tab2.cloud.resume();
    tab2.clock.t = tab.clock.t + 31000;
    await tab2.cloud.refresh();
    assert.strictEqual(W(tab2, '김').wage, 13000, '옛 요청을 다시 적용하지 않음');
    assert.strictEqual(g.rows(sid, '수정요청')[1][6], '적용됨');
  });

  await test('3차 단일 저장: 다른 기기를 출퇴근 기기로 바꾸면 옛 기기는 저장을 멈추고, 못 올린 변경은 요청으로 보냄', async () => {
    const { g, tab, ph, sid, tick } = await shop();
    assert.strictEqual(await ph.cloud.designate('사장님 PC'), true);
    assert.strictEqual(ph.cloud.role(), 'writer');
    // 옛 태블릿: 아직 모름 → 출퇴근을 찍고 저장 시도
    W(tab, '김').months['2026-11'].dailyShifts[16] = cell('09:00', '18:00');
    const before = dataTab(g, sid);
    tab.cloud.markDirty(); await tab.cloud.saveNow();
    assert.strictEqual(tab.cloud.role(), 'requester');
    assert.deepStrictEqual(dataTab(g, sid).workers, before.workers, '옛 기기는 데이터 탭을 덮지 않음');
    assert.strictEqual(tab.cloud.deviceInfo().queued, 1);
    await tick(ph);
    assert.deepStrictEqual(W(ph, '김').months['2026-11'].dailyShifts[16], cell('09:00', '18:00'));
  });

  await test('3차 단일 저장: 옛 출퇴근 기기에서 못 올린 출근도 요청으로 넘어감 (근무 중 상태 포함)', async () => {
    const { tab, ph, tick } = await shop();
    await ph.cloud.designate('사장님 PC');
    W(tab, '김').punch = { date: '2026-11-16', time: '09:00', at: '08:58' };
    W(tab, '김').lastTs = '2026-11-16 08:58:10'; W(tab, '김').lastKind = 'in';
    tab.cloud.markDirty(); await tab.cloud.saveNow();
    assert.strictEqual(tab.cloud.role(), 'requester');
    await tick(ph);
    assert.deepStrictEqual(W(ph, '김').punch, { date: '2026-11-16', time: '09:00', at: '08:58' });
    assert.strictEqual(W(ph, '김').lastTs, '2026-11-16 08:58:10');
  });

  await test('3차 단일 저장: 요청 기기에서 고친 직후(요청 만들기 전) 새로 받아도 고친 내용이 사라지지 않음', async () => {
    const { tab, ph, tick } = await shop();
    W(ph, '김').wage = 12345; ph.cloud.markDirty();          // 아직 1.5초 대기 중
    W(tab, '이').wage = 11111; tab.cloud.markDirty(); await tab.cloud.saveNow();
    await tick(ph);                                            // 새로 받기
    assert.strictEqual(W(ph, '김').wage, 12345, '내 수정 유지');
    assert.strictEqual(W(ph, '이').wage, 11111, '다른 기기 변경 반영');
    assert.strictEqual(ph.cloud.deviceInfo().queued, 1);
    await tick(tab);
    assert.strictEqual(W(tab, '김').wage, 12345);
    assert.strictEqual(W(tab, '이').wage, 11111, '남의 변경을 되돌리지 않음');
  });

  await test('4차 검증: 사람이 시트에서 수정요청 줄을 지워 줄이 밀려도 다음 요청을 놓치지 않음', async () => {
    const { g, tab, ph, sid, tick } = await shop();
    W(ph, '김').wage = 11000; ph.cloud.markDirty(); await ph.cloud.saveNow();
    await tick(tab);
    W(ph, '김').wage = 12000; ph.cloud.markDirty(); await ph.cloud.saveNow();
    g.rows(sid, '수정요청').splice(1, 1);   // 처리된 첫 요청 줄을 사람이 지움
    await tick(tab);
    assert.strictEqual(W(tab, '김').wage, 12000);
    // 이미 처리한 줄을 다시 읽어도 두 번 적용하지 않음
    W(tab, '김').wage = 13000; tab.cloud.markDirty(); await tab.cloud.saveNow();
    await tick(tab);
    assert.strictEqual(W(tab, '김').wage, 13000);
  });

  await test('4차 검증: 지정을 해제하면 요청 기기의 반영 안 된 요청은 예전 방식(합쳐 저장)으로 올라감', async () => {
    const { tab, ph, tick } = await shop();
    W(ph, '김').wage = 11000; ph.cloud.markDirty(); await ph.cloud.saveNow();
    await tab.cloud.undesignate();
    await tick(ph); await ph.cloud.saveNow();
    assert.strictEqual(ph.cloud.role(), 'none');
    assert.strictEqual(ph.cloud.pendingRequests().length, 0);
    await tick(tab);
    assert.strictEqual(W(tab, '김').wage, 11000);
  });

  await test('4차 검증: 꺼져 있던 사이 다른 기기가 출퇴근 기기가 되면, 켤 때 저장 못 한 변경은 요청으로 넘어감', async () => {
    const g = makeGoogle();
    const a = makeDevice(g); a.data.workers = [worker('김', {})]; await a.cloud.connect();
    a.data.workers[0].wage = 15000; a.data.workers[0].punch = { date: '2026-11-16', time: '09:00', at: '09:00' };
    const meta = JSON.parse(a.store['alba.cloud.v1']); meta.dirty = true; a.store['alba.cloud.v1'] = JSON.stringify(meta);   // 저장 전에 꺼짐
    const b = makeDevice(g); await b.cloud.connect(); await b.cloud.designate('B');
    const a2 = makeDevice(g, { store: a.store }); a2.data = JSON.parse(JSON.stringify(a.data)); a2.clock.t = a.clock.t + 60000;
    await a2.cloud.resume();
    assert.strictEqual(a2.cloud.role(), 'requester');
    assert.strictEqual(a2.data.workers[0].wage, 15000, '화면에서 사라지지 않음');
    assert.strictEqual(a2.cloud.pendingRequests().length, 1);
    b.clock.t += 60000; await b.cloud.refresh();
    assert.strictEqual(b.data.workers[0].wage, 15000);
    assert.deepStrictEqual(b.data.workers[0].punch, { date: '2026-11-16', time: '09:00', at: '09:00' });
  });

  await test('4차 검증: 옛 출퇴근 기기가 모르고 [지정 해제]를 눌러도 새로 지정된 기기를 지우지 않음', async () => {
    const { g, tab, ph, sid } = await shop();
    await ph.cloud.designate('사장님 PC');
    assert.strictEqual(tab.cloud.role(), 'writer');   // 아직 모름
    assert.strictEqual(await tab.cloud.undesignate(), false);
    assert.strictEqual(g.rows(sid, '기기')[0][1], '사장님 PC');
    assert.strictEqual(tab.cloud.role(), 'requester');
  });

  await test('4차(아르곤): 출퇴근 기기가 요청을 처리했지만 저장 실패한 채 교체돼도, 그 요청을 복제해 두 번 적용하지 않음', async () => {
    const g = makeGoogle();
    const tab = makeDevice(g); tab.data.workers = [worker('김', {})]; await tab.cloud.connect(); await tab.cloud.designate('태블릿');
    const ph = makeDevice(g); await ph.cloud.connect();
    const pc = makeDevice(g); await pc.cloud.connect();
    pc.data.workers[0].wage = 12000; pc.cloud.markDirty(); await pc.cloud.saveNow();
    g.failDataWrite = 1; tab.clock.t += 31000; await tab.cloud.refresh();
    await ph.cloud.designate('점장폰'); ph.clock.t += 31000; await ph.cloud.refresh();
    assert.strictEqual(ph.data.workers[0].wage, 12000);
    ph.data.workers[0].wage = 10320; ph.cloud.markDirty(); await ph.cloud.saveNow();
    await tab.cloud.saveNow();   // 옛 기기가 밀린 저장 → 요청 기기로 전환
    ph.clock.t += 31000; await ph.cloud.refresh();
    assert.strictEqual(ph.data.workers[0].wage, 10320, '사장님이 되돌린 값 유지');
  });

  await test('4차(아르곤): 지정 중에 요청 전송이 늦게 끝나도 내 요청을 두 번 적용하지 않음', async () => {
    const g = makeGoogle();
    const orig = g.fetch; let release = null;
    const tab = makeDevice(g); tab.data.workers = [worker('김', {})]; await tab.cloud.connect(); await tab.cloud.designate('태블릿');
    const ph = makeDevice(g); await ph.cloud.connect();
    g.fetch = async (url, opt) => { if (url.includes(':append') && !release) await new Promise(r => { release = r; }); return orig(url, opt); };
    // 요청이 이미 전송 중(sent 전)인 상태에서 지정
    ph.data.workers[0].wage = 12000; ph.cloud.markDirty();
    const sending = ph.cloud.saveNow();
    await new Promise(r => setTimeout(r, 5));
    const d = ph.cloud.designate('점장폰');
    await new Promise(r => setTimeout(r, 5));
    if (release) release();
    await sending; await d;
    g.fetch = orig;
    ph.data.workers[0].wage = 10320; ph.cloud.markDirty(); await ph.cloud.saveNow();
    ph.clock.t += 31000; await ph.cloud.refresh();
    ph.clock.t += 31000; await ph.cloud.refresh();
    assert.strictEqual(ph.data.workers[0].wage, 10320);
  });

  await test('4차(아르곤): 지정이 실패하면(기기 탭 쓰기 실패) 보내지 못한 요청이 그대로 남음', async () => {
    const g = makeGoogle();
    const orig = g.fetch; let failDev = false;
    g.fetch = async (url, opt) => { if (failDev && opt && opt.method === 'PUT' && decodeURIComponent(url).includes('기기!A1:D1')) return { ok: false, status: 503, json: async () => ({}), text: async () => '' }; return orig(url, opt); };
    const tab = makeDevice(g); tab.data.workers = [worker('김', {})]; await tab.cloud.connect(); await tab.cloud.designate('태블릿');
    const ph = makeDevice(g); await ph.cloud.connect();
    g.failReqAppend = 1;
    ph.data.workers[0].wage = 12000; ph.cloud.markDirty(); await ph.cloud.saveNow();
    failDev = true;
    assert.strictEqual(await ph.cloud.designate('점장폰'), false);
    failDev = false;
    assert.strictEqual(ph.cloud.role(), 'requester');
    assert.strictEqual(ph.cloud.pendingRequests().length, 1);
    ph.clock.t += 31000; await ph.cloud.refresh();
    tab.clock.t += 31000; await tab.cloud.refresh();
    assert.strictEqual(tab.data.workers[0].wage, 12000);
  });

  await test('4차(아르곤): 거절된 요청이 있는 채로 지정이 해제돼도 그 요청이 되살아나지 않음', async () => {
    const g = makeGoogle();
    const tab = makeDevice(g); tab.data.workers = [worker('김', {})]; await tab.cloud.connect(); await tab.cloud.designate('태블릿');
    const ph = makeDevice(g); await ph.cloud.connect();
    ph.data.workers[0].wage = 12000; ph.cloud.markDirty(); await ph.cloud.saveNow();
    tab.data.workers[0].wage = 15000; tab.cloud.markDirty(); await tab.cloud.saveNow();
    tab.clock.t += 31000; await tab.cloud.refresh();   // 거절
    await tab.cloud.undesignate();
    ph.clock.t += 31000; await ph.cloud.refresh(); await ph.cloud.saveNow();
    tab.clock.t += 31000; await tab.cloud.refresh();
    assert.strictEqual(ph.data.workers[0].wage, 15000);
    assert.strictEqual(tab.data.workers[0].wage, 15000);
  });

  await test('4차(아르곤): 지정된 걸 아직 모르는 기기(30초 전)가 저장해도 데이터 탭을 쓰지 않고 요청으로', async () => {
    const g = makeGoogle();
    const tab = makeDevice(g); tab.data.workers = [worker('김', {})]; await tab.cloud.connect();
    const ph = makeDevice(g); await ph.cloud.connect();
    await tab.cloud.designate('태블릿');
    const sid = JSON.parse(tab.store['alba.cloud.v1']).sheetId;
    const before = JSON.stringify(g.rows(sid, '데이터'));
    ph.data.workers[0].wage = 99999; ph.cloud.markDirty(); await ph.cloud.saveNow();
    assert.strictEqual(JSON.stringify(g.rows(sid, '데이터')), before);
    assert.strictEqual(ph.cloud.role(), 'requester');
    tab.clock.t += 31000; await tab.cloud.refresh();
    assert.strictEqual(tab.data.workers[0].wage, 99999);
  });

  await test('4차(아르곤): 요청 처리 후 저장 실패 → 시트에서 다시 불러오기 해도 그 요청을 잃지 않음', async () => {
    const g = makeGoogle();
    const tab = makeDevice(g); tab.data.workers = [worker('김', {})]; await tab.cloud.connect(); await tab.cloud.designate('태블릿');
    const ph = makeDevice(g); await ph.cloud.connect();
    ph.data.workers[0].wage = 12000; ph.cloud.markDirty(); await ph.cloud.saveNow();
    g.failDataWrite = 1; tab.clock.t += 31000; await tab.cloud.refresh();
    await tab.cloud.loadFromSheet();
    tab.data.workers.push(worker('이', {})); tab.cloud.markDirty(); await tab.cloud.saveNow();
    tab.clock.t += 31000; await tab.cloud.refresh();
    assert.strictEqual(tab.data.workers[0].wage, 12000);
    ph.clock.t += 31000; await ph.cloud.refresh();
    assert.strictEqual(ph.cloud.pendingRequests().length, 0);
    assert.strictEqual(ph.data.workers[0].wage, 12000);
  });

  await test('4차(아르곤): 요청 기기의 [지금 저장]은 전송 실패를 성공으로 알리지 않음', async () => {
    const { g, ph } = await shop();
    g.failReqAppend = 1;
    W(ph, '김').wage = 12000; ph.cloud.markDirty();
    assert.strictEqual(await ph.cloud.saveNow(), false);
  });

  await test('4차(아르곤 2): 디바운스 중 지정 → 데이터 저장 실패 → 다른 기기로 교체돼도 그 수정이 사라지지 않음', async () => {
    const g = makeGoogle();
    const tab = makeDevice(g); tab.data.workers = [worker('김', {})]; await tab.cloud.connect(); await tab.cloud.designate('태블릿');
    const ph = makeDevice(g); await ph.cloud.connect();
    ph.data.workers[0].wage = 12000; ph.cloud.markDirty();   // 1.5초 대기 중
    g.failDataWrite = 1;
    await ph.cloud.designate('점장폰');                       // 기기 탭은 썼지만 데이터 저장 실패
    await tab.cloud.designate('태블릿');
    await ph.cloud.saveNow();
    ph.clock.t += 31000; await ph.cloud.refresh();
    tab.clock.t += 31000; await tab.cloud.refresh();
    assert.strictEqual(tab.data.workers[0].wage, 12000);
  });

  await test('4차(아르곤 2): 50줄 넘게 처리한 뒤 시트에서 옛 요청 줄을 모두 지워도 새 요청을 처리', async () => {
    const { g, tab, ph, sid, tick } = await shop();
    for (let i = 0; i < 55; i++) { W(ph, '김').wage = 10000 + i; ph.cloud.markDirty(); await ph.cloud.saveNow(); }
    await tick(tab); await tick(ph);
    assert.strictEqual(W(tab, '김').wage, 10054);
    const rows = g.rows(sid, '수정요청'); rows.splice(1, rows.length - 1);   // 머리글만 남기고 지움
    W(ph, '김').wage = 20000; ph.cloud.markDirty(); await ph.cloud.saveNow();
    await tick(tab);
    assert.strictEqual(W(tab, '김').wage, 20000);
    W(ph, '김').wage = 20001; ph.cloud.markDirty(); await ph.cloud.saveNow();
    await tick(tab);
    assert.strictEqual(W(tab, '김').wage, 20001);
  });

  await test('5차 보안: 손으로 조작한 수정요청·데이터의 __proto__/constructor 경로는 적용하지 않음 (프로토타입 오염 방지)', async () => {
    const { g, tab, ph, sid, tick } = await shop();
    g.rows(sid, '수정요청').push(['r-evil1', '2026-11-16 10:00:00', 'x', 'x', '', JSON.stringify([{ path: ['__proto__', 'polluted'], before: null, after: 'yes' }]), '', '', '']);
    g.rows(sid, '수정요청').push(['r-evil2', '2026-11-16 10:00:01', 'x', 'x', '', JSON.stringify([{ path: ['workers', { id: 'id-김' }, '__proto__', 'isAdmin'], before: null, after: true }]), '', '', '']);
    g.rows(sid, '수정요청').push(['r-evil3', '2026-11-16 10:00:02', 'x', 'x', '', JSON.stringify([{ path: ['constructor', 'prototype', 'p2'], before: null, after: 1 }]), '', '', '']);
    await tick(tab);
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(({}).isAdmin, undefined);
    assert.strictEqual(({}).p2, undefined);
    const st = g.rows(sid, '수정요청').filter(r => /^r-evil/.test(r[0])).map(r => r[6]);
    assert.deepStrictEqual(st, ['거절', '거절', '거절']);
    const m = ph.cloud.merge3({ a: 0 }, JSON.parse('{"__proto__":{"z":1},"a":1}'), { a: 2, b: 1 });
    assert.strictEqual(({}).z, undefined);
    assert.ok(Object.keys(m).indexOf('__proto__') < 0);
    // 'toString' 같은 평범한 이름의 칸은 그대로 비교·합치기·적용 (원형의 함수를 값으로 착각하지 않음)
    assert.deepStrictEqual(ph.cloud.diffOps({ s: { toString: 1 } }, { s: { toString: 2 } }), [{ path: ['s', 'toString'], before: 1, after: 2 }]);
    assert.deepStrictEqual(ph.cloud.merge3({ a: {} }, { a: { valueOf: 2 } }, { a: {} }), { a: { valueOf: 2 } });
    const t2 = ph.cloud.applyOps({ workers: [{ id: 'toString', wage: 1 }] }, [{ path: ['workers', { id: 'toString' }, 'wage'], before: 1, after: 2 }]);
    assert.strictEqual(t2.ok, true); assert.strictEqual(t2.data.workers[0].wage, 2);
  });

  await test('5차 보안: 요청ID·기기ID가 __proto__/toString 이어도 상태 칸을 제대로 쓰고 저장이 막히지 않음', async () => {
    const { g, tab, sid, tick } = await shop();
    const ranges = [];
    const orig = g.fetch;
    g.fetch = async (url, opt) => { if (opt && opt.body && /batchUpdate/.test(url)) { const b = JSON.parse(opt.body); (b.data || []).forEach(d => ranges.push(d.range)); } return orig(url, opt); };
    const kim = W(tab, '김');
    g.rows(sid, '수정요청').push(['__proto__', '2026-11-16 10:00:00', 'toString', 'x', '', JSON.stringify([{ path: ['workers', { id: kim.id }, 'wage'], before: kim.wage, after: 11000 }]), '', '', '']);
    g.rows(sid, '수정요청').push(['toString', '2026-11-16 10:00:01', '__proto__', 'x', '', JSON.stringify([{ path: ['workers', { id: kim.id }, 'wage'], before: 11000, after: 12000 }]), '', '', '']);
    await tick(tab);
    assert.ok(!ranges.some(r => /object/i.test(r)), '잘못된 범위: ' + ranges.join(','));
    const st = g.rows(sid, '수정요청').filter(r => r[0] === '__proto__' || r[0] === 'toString').map(r => r[6]);
    assert.deepStrictEqual(st, ['적용됨', '적용됨']);
    assert.strictEqual(W(tab, '김').wage, 12000);
    assert.strictEqual(JSON.parse(tab.store['alba.cloud.v1']).pendWrites.length, 0);
    W(tab, '김').wage = 12500; tab.cloud.markDirty();
    assert.strictEqual(await tab.cloud.saveNow(), true);
    assert.strictEqual(dataTab(g, sid).workers.find(w => w.name === '김').wage, 12500);
  });

  await test('5차 보안: 수정 요청으로 출퇴근 상태·출퇴근 코드는 못 바꿈 (기기 교체 때 넘기는 요청만 출퇴근 상태 허용)', async () => {
    const { g, tab, sid, tick } = await shop();
    const kim = W(tab, '김');
    const row = (id, ops, note) => g.rows(sid, '수정요청').push([id, '2026-11-16 10:00:00', 'x', 'x', note || '', JSON.stringify(ops), '', '', '']);
    row('r-p1', [{ path: ['workers', { id: kim.id }, 'punch'], before: null, after: { date: '2026-11-16', time: '09:00' } }]);
    row('r-p2', [{ path: ['workers', { id: kim.id }, 'code'], before: kim.code, after: 'ZZZZZZZZ' }]);
    row('r-p3', [{ path: ['workers', { id: kim.id }, 'lastTs'], before: null, after: '2099-01-01 00:00:00' }]);
    row('r-p4', [{ path: ['workers', { id: kim.id }], before: kim, after: Object.assign({}, kim, { code: 'ZZZZZZZZ' }) }]);
    row('r-ok', [{ path: ['workers', { id: kim.id }, 'punch'], before: null, after: { date: '2026-11-16', time: '09:00' } }], '[출퇴근 기기 교체] 근무 중 상태');
    await tick(tab);
    const st = {}; g.rows(sid, '수정요청').forEach(r => { if (/^r-/.test(r[0])) st[r[0]] = r[6]; });
    assert.deepStrictEqual(st, { 'r-p1': '거절', 'r-p2': '거절', 'r-p3': '거절', 'r-p4': '거절', 'r-ok': '적용됨' });
    assert.strictEqual(W(tab, '김').code, kim.code);
    assert.ok(!W(tab, '김').lastTs);
  });

  await test('5차 보안: 관리자 비밀번호를 바꿀 때 시트 쓰기가 실패해도 다음 저장 때 올라가 옛 비밀번호가 되살아나지 않음', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.pin = '1111';
    a.data.workers = [worker('철수', {})];
    await a.cloud.connect();
    const sid = JSON.parse(a.store['alba.cloud.v1']).sheetId;
    assert.strictEqual(g.rows(sid, '관리자')[0][1], '1111');
    const orig = g.fetch; let fail = true;
    g.fetch = async (url, opt) => { if (fail && opt && opt.method === 'PUT' && /B1/.test(decodeURIComponent(url))) { return { ok: false, status: 503, json: async () => ({}), text: async () => '' }; } return orig(url, opt); };
    a.pin = '9999';
    await a.cloud.setAdminPin('9999');
    fail = false;
    if (a.cloud.pinPending()) { a.data.workers[0].wage = 11111; a.cloud.markDirty(); await a.cloud.saveNow(); }
    assert.strictEqual(g.rows(sid, '관리자')[0][1], '9999');
    assert.strictEqual(a.cloud.pinPending(), false);
    // 시트 쓰기와 그 뒤 저장까지 실패 → 기억해 두었다가 다음 저장 때
    fail = true; g.failDataWrite = 9;
    await a.cloud.setAdminPin('7777');
    assert.strictEqual(a.cloud.pinPending(), true);
    assert.strictEqual(g.rows(sid, '관리자')[0][1], '9999');
    g.failDataWrite = 0; fail = false;
    await a.cloud.saveNow();
    assert.strictEqual(g.rows(sid, '관리자')[0][1], '7777');
    assert.strictEqual(a.cloud.pinPending(), false);
  });

  await test('6차: 보건증·손님 계좌도 수정 요청으로 출퇴근 기기에 반영됨', async () => {
    const { g, tab, sid, tick } = await shop();
    tab.data.settings = { minWage: 10320, bank: null }; tab.cloud.markDirty(); await tab.cloud.saveNow();   // 앱은 설정을 항상 가짐
    const kim = W(tab, '김');
    const row = (id, ops) => g.rows(sid, '수정요청').push([id, '2026-11-17 10:00:00', 'x', 'x', '', JSON.stringify(ops), '', '', '']);
    row('r-h1', [{ path: ['workers', { id: kim.id }, 'health'], before: null, after: { exam: '2026-11-10', expire: '2027-11-09' } }]);
    row('r-b1', [{ path: ['settings', 'bank'], before: null, after: { bank: '국민은행', number: '123456-78-901234', holder: '홍길동' } }]);
    await tick(tab);
    const st = {}; g.rows(sid, '수정요청').forEach(r => { if (/^r-/.test(r[0])) st[r[0]] = r[6]; });
    assert.deepStrictEqual(st, { 'r-h1': '적용됨', 'r-b1': '적용됨' });
    assert.deepStrictEqual(W(tab, '김').health, { exam: '2026-11-10', expire: '2027-11-09' });
    const d = dataTab(g, sid);
    assert.deepStrictEqual(d.workers.find(w => w.name === '김').health, { exam: '2026-11-10', expire: '2027-11-09' });
    assert.strictEqual(d.settings.bank.number, '123456-78-901234');
  });

  await test('8차: 손님 계좌·보건증은 하위 칸을 섞지 않고 통째로 합치기·비교 (섞인 계좌 방지)', async () => {
    const C = (await shop()).ph.cloud;
    const b = { settings: { bank: { bank: '국민', number: '11111111', holder: '가' } } };
    const l = { settings: { bank: { bank: '신한', number: '11111111', holder: '가' } } };
    const r = { settings: { bank: { bank: '국민', number: '22222222', holder: '나' } } };
    const m = C.merge3(b, l, r);
    assert.ok(m.settings.bank.bank === '신한' && m.settings.bank.number === '11111111' && m.settings.bank.holder === '가', JSON.stringify(m.settings.bank));
    const ops = C.diffOps(b, r);
    assert.strictEqual(ops.length, 1);
    assert.deepStrictEqual(ops[0].path, ['settings', 'bank']);
    const wb = { workers: [{ id: 'w', health: { exam: '2026-01-01', expire: '2026-12-31' } }] };
    const wc = { workers: [{ id: 'w', health: { exam: '2026-02-01', expire: '2027-01-31' } }] };
    const ho = C.diffOps(wb, wc);
    assert.strictEqual(ho.length, 1);
    assert.strictEqual(ho[0].path[2], 'health');
  });

  await test('3차 단일 저장: 지정 전에는 예전처럼 모든 기기가 저장(합치기)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g); a.data.workers = [worker('김', {})]; await a.cloud.connect();
    const b = makeDevice(g); await b.cloud.connect();
    assert.strictEqual(a.cloud.role(), 'none'); assert.strictEqual(b.cloud.role(), 'none');
    b.data.workers.push(worker('이', {})); b.cloud.markDirty(); b.clock.t += 60000; await b.cloud.saveNow();
    a.clock.t += 60000; await a.cloud.refresh();
    assert.deepStrictEqual(a.data.workers.map(w => w.name), ['김', '이']);
  });

  await test('3차 단일 저장: 기록이 있는 새 기기가 연동해도 출퇴근 기기가 정해져 있으면 시트를 덮어쓰지 않음', async () => {
    const { g, sid } = await shop();
    const pc = makeDevice(g);
    pc.data.workers = [worker('엉뚱', {})];
    pc.confirmAnswer = false;   // 예전 방식이면 '이 기기 기록으로' 덮어썼을 것
    await pc.cloud.connect();
    assert.strictEqual(pc.cloud.role(), 'requester');
    assert.deepStrictEqual(dataTab(g, sid).workers.map(w => w.name), ['김', '이']);
    assert.deepStrictEqual(pc.data.workers.map(w => w.name), ['김', '이']);
  });

  await test('2차 검토: 장부 읽기가 잠깐 실패해도 다음 새로 받기 때 다시 재생', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', {})];
    await a.cloud.connect();
    const b = makeDevice(g);
    await b.cloud.connect();
    a.data.workers.push(worker('영희', {})); a.cloud.markDirty(); a.clock.t += 60000; await a.cloud.saveNow();
    b.replayed = null; g.failPunchGet = 1; b.clock.t += 60000;
    assert.strictEqual(await b.cloud.refresh(), true);
    assert.strictEqual(b.replayed, null);   // 이번엔 실패
    b.clock.t += 30000;
    await b.cloud.refresh();
    assert.ok(b.replayed && Array.isArray(b.replayed.rows), '다음 새로 받기에서 재생');
    b.replayed = null; b.clock.t += 30000;
    await b.cloud.refresh();
    assert.strictEqual(b.replayed, null);   // 성공한 뒤엔 다시 안 읽음
  });

  await test('2차 검토: 장부 재생이 실패한 채로 저장하면 저장 전에 먼저 재생 (빠진 출퇴근이 새 저장에 묻히지 않게)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', {})];
    await a.cloud.connect();
    const b = makeDevice(g);
    await b.cloud.connect();
    a.data.workers.push(worker('영희', {})); a.cloud.markDirty(); a.clock.t += 60000; await a.cloud.saveNow();
    g.failPunchGet = 1; b.clock.t += 60000;
    await b.cloud.refresh();
    assert.ok(JSON.parse(b.store['alba.cloud.v1']).replayStamp, '실패를 기억 (앱을 껐다 켜도)');
    const order = [];
    b.replayed = null;
    const orig = g.fetch;
    g.fetch = async (url, opt) => { if (/데이터|%EB%8D%B0/.test(url) && opt && opt.method === 'POST') order.push('write'); if (/!A2:G$/.test(decodeURIComponent(url))) order.push('replay'); return orig(url, opt); };
    b.data.workers.push(worker('민수', {})); b.cloud.markDirty(); b.clock.t += 10000; await b.cloud.saveNow();
    g.fetch = orig;
    assert.ok(b.replayed, '저장 전에 재생');
    assert.ok(order.indexOf('replay') >= 0 && order.indexOf('replay') < Math.max(0, order.indexOf('write')) || order.indexOf('write') < 0, order.join(','));
    assert.ok(!JSON.parse(b.store['alba.cloud.v1']).replayStamp, '성공하면 지움');
  });

  await test('새로 받기는 저장 표시만 먼저 읽고, 바뀌었을 때만 전체를 읽음 · 예전 형식 저장 표시도 그대로 동작', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', {})];
    await a.cloud.connect();
    const b = makeDevice(g);
    await b.cloud.connect();
    const f0 = g.fullReads || 0, s0 = g.headReads || 0;
    for (let i = 0; i < 5; i++) { b.clock.t += 30000; assert.strictEqual(await b.cloud.refresh(), false); }
    assert.strictEqual(g.fullReads || 0, f0);
    assert.strictEqual((g.headReads || 0) - s0, 5);   // 30초마다 저장 표시(+기기 탭) 한 번만 읽음
    // 예전 형식(계보 없는 저장 표시)으로 저장된 시트
    const sid = JSON.parse(a.store['alba.cloud.v1']).sheetId;
    const rows = g.rows(sid, '데이터');
    rows[1] = ['2026-11-12T03:00:00.000Z'];
    a.clock.t += 60000; b.clock.t += 60000;
    assert.strictEqual(await b.cloud.refresh(), true);
    b.data.workers.push(worker('영희', {})); b.cloud.markDirty(); await b.cloud.saveNow();
    const after = g.rows(sid, '데이터')[1][0].split('|');
    assert.strictEqual(after[1], '2026-11-12T03:00:00.000Z');   // 새 저장은 예전 표시를 계보로 이어 받음
    assert.strictEqual(await a.cloud.refresh(), true);
    assert.deepStrictEqual(a.data.workers.map(w => w.name), ['철수', '영희']);
  });

  await test('30초 새로 받기: 다른 기기 변경을 받아 옴, 저장 안 된 변경이 있거나 입력 중이면 덮어쓰지 않음', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', {})];
    await a.cloud.connect();
    const b = makeDevice(g);
    await b.cloud.connect();
    a.clock.t += 60000; b.clock.t += 60000;
    a.data.workers[0].punch = { date: '2026-11-16', time: '09:00' }; a.cloud.markDirty(); await a.cloud.saveNow();
    b.busy = true;
    b.cloud.init && null;
    // 입력 중(isBusy)이면 미룸
    const hostBusy = b.cloud;   // isBusy 는 host 에서 읽음: init 다시 해서 흉내
    b.cloud.init({ getAdminPin: () => '', getData: () => JSON.parse(JSON.stringify(b.data)), getTables: () => tablesFor(b.data),
      applyData: d => { b.data = JSON.parse(JSON.stringify(d)); }, replayPunchLog: () => {}, confirm: () => true,
      onStatus: s => { b.lastStatus = s; }, isBusy: () => b.busy });
    assert.strictEqual(await b.cloud.refresh(), false);
    assert.strictEqual(b.data.workers[0].punch, undefined);
    b.busy = false;
    // 저장 안 된 변경이 있으면 받아오지 않고 저장(합치기)으로
    b.data.workers.push(worker('영희', {})); b.cloud.markDirty();
    assert.strictEqual(await b.cloud.refresh(), false);
    await b.cloud.saveNow();
    assert.deepStrictEqual(b.data.workers.map(w => w.name), ['철수', '영희']);
    assert.deepStrictEqual(b.data.workers[0].punch, { date: '2026-11-16', time: '09:00' });
    // 토큰이 만료됐으면 조용히 건너뜀 (팝업 시도 없음)
    const t0 = b.tokens;
    b.clock.t += 2 * 3600000;
    assert.strictEqual(await b.cloud.refresh(), false);
    assert.strictEqual(b.tokens, t0);
  });

  await test('화면을 누를 때 토큰이 곧 만료되거나 풀렸으면 조용히 갱신하고, 밀린 변경을 저장', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', {})];
    await a.cloud.connect();
    const t0 = a.tokens;
    assert.strictEqual(await a.cloud.renewOnGesture(), false);          // 아직 넉넉하면 아무것도 안 함
    a.clock.t += 52 * 60000;                                            // 만료 8분 전
    assert.strictEqual(await a.cloud.renewOnGesture(), true);
    assert.strictEqual(a.tokens, t0 + 1);
    a.clock.t += 5000;
    assert.strictEqual(await a.cloud.renewOnGesture(), false);          // 방금 갱신했으니 그대로
    // 타이머 갱신이 막혀 로그인이 풀린 상태(needLogin)에서 바꾼 내용이 있음
    a.clock.t += 2 * 3600000;
    a.tokenFail = true;
    a.data.workers.push(worker('영희', {}));
    a.cloud.markDirty();
    await a.cloud.saveNow().catch(() => {});
    assert.strictEqual(a.lastStatus.kind !== 'saved', true);
    assert.strictEqual(JSON.parse(a.store['alba.cloud.v1']).dirty, true);
    // 누를 때 갱신도 실패하면 그대로 '다시 연결' 상태, 변경은 보관
    a.clock.t += 30000;
    assert.strictEqual(await a.cloud.renewOnGesture(), false);
    assert.strictEqual(a.lastStatus.kind, 'needLogin');
    assert.strictEqual(JSON.parse(a.store['alba.cloud.v1']).dirty, true);
    // 구글 세션이 살아 있으면 다음 터치에 복구 + 저장
    a.tokenFail = false;
    a.clock.t += 5000;
    assert.strictEqual(await a.cloud.renewOnGesture(), false);          // 20초 안에는 다시 시도 안 함
    a.clock.t += 20000;
    assert.strictEqual(await a.cloud.renewOnGesture(), true);
    assert.strictEqual(a.lastStatus.kind, 'saved');
    assert.strictEqual(JSON.parse(a.store['alba.cloud.v1']).dirty, false);
    const saved = JSON.parse(g.rows(JSON.parse(a.store['alba.cloud.v1']).sheetId, '데이터').slice(2).map(r => r[0]).join(''));
    assert.deepStrictEqual(saved.workers.map(w => w.name), ['철수', '영희']);
    // 연동 안 했으면 아무것도 안 함
    const b = makeDevice(makeGoogle());
    assert.strictEqual(await b.cloud.renewOnGesture(), false);
    assert.strictEqual(b.tokens, 0);
  });

  await test('앱에서 알바생을 지우면 시트 출퇴근기록 장부에서도 그 사람 줄이 지워짐 (전체 삭제는 전부)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', {})];
    await a.cloud.connect();
    await a.cloud.appendPunch([['2026-11-12 09:00:00', 'C1', '철수', '출근', '이름+비밀번호', '정상', ''], ['2026-11-12 10:00:00', 'C2', '영희', '출근', '이름+비밀번호', '정상', '']]);
    assert.strictEqual(g.rows('sheet1', '출퇴근기록').length, 3);
    assert.strictEqual(await a.cloud.purgePunchLog(['C1']), true);
    const rows = g.rows('sheet1', '출퇴근기록');
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[1][1], 'C2');
    assert.ok(rows[0][0].indexOf('기록시각') === 0);        // 머리글은 그대로
    await a.cloud.purgePunchLog(null);
    assert.strictEqual(g.rows('sheet1', '출퇴근기록').length, 1);
    // 나중에 다시 시도하는 삭제(기준 시각 있음)는 그 뒤에 새로 찍힌 줄을 지우지 않음
    await a.cloud.appendPunch([['2026-11-12 09:00:00', 'C1', '철수', '출근', '이름+비밀번호', '정상', ''], ['2026-11-12 11:00:00', 'C1', '철수', '출근', '이름+비밀번호', '정상', ''], ['2026-11-12 11:30:00', 'C2', '영희', '출근', '이름+비밀번호', '정상', '']]);
    assert.strictEqual(await a.cloud.purgePunchLog(['C1'], '2026-11-12 10:00:00'), true);
    assert.deepStrictEqual(g.rows('sheet1', '출퇴근기록').slice(1).map(r => r[0] + r[1]), ['2026-11-12 11:00:00C1', '2026-11-12 11:30:00C2']);
    assert.strictEqual(await a.cloud.purgePunchLog(null, '2026-11-12 11:15:00'), true);
    assert.deepStrictEqual(g.rows('sheet1', '출퇴근기록').slice(1).map(r => r[1]), ['C2']);
  });

  await test('구글 토큰은 새로고침해도 유효한 동안 재사용(다시 로그인 안 함), 연동을 끊으면 지움', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.workers = [worker('철수', {})];
    await a.cloud.connect();
    assert.ok(a.store['alba.cloud.tok']);
    const b = makeDevice(g, { store: a.store });             // 같은 기기에서 새로고침
    const before = b.tokens;
    b.tokenFail = true;                                      // 새 토큰을 받으려 하면 실패하게 해 둠
    await b.cloud.resume();
    assert.strictEqual(b.lastStatus.kind, 'saved');           // 저장된 토큰으로 조용히 성공
    assert.strictEqual(b.tokens, before);
    a.cloud.disconnect();
    assert.strictEqual(a.store['alba.cloud.tok'], undefined);
  });

  console.log('\n총 ' + passed + '개 구글 연동 테스트 통과!');
})();
