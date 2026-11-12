/* tests/test_cloud.js — 구글 시트 연동 로직(web/gsync.js) 테스트: 가짜 구글 서버로 검증 */
'use strict';
const assert = require('assert');
const create = require('../web/gsync.js');

let passed = 0;
async function test(name, fn) {
  try { await fn(); console.log('  ✓ ' + name); passed++; }
  catch (e) { console.error('  ✗ ' + name + '\n    ' + (e && e.stack || e)); process.exit(1); }
}

/* ---- 가짜 구글 드라이브/시트 ---- */
function makeGoogle() {
  const g = { files: {}, next: 1, fail401Once: false, calls: [] };
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
      g.files[id] = { title: body.properties.title, tabs: {} };
      body.sheets.forEach(s => { g.files[id].tabs[s.properties.title] = []; });
      return res(200, { spreadsheetId: id, sheets: body.sheets.map((s, i) => ({ properties: { title: s.properties.title, sheetId: i } })) });
    }
    const m = /^\/v4\/spreadsheets\/([^/:]+)(.*)$/.exec(u.pathname);
    if (m) {
      const f = g.files[m[1]];
      if (!f || f.deleted) return res(404, {});
      const rest = decodeURIComponent(m[2]);
      if (rest === ':batchUpdate') return res(200, {});
      if (rest === '/values:batchClear') {
        JSON.parse(opt.body).ranges.forEach(r => { f.tabs[r] = []; });
        return res(200, {});
      }
      if (rest === '/values:batchUpdate') {
        JSON.parse(opt.body).data.forEach(d => { f.tabs[d.range.split('!')[0]] = d.values; });
        return res(200, {});
      }
      const vm = /^\/values\/(.+)!A1:A300$/.exec(rest);
      if (vm) return res(200, { values: f.tabs[vm[1]] || [] });
    }
    return res(404, {});
  };
  return g;
}
function res(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

/* ---- 가짜 기기(브라우저 저장소 + 앱 데이터) ---- */
function makeDevice(google, opts) {
  opts = opts || {};
  const store = opts.store || {};
  const timers = [];
  const dev = { data: { roster: [], archive: [], presets: [], store: {} }, tokenFail: false, tokens: 0, confirmAnswer: true, statuses: [] };
  const clock = { t: 1000000 };
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
    getTables: () => ({
      roster: dev.data.roster.length ? [['이름']].concat(dev.data.roster.map(r => [r.name])) : [],
      archive: []
    }),
    applyData: d => { dev.data = JSON.parse(JSON.stringify(d)); },
    confirm: () => dev.confirmAnswer,
    onStatus: s => dev.statuses.push(s.kind)
  });
  return dev;
}

