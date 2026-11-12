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
        JSON.parse(opt.body).ranges.forEach(r => { const t = tab(r); if (!t) throw new Error('없는 탭 clear: ' + r); t.rows = []; });
        return res(200, {});
      }
      if (rest === '/values:batchUpdate') {
        JSON.parse(opt.body).data.forEach(d => {
          const name = d.range.split('!')[0];
          const t = tab(name);
          if (!t) throw new Error('없는 탭 쓰기: ' + name);
          d.values.forEach((row, k) => { t.rows[k] = row; });   // 시작 칸부터 덮어씀 (아래 줄은 그대로)
          g.writes.push(name);
        });
        return res(200, {});
      }
      const hm = /^\/values\/(.+)!A1:Z1$/.exec(rest);
      if (hm) { const t = tab(hm[1]); return res(200, t && t.rows[0] ? { values: [t.rows[0]] } : {}); }
      const vm = /^\/values\/(.+)!A1:A300$/.exec(rest);
      if (vm) { const t = tab(vm[1]); return res(200, { values: t ? t.rows : [] }); }
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
    fetch: google.fetch,
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
    getData: () => JSON.parse(JSON.stringify(dev.data)),
    getTables: () => tablesFor(dev.data),
    applyData: d => { dev.data = JSON.parse(JSON.stringify(d)); },
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

  console.log('\n총 ' + passed + '개 구글 연동 테스트 통과!');
})();
