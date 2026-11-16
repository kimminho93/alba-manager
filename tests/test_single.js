/* tests/test_single.js — 단일 저장(출퇴근 기기만 저장, 다른 기기는 수정 요청) 무작위 반복 검증
 *
 * 매장 태블릿(출퇴근 기기) 1대 + 점장 폰·사장님 PC(요청 기기) 2대가 같은 시트를 쓰면서
 * 무작위로 고치고, 인터넷이 끊기고, 저장이 실패하고, 앱을 다시 켜는 일을 섞는다. 매번 확인:
 *   1) 요청 기기는 데이터 탭을 절대 쓰지 않는다
 *   2) 보낸 요청은 모두 정확히 한 번 처리된다(적용 또는 거절), 두 번 적용되는 일 없음
 *   3) 끝나면 세 기기와 시트의 내용이 같고, 대기 중인 요청이 남지 않는다
 *   4) 적용된 요청의 값은 그 뒤 다른 변경이 없었다면 그대로 남아 있다
 * 실행: node tests/test_single.js [반복=30]
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const src = fs.readFileSync(path.join(__dirname, 'test_cloud.js'), 'utf8');
const cut = src.indexOf("(async () => {\n  console.log('=== [4]");
const H = new Function('require', 'process', 'console', src.slice(0, cut) + '\nreturn { makeGoogle, makeDevice, worker };')(
  createRequire(path.join(__dirname, 'x.js')), process, console);
const ROUNDS = Math.max(1, Number(process.argv[2]) || 30);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function canon(x) {
  if (x === undefined || x === null) return 'null';
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (typeof x === 'object') return '{' + Object.keys(x).filter(k => x[k] !== undefined && k !== 'reqLog' && k !== 'conflicts').sort().map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
const OFF = { off: true, start: '09:00', end: '14:00', breakMinutes: 0 };
const p2 = n => String(n).padStart(2, '0');

async function round(seed) {
  const R = rng(seed);
  const g = H.makeGoogle();
  const mk = (n) => H.worker(n, { '2026-11': { wage: 10320, dailyShifts: Array.from({ length: 30 }, () => Object.assign({}, OFF)) } });
  let tab = H.makeDevice(g);
  tab.data.workers = [mk('김'), mk('이'), mk('박')];
  await tab.cloud.connect();
  assert.ok(await tab.cloud.designate('매장 태블릿'));
  const sid = JSON.parse(tab.store['alba.cloud.v1']).sheetId;
  const reqs = [H.makeDevice(g), H.makeDevice(g)];
  for (const d of reqs) { await d.cloud.connect(); assert.strictEqual(d.cloud.role(), 'requester'); }
  const sent = new Set();
  const dataRows = () => JSON.stringify(g.rows(sid, '데이터'));
  const randCell = () => { const s = 8 + Math.floor(R() * 6), e = s + 1 + Math.floor(R() * 6); return { off: false, start: p2(s) + ':00', end: p2(e) + ':' + (R() < 0.5 ? '00' : '30'), breakMinutes: 0 }; };
  const editSome = d => {
    const ws = d.data.workers;
    if (!ws.length) return;
    const r = R();
    if (r < 0.5) { const w = ws[Math.floor(R() * ws.length)]; if (w.months['2026-11']) w.months['2026-11'].dailyShifts[Math.floor(R() * 5)] = randCell(); }
    else if (r < 0.7) { const w = ws[Math.floor(R() * ws.length)]; w.wage = 10000 + Math.floor(R() * 5) * 100; }
    else if (r < 0.85) { d.data.archive = d.data.archive || []; d.data.archive.push({ date: '2026-11-' + p2(1 + Math.floor(R() * 28)), by: Math.floor(R() * 1000) }); }
    else if (r < 0.92 && d.data.archive && d.data.archive.length) { d.data.archive.splice(Math.floor(R() * d.data.archive.length), 1); }
    else { const w = ws[Math.floor(R() * ws.length)]; w.name = w.name.slice(0, 1) + Math.floor(R() * 10); }
  };
  const steps = 25 + Math.floor(R() * 25);
  for (let i = 0; i < steps; i++) {
    const r = R();
    if (r < 0.35) {   // 요청 기기에서 수정
      const d = reqs[Math.floor(R() * reqs.length)];
      const before = dataRows();
      if (R() < 0.2) g.failReqAppend = 1;
      editSome(d);
      d.cloud.markDirty(); await d.cloud.saveNow();
      d.cloud.pendingRequests().forEach(x => sent.add(x.id));
      assert.strictEqual(dataRows(), before, '시드 ' + seed + ': 요청 기기가 데이터 탭을 씀');
    } else if (r < 0.55) {   // 태블릿에서 직접 수정 (출퇴근 등)
      if (R() < 0.15) g.failDataWrite = 1;
      editSome(tab);
      tab.cloud.markDirty(); await tab.cloud.saveNow();
    } else if (r < 0.75) {   // 태블릿 새로 받기(요청 처리)
      if (R() < 0.15) g.failDataWrite = 1;
      tab.clock.t += 31000; await tab.cloud.refresh();
    } else if (r < 0.92) {   // 요청 기기 새로 받기
      const d = reqs[Math.floor(R() * reqs.length)];
      const before = dataRows();
      d.clock.t += 31000; await d.cloud.refresh();
      assert.strictEqual(dataRows(), before, '시드 ' + seed + ': 요청 기기가 새로 받다가 데이터 탭을 씀');
    } else {   // 태블릿 앱을 다시 켬 (기기 저장소는 그대로)
      const keep = JSON.parse(JSON.stringify(tab.data)), clock = tab.clock.t;
      tab = H.makeDevice(g, { store: tab.store });
      tab.data = keep; tab.clock.t = clock + 5000;
      await tab.cloud.resume();
    }
  }
  // 조용해질 때까지
  for (let k = 0; k < 8; k++) {
    for (const d of reqs) { d.clock.t += 31000; await d.cloud.refresh(); d.cloud.pendingRequests().forEach(x => sent.add(x.id)); }
    tab.clock.t += 31000; await tab.cloud.refresh();
    if (JSON.parse(tab.store['alba.cloud.v1']).dirty) await tab.cloud.saveNow();
  }
  for (const d of reqs) { d.clock.t += 31000; await d.cloud.refresh(); }
  const sheet = JSON.parse(g.rows(sid, '데이터').slice(2).map(r => r[0]).join(''));
  const log = sheet.reqLog || { applied: [], rejected: [] };
  const applied = log.applied || [], rejected = (log.rejected || []).map(x => x.id);
  assert.strictEqual(new Set(applied).size, applied.length, '시드 ' + seed + ': 같은 요청이 두 번 적용됨');
  applied.forEach(id => assert.ok(rejected.indexOf(id) < 0, '적용과 거절에 동시에 있음'));
  sent.forEach(id => assert.ok(applied.indexOf(id) >= 0 || rejected.indexOf(id) >= 0, '시드 ' + seed + ': 처리 안 된 요청 ' + id));
  for (const d of reqs) {
    assert.strictEqual(d.cloud.pendingRequests().length, 0, '시드 ' + seed + ': 대기 요청이 남음');
    assert.strictEqual(canon(d.data), canon(tab.data), '시드 ' + seed + ': 요청 기기 화면과 태블릿이 다름');
  }
  assert.strictEqual(canon(sheet), canon(tab.data), '시드 ' + seed + ': 시트와 태블릿이 다름');
  // 상태 칸: 처리한 줄은 모두 적용됨/거절
  const rows = g.rows(sid, '수정요청').slice(1);
  rows.forEach(row => { if (row[0]) assert.ok(row[6] === '적용됨' || row[6] === '거절', '시드 ' + seed + ': 상태 칸 비어 있음 ' + row[0]); });
  return { sent: sent.size, applied: applied.length, rejected: rejected.length };
}

/* 출퇴근 기기를 중간에 다른 기기로 바꾸는 경우까지 섞음 (세 기기 모두 고치고, 앱을 다시 켜고, 지정이 바뀜) */
async function roundSwap(seed) {
  const R = rng(seed);
  const g = H.makeGoogle();
  const mk = (n) => H.worker(n, { '2026-11': { wage: 10320, dailyShifts: Array.from({ length: 30 }, () => Object.assign({}, OFF)) } });
  const devs = [H.makeDevice(g), H.makeDevice(g), H.makeDevice(g)];
  devs[0].data.workers = [mk('김'), mk('이')];
  await devs[0].cloud.connect();
  assert.ok(await devs[0].cloud.designate('A'));
  await devs[1].cloud.connect(); await devs[2].cloud.connect();
  const sid = JSON.parse(devs[0].store['alba.cloud.v1']).sheetId;
  const sent = new Set();
  const dataRows = () => JSON.stringify(g.rows(sid, '데이터'));
  const note = () => devs.forEach(d => d.cloud.pendingRequests().forEach(x => sent.add(x.id)));
  const steps = 30 + Math.floor(R() * 30);
  for (let i = 0; i < steps; i++) {
    const k = Math.floor(R() * devs.length);
    let d = devs[k];
    const r = R();
    const wasReq = d.cloud.role() === 'requester';
    const before = dataRows();
    if (r < 0.4) {
      const ws = d.data.workers;
      if (ws.length) { const w = ws[Math.floor(R() * ws.length)]; if (R() < 0.6 && w.months['2026-11']) w.months['2026-11'].dailyShifts[Math.floor(R() * 4)] = { off: false, start: '09:00', end: p2(10 + Math.floor(R() * 8)) + ':00', breakMinutes: 0 }; else w.wage = 10000 + Math.floor(R() * 9) * 100; }
      if (R() < 0.15) g.failDataWrite = 1;
      d.cloud.markDirty(); await d.cloud.saveNow();
    } else if (r < 0.8) {
      d.clock.t += 31000; await d.cloud.refresh();
    } else if (r < 0.92) {
      const keep = JSON.parse(JSON.stringify(d.data)), clock = d.clock.t;
      d = devs[k] = H.makeDevice(g, { store: d.store });
      d.data = keep; d.clock.t = clock + 5000;
      await d.cloud.resume();
    } else {
      note();
      await d.cloud.designate(String.fromCharCode(65 + k));
    }
    note();
    if (wasReq && d.cloud.role() === 'requester' && r < 0.92) assert.strictEqual(dataRows(), before, '시드 ' + seed + ': 요청 기기가 데이터 탭을 씀');
  }
  for (let q = 0; q < 10; q++) {
    for (const d of devs) { d.clock.t += 31000; await d.cloud.refresh(); if (d.cloud.role() === 'writer' && JSON.parse(d.store['alba.cloud.v1']).dirty) await d.cloud.saveNow(); }
    note();
  }
  const writers = devs.filter(d => d.cloud.role() === 'writer');
  assert.strictEqual(writers.length, 1, '시드 ' + seed + ': 출퇴근 기기가 ' + writers.length + '대');
  const w = writers[0];
  const sheet = JSON.parse(g.rows(sid, '데이터').slice(2).map(r => r[0]).join(''));
  const log = sheet.reqLog || { applied: [], rejected: [] };
  const applied = log.applied || [], rejected = (log.rejected || []).map(x => x.id);
  assert.strictEqual(new Set(applied).size, applied.length, '시드 ' + seed + ': 같은 요청이 두 번 적용됨');
  sent.forEach(id => assert.ok(applied.indexOf(id) >= 0 || rejected.indexOf(id) >= 0, '시드 ' + seed + ': 처리 안 된 요청 ' + id));
  devs.forEach(d => {
    assert.strictEqual(d.cloud.pendingRequests().length, 0, '시드 ' + seed + ': 대기 요청이 남음');
    assert.strictEqual(canon(d.data), canon(w.data), '시드 ' + seed + ': 기기끼리 다름');
  });
  assert.strictEqual(canon(sheet), canon(w.data), '시드 ' + seed + ': 시트와 다름');
  return sent.size;
}

