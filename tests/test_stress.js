/* tests/test_stress.js — 저장·동기화 무작위 반복 검증 (가짜 구글 서버)
 *
 * 로그인 풀림·오프라인·새로고침·토큰 만료·동시 전송 같은 사고를 무작위로 섞어 여러 번 돌리고,
 * 어떤 순서로 일이 벌어져도 아래가 지켜지는지 본다.
 *   1) 이 기기에서 바꾼 내용은 끝내 시트에 그대로 저장된다 (사라지지 않음)
 *   2) 출퇴근 기록 줄은 시트에 빠짐없이, 중복 없이, 찍은 순서대로 쌓인다
 *   3) 두 기기가 번갈아 쓰면 마지막에 두 기기와 시트가 같은 내용이고 두 기기의 입력이 모두 남는다
 * 실행: node tests/test_stress.js [반복횟수=10]
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

// test_cloud.js 의 가짜 구글/가짜 기기 도구를 그대로 가져다 씀 (본문 테스트는 실행하지 않음)
const src = fs.readFileSync(path.join(__dirname, 'test_cloud.js'), 'utf8');
const cut = src.indexOf("(async () => {\n  console.log('=== [4]");
if (cut < 0) throw new Error('test_cloud.js 구조가 바뀌어 도구를 못 가져옴');
const H = new Function('require', 'process', 'console',
  src.slice(0, cut) + '\nreturn { makeGoogle, makeDevice, worker, tablesFor };')(
  createRequire(path.join(__dirname, 'x.js')), process, console);

const ROUNDS = Math.max(1, Number(process.argv[2]) || 10);

function rng(seed) {   // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const sheetData = (g, id) => JSON.parse(g.rows(id, '데이터').slice(2).map(r => r[0]).join(''));
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 앱(web/app.js)의 출퇴근 보관함과 같은 규칙: 보낸 만큼만 지우고, 보내는 동안 쌓인 건 남김 */
function makeQueue(dev) {
  const KEY = 'alba.punchQueue';
  const load = () => { try { return JSON.parse(dev.store[KEY] || '[]'); } catch (e) { return []; } };
  const save = q => { dev.store[KEY] = JSON.stringify(q); };
  const st = { busy: false };
  const flush = () => {
    if (st.busy || !dev.cloud.isConnected()) return Promise.resolve();
    const q = load();
    if (!q.length) return Promise.resolve();
    st.busy = true;
    return dev.cloud.appendPunch(q).then(() => { save(load().slice(q.length)); }).catch(() => {}).then(() => { st.busy = false; });
  };
  return { load, flush, push: row => { const q = load(); q.push(row); save(q); return flush(); } };
}

let scenarios = 0;
async function scenarioSingle(seed) {
  const R = rng(seed);
  const g = H.makeGoogle();
  let dev = H.makeDevice(g);
  dev.data.workers = [H.worker('기본', { '2026-11': { net: 1 } })];
  await dev.cloud.connect();
  let queue = makeQueue(dev);
  let seq = 0, wn = 0;
  const pending = [];
  const reopen = () => {   // 새로고침: 같은 기기 저장소, 앱 데이터는 그대로 이어짐
    const keep = JSON.parse(JSON.stringify(dev.data));
    const fail = dev.tokenFail, clock = dev.clock.t;
    dev = H.makeDevice(g, { store: dev.store });
    dev.data = keep; dev.tokenFail = fail; dev.clock.t = clock;
    queue = makeQueue(dev);
  };
  for (let step = 0; step < 260; step++) {
    const r = R();
    if (r < 0.22) {                                   // 내용 수정
      if (R() < 0.5) dev.data.workers.push(H.worker('w' + (++wn), { '2026-11': { net: Math.floor(R() * 1000) } }));
      else { const w = dev.data.workers[Math.floor(R() * dev.data.workers.length)]; w.months['2026-1' + (Math.floor(R() * 2))] = { net: Math.floor(R() * 1000) }; }
      dev.cloud.markDirty();
    } else if (r < 0.40) {                            // 출퇴근 한 줄 (보내는 중에도 쌓일 수 있음)
      const row = ['2026-11-12 09:00:' + String(seq % 60).padStart(2, '0'), 'C' + seq, 'n', seq % 2 ? '퇴근' : '출근', '이름+비밀번호', '정상', 's' + seq];
      seq++;
      pending.push(queue.push(row));
    } else if (r < 0.55) {                            // 자동 저장 시간이 됨
      const t = dev.timers.splice(0, dev.timers.length);
      for (const x of t) pending.push(Promise.resolve(x.f()).catch(() => {}));
    } else if (r < 0.65) {                            // 로그인 풀림 ↔ 복구
      dev.tokenFail = !dev.tokenFail;
    } else if (r < 0.72) {                            // 토큰 만료 시간 지남
      dev.clock.t += 2 * 3600 * 1000;
    } else if (r < 0.78) {                            // 다음 요청 한 번 401
      g.fail401Once = true;
    } else if (r < 0.86) {                            // 새로고침 (밀린 일은 마무리된 뒤)
      await Promise.all(pending.splice(0));
      reopen();
      await dev.cloud.resume().catch(() => {});
    } else if (r < 0.93) {
      await dev.cloud.saveNow().catch(() => {});
    } else {
      await sleep(0);
    }
  }
  await Promise.all(pending.splice(0));
  // 모두 복구된 뒤 마무리: 로그인 정상, 저장 끝까지, 보관함 비우기
  g.fail401Once = false; dev.tokenFail = false;
  await dev.cloud.resume().catch(() => {});
  for (let i = 0; i < 4; i++) { await dev.cloud.saveNow(); await queue.flush(); }

  const sid = JSON.parse(dev.store['alba.cloud.v1']).sheetId;
  assert.strictEqual(JSON.parse(dev.store['alba.cloud.v1']).dirty, false, '시드 ' + seed + ': 저장 대기 표시가 남음');
  assert.deepStrictEqual(sheetData(g, sid), JSON.parse(JSON.stringify(dev.data)), '시드 ' + seed + ': 시트와 기기 내용이 다름');
  assert.strictEqual(queue.load().length, 0, '시드 ' + seed + ': 보관함에 안 보낸 기록이 남음');
  const rows = (g.rows(sid, '출퇴근기록') || []).slice(1).map(x => x[6]);
  assert.deepStrictEqual(rows, Array.from({ length: seq }, (_, i) => 's' + i), '시드 ' + seed + ': 출퇴근 줄이 빠지거나 겹치거나 순서가 바뀜 (찍은 ' + seq + '건, 시트 ' + rows.length + '건)');
  scenarios++;
}