(async () => {
  console.log('=== [4] 구글 시트 연동 로직 테스트 (가짜 구글 서버) ===');

  await test('처음 연동: 시트 자동 생성 + 이 기기 기록 저장 + 표/데이터 탭 기록', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '철수' }, { name: '영희' }];
    assert.strictEqual(await a.cloud.connect(), true);
    assert.strictEqual(Object.keys(g.files).length, 1);
    const f = g.files.sheet1;
    assert.strictEqual(f.title, '사장님 도우미 데이터');
    assert.deepStrictEqual(f.tabs['정산 명단'], [['이름'], ['철수'], ['영희']]);
    assert.ok(f.tabs['데이터'].length >= 3);
    assert.ok(a.cloud.isConnected());
    assert.ok(/docs\.google\.com\/spreadsheets\/d\/sheet1/.test(a.cloud.sheetUrl()));
  });

  await test('다른 기기에서 같은 계정으로 연동하면 저장된 기록을 불러옴 (시트는 새로 만들지 않음)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '철수' }];
    a.data.store = { store: '행복분식', inspector: '김사장' };
    await a.cloud.connect();
    const b = makeDevice(g);
    assert.strictEqual(await b.cloud.connect(), true);
    assert.strictEqual(Object.keys(g.files).length, 1);
    assert.deepStrictEqual(b.data.roster, [{ name: '철수' }]);
    assert.strictEqual(b.data.store.store, '행복분식');
  });

  await test('변경 후 저장 → 다른 기기를 열면 최신 내용을 받아 옴', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '철수' }];
    await a.cloud.connect();
    const b = makeDevice(g);
    await b.cloud.connect();
    a.clockTick = a.clock.t += 60000;
    a.data.roster.push({ name: '민수' });
    a.cloud.markDirty();
    assert.strictEqual(await a.cloud.saveNow(), true);
    b.clock.t += 120000;
    await b.cloud.resume();
    assert.strictEqual(b.data.roster.length, 2);
  });

  await test('양쪽에 기록이 다르면 확인창: [확인]=시트 우선, [취소]=이 기기 우선', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '시트쪽' }];
    await a.cloud.connect();
    const b = makeDevice(g);
    b.data.roster = [{ name: '기기쪽' }];
    b.confirmAnswer = true;
    await b.cloud.connect();
    assert.strictEqual(b.data.roster[0].name, '시트쪽');

    const c = makeDevice(g);
    c.data.roster = [{ name: '기기쪽' }];
    c.confirmAnswer = false;
    await c.cloud.connect();
    assert.strictEqual(c.data.roster[0].name, '기기쪽');
    const d = makeDevice(g);
    await d.cloud.connect();
    assert.strictEqual(d.data.roster[0].name, '기기쪽');
  });

  await test('저장 중 401(열쇠 만료)이 나면 새 열쇠로 한 번 다시 시도', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '철수' }];
    await a.cloud.connect();
    a.data.roster.push({ name: '영희' });
    a.cloud.markDirty();
    g.fail401Once = true;
    assert.strictEqual(await a.cloud.saveNow(), true);
    assert.strictEqual(g.files.sheet1.tabs['정산 명단'].length, 3);
  });

  await test('자동 저장이 로그인 문제로 실패하면 "다시 연결" 상태가 되고, 변경 내용은 보관', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '철수' }];
    await a.cloud.connect();
    a.data.roster.push({ name: '영희' });
    a.cloud.markDirty();
    a.dev = 1;
    // 열쇠 만료 + 조용한 갱신 실패
    a.clock.t += 2 * 3600 * 1000;
    a.tokenFail = true;
    // saveNow 는 사용자 버튼(user 모드) → 실패해도 error, silent 경로는 timer 에서 쓰므로 직접 확인
    const ok = await a.cloud.saveNow();
    assert.strictEqual(ok, false);
    assert.ok(['error', 'needLogin'].includes(a.cloud.getStatus().kind));
    assert.ok(JSON.parse(a.store['alba.cloud.v1']).dirty);
    // 다시 연결하면 저장됨
    a.tokenFail = false;
    assert.strictEqual(await a.cloud.saveNow(), true);
    assert.strictEqual(g.files.sheet1.tabs['정산 명단'].length, 3);
    assert.strictEqual(JSON.parse(a.store['alba.cloud.v1']).dirty, false);
  });

  await test('앱을 다시 열 때 저장 안 된 변경이 있으면 시트 내용으로 덮어쓰지 않고 먼저 저장', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '철수' }];
    await a.cloud.connect();
    a.data.roster.push({ name: '오프라인에서 추가' });
    a.cloud.markDirty();
    // 새로고침 시뮬레이션: 같은 저장소, 새 객체
    assert.ok(a.timers.length >= 1); // 3초 뒤 자동 저장 예약됨 (아직 실행 전에 앱이 닫힌 상황)
    const b = makeDevice(g, { store: a.store });
    b.data = JSON.parse(JSON.stringify(a.data));
    await b.cloud.resume();
    assert.strictEqual(g.files.sheet1.tabs['정산 명단'].length, 3);
  });

  await test('구글 드라이브에서 시트를 지워도 다음 저장 때 새로 만들어 이어서 저장', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '철수' }];
    await a.cloud.connect();
    g.files.sheet1.deleted = true;
    a.data.roster.push({ name: '영희' });
    a.cloud.markDirty();
    assert.strictEqual(await a.cloud.saveNow(), true);
    assert.ok(g.files.sheet2);
    assert.strictEqual(g.files.sheet2.tabs['정산 명단'].length, 3);
  });

  await test('내용을 바꾸면 3초 뒤 자동 저장이 실행됨 (같은 내용이면 저장하지 않음)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '철수' }];
    await a.cloud.connect();
    const n0 = a.timers.length;
    a.cloud.markDirty();                         // 변경 없음 → 예약 없음
    assert.strictEqual(a.timers.length, n0);
    a.data.roster.push({ name: '영희' });
    a.cloud.markDirty();
    assert.strictEqual(a.timers.length, n0 + 1);
    assert.strictEqual(a.timers[n0].ms, 3000);
    await a.timers[n0].f();
    await new Promise(r => setTimeout(r, 20));
    assert.strictEqual(g.files.sheet1.tabs['정산 명단'].length, 3);
  });

  await test('연동 끊기: 열쇠 폐기 + 연동 정보 삭제 (구글 파일은 그대로)', async () => {
    const g = makeGoogle();
    const a = makeDevice(g);
    a.data.roster = [{ name: '철수' }];
    await a.cloud.connect();
    a.cloud.disconnect();
    assert.strictEqual(a.revoked, true);
    assert.strictEqual(a.cloud.isConnected(), false);
    assert.strictEqual(a.store['alba.cloud.v1'], undefined);
    assert.ok(g.files.sheet1);
    a.data.roster.push({ name: '영희' });
    a.cloud.markDirty(); // 연동 끊긴 뒤에는 아무것도 보내지 않음
    const before = g.calls.length;
    assert.strictEqual(await a.cloud.saveNow(), false);
    assert.strictEqual(g.calls.length, before);
  });

  console.log('\n총 ' + passed + '개 구글 연동 테스트 통과!');
})();