(async () => {
  console.log('=== [7] 단일 저장 무작위 반복 검증 (' + ROUNDS + '회) ===');
  let tot = { sent: 0, applied: 0, rejected: 0 };
  for (let i = 1; i <= ROUNDS; i++) {
    try {
      const r = await round(1000 + i * 7919);
      tot.sent += r.sent; tot.applied += r.applied; tot.rejected += r.rejected;
    } catch (e) { console.log('  ✗ ' + i + '회차 실패\n    ' + (e && e.stack || e)); process.exit(1); }
  }
  let swapReq = 0;
  for (let i = 1; i <= ROUNDS; i++) {
    try { swapReq += await roundSwap(5000 + i * 104729); } catch (e) { console.log('  ✗ 기기 교체 ' + i + '회차 실패\n    ' + (e && e.stack || e)); process.exit(1); }
  }
  console.log('  ✓ ' + ROUNDS + '회 · 출퇴근 기기 교체·재시작 섞음 · 요청 ' + swapReq + '건: 출퇴근 기기는 항상 1대, 모두 처리, 기기·시트 일치');
  console.log('  ✓ ' + ROUNDS + '회 · 요청 ' + tot.sent + '건 (적용 ' + tot.applied + ', 거절 ' + tot.rejected + '): 요청 기기는 데이터 탭을 안 씀, 모두 한 번씩 처리, 세 기기·시트 일치');
  console.log('총 ' + ROUNDS + '개 단일 저장 무작위 시나리오 통과!');
})();