async function scenarioTwo(seed, skewMs) {
  const R = rng(seed * 7919 + 13);
  const g = H.makeGoogle();
  const a = H.makeDevice(g);
  a.data.workers = [H.worker('기본', { '2026-11': { net: 1 } })];
  await a.cloud.connect();
  const b = H.makeDevice(g);
  await b.cloud.connect();   // 같은 계정: 시트에서 불러옴
  assert.strictEqual(b.data.workers.length, 1, '시드 ' + seed + ': 둘째 기기가 기록을 못 불러옴');
  a.clock.t += 1000; b.clock.t += 1000;   // 저장 시각이 같은 밀리초로 겹치는 일은 현실에 없으므로 가짜 시계를 조금 앞으로
  const devs = [a, b];
  const added = ['id-기본'];
  for (let i = 0; i < 40; i++) {
    const d = devs[Math.floor(R() * 2)];
    const now = Math.max(a.clock.t, b.clock.t);     // 두 기기 시계는 같다고 보고 (어긋난 경우는 skewMs 로 따로 시험)
    a.clock.t = now; b.clock.t = now + (skewMs || 0);
    await d.cloud.resume().catch(() => {});                 // 먼저 최신 내용을 받음
    if (R() < 0.5) {                                        // 새 알바생 추가
      const w = H.worker('x' + i, { '2026-11': { net: i } });
      d.data.workers.push(w); added.push(w.id);
    } else {                                                // 기존 기록 수정
      const w = d.data.workers[Math.floor(R() * d.data.workers.length)];
      w.months['2026-11'] = { net: Math.floor(R() * 9999) };
    }
    d.cloud.markDirty();
    if (R() < 0.3) { d.tokenFail = true; a.clock.t += 2 * 3600 * 1000; b.clock.t += 2 * 3600 * 1000; await d.cloud.saveNow().catch(() => {}); d.tokenFail = false; }   // 저장 실패 → 보관
    if (R() < 0.15) g.fail401Once = true;
    await d.cloud.saveNow().catch(() => {});
    if (R() < 0.2) { a.clock.t += 2 * 3600 * 1000; b.clock.t += 2 * 3600 * 1000; }
    // 한 기기가 저장을 끝낸 뒤에 다른 기기가 시작하도록 (같은 순간 동시 편집은 앱 규칙상 '이 기기 우선')
    for (let k = 0; k < 2; k++) { await d.cloud.saveNow().catch(() => {}); }
    assert.strictEqual(JSON.parse(d.store['alba.cloud.v1']).dirty, false, '시드 ' + seed + ' 단계 ' + i + ': 저장이 안 끝남');
    // 저장 시각(stamp)이 ms 단위로 겹치면 새 것을 못 알아보므로 가짜 시계를 조금씩 앞으로
    a.clock.t += 1000; b.clock.t += 1000;
  }
  await a.cloud.resume(); await b.cloud.resume(); await a.cloud.resume();
  const sid = JSON.parse(a.store['alba.cloud.v1']).sheetId;
  const remote = sheetData(g, sid);
  assert.deepStrictEqual(a.data, b.data, '시드 ' + seed + ': 두 기기 내용이 다름');
  assert.deepStrictEqual(remote, JSON.parse(JSON.stringify(a.data)), '시드 ' + seed + ': 시트와 기기 내용이 다름');
  added.forEach(id => assert.ok(a.data.workers.some(w => w.id === id), '시드 ' + seed + ': 알바생 ' + id + ' 가 사라짐'));
  scenarios++;
}

(async () => {
  console.log('=== [5] 저장·동기화 무작위 반복 검증 (' + ROUNDS + '회 × 2종) ===');
  for (let i = 1; i <= ROUNDS; i++) {
    try {
      await scenarioSingle(i);
      await scenarioTwo(i);
      if (process.env.SKEW) await scenarioTwo(i, Number(process.env.SKEW));
      console.log('  ✓ ' + i + '회차 통과 (한 기기: 로그인 풀림·오프라인·새로고침 / 두 기기 번갈아 저장)');
    } catch (e) {
      console.error('  ✗ ' + i + '회차 실패\n    ' + (e && e.stack || e));
      process.exit(1);
    }
  }
  console.log('\n총 ' + scenarios + '개 무작위 시나리오 통과!');
})();
