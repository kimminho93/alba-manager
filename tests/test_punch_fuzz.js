/* tests/test_punch_fuzz.js — 출퇴근 무작위 반복 검증
 *
 * 여러 알바생이 며칠 동안 무작위로 출근·퇴근·일괄 퇴근을 찍고, 퇴근을 잊기도 하고(자동 퇴근),
 * 단위·유예·찍은 그대로·자동 퇴근 시각을 무작위로 바꿔 가며 돌린다. 매 회차마다 확인:
 *   1) 오류 없이 돌아가고, 달력 칸은 항상 올바른 시각, 하루 근무는 0~24시간
 *   2) 시트 '출퇴근기록' 장부만 가지고 처음부터 다시 재생하면(다른 기기·다시 로그인)
 *      이 기기와 똑같은 달력·근무 중 상태·확인 필요 목록이 된다
 *   3) 확인 필요를 사장님이 처리하면 목록에서 빠지고, 지금 근무 중 상태는 그대로
 * 실행: node tests/test_punch_fuzz.js [회차=200]
 */
'use strict';
const assert = require('assert');
const E = require('../include/alba_engine.js');

const ROUNDS = Math.max(1, Number(process.argv[2]) || 200);
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const p2 = n => String(n).padStart(2, '0');
const tsOf = d => d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;

function state(ws) {
  return ws.map(w => ({
    code: w.code,
    punch: w.punch ? { date: w.punch.date, time: w.punch.time } : null,
    pending: (w.pending || []).map(p => p.date + ' ' + p.start),
    months: Object.keys(w.months).sort().map(pm => [pm, E.workerShifts(w, pm).map(s => s.off ? '-' : s.start + '~' + s.end + '/' + (s.breakMinutes || 0)).join(',')])
  }));
}

function round(seed) {
  round.stat = round.stat || { pend: 0, shifts: 0 };
  const R = rng(seed);
  const pick = a => a[Math.floor(R() * a.length)];
  const unit = pick([5, 10, 15, 20, 30, 60]);
  const gr = E.graceChoices(unit);
  const opts = { unit, inMode: R() < 0.2 ? 'exact' : 'round', outMode: R() < 0.2 ? 'exact' : 'round', graceIn: pick(gr), graceOut: pick(gr), autoOut: pick(E.AUTO_OUT_CHOICES) };
  const n = 2 + Math.floor(R() * 4);
  const live = [], codes = [];
  for (let i = 0; i < n; i++) { const w = E.createWorker('w' + i, 5, 10320); live.push(w); codes.push(w.code); }
  const rows = [];
  let t = new Date(2026, 10, 3, 6, 0, 0).getTime();
  const end = new Date(2026, 10, 13, 6, 0, 0).getTime();
  const autoClose = now => {
    E.autoCloseOpen(live, now, opts.autoOut).forEach(d => rows.push([tsOf(d.ts), d.worker.code, d.worker.name, '퇴근누락(확인필요)', '자동(마감)', '정상(자동)', '']));
  };
  while (t < end) {
    // 다음 사건까지 1분~5시간 (가끔 하루 넘게 비움 → 앱이 꺼져 있던 경우)
    t += (R() < 0.08 ? 20 * 3600 : 60 + Math.floor(R() * 5 * 3600)) * 1000;
    const now = new Date(t);
    if (R() < 0.7) autoClose(now);   // 앱이 켜져 있으면 15초마다 자동 퇴근 확인 (가끔은 꺼져 있음)
    const r = R();
    if (r < 0.08) {
      autoClose(now);
      E.applyPunchAll(live, now, opts).forEach(d => rows.push([tsOf(now), d.worker.code, d.worker.name, '퇴근', '일괄 퇴근(관리자)', '정상', '']));
    } else {
      const w = pick(live);
      autoClose(now);
      const res = E.applyPunch(w, now, opts);
      if (res.kind === 'in' || res.kind === 'out') rows.push([tsOf(now), w.code, w.name, res.kind === 'in' ? '출근' : '퇴근', '이름+비밀번호', res.note ? '정상(참고)' : '정상', res.note || '']);
      if (R() < 0.1) rows.push([tsOf(now), w.code, w.name, '', '이름+비밀번호', '비밀번호 오류', '1번째 연속 실패']);   // 틀린 비밀번호 줄은 무시돼야 함
    }
    // 불변 조건
    live.forEach(w => {
      Object.keys(w.months).forEach(pm => E.workerShifts(w, pm).forEach(s => {
        if (s.off) return;
        assert.ok(HM.test(s.start) && HM.test(s.end), '시각 형식 ' + s.start + '~' + s.end);
        const h = E.calcShiftHours(s.start, s.end, s.breakMinutes);
        assert.ok(h >= 0 && h <= 24, '하루 근무 ' + h);
      }));
      (w.pending || []).forEach(p => assert.ok(HM.test(p.start)));
      if (w.punch) assert.ok(!(w.pending || []).some(p => p.date === w.punch.date && p.start === w.punch.time && p.at === w.punch.at), '근무 중인 출근이 확인 필요에도 있음');
    });
  }
  autoClose(new Date(end));

  live.forEach(w => { round.stat.pend += (w.pending || []).length; Object.keys(w.months).forEach(pm => round.stat.shifts += E.workerShifts(w, pm).filter(s => !s.off).length); });
  // 장부만으로 다시 만들기 (다른 기기·다시 로그인)
  const fresh = live.map(w => { const x = E.createWorker(w.name, 5, 10320); x.code = w.code; return x; });
  E.replayPunchLog(fresh, rows, 0, opts);
  E.autoCloseOpen(fresh, new Date(end), opts.autoOut);
  assert.deepStrictEqual(state(fresh), state(live), '시드 ' + seed + ': 장부 재생 결과가 이 기기와 다름 ' + JSON.stringify(opts));

  // 저장·불러오기 정리 후에도 같음
  assert.deepStrictEqual(state(E.normalizeWorkers(JSON.parse(JSON.stringify(live)))), state(live), '시드 ' + seed + ': 저장 정리 후 달라짐');

  // 확인 필요 처리
  live.forEach(w => {
    const keep = JSON.stringify(w.punch || null);
    while ((w.pending || []).length) {
      const p = w.pending[0];
      if (R() < 0.5) {
        let e = (Number(p.start.slice(0, 2)) + 1 + Math.floor(R() * 8)) % 24;
        const endHM = p2(e) + ':' + p2(Math.floor(R() * 60));
        const r = E.resolvePending(w, 0, endHM);
        if (!r.ok) { assert.strictEqual(endHM, p.start); E.dismissPending(w, 0); }
      } else E.dismissPending(w, 0);
    }
    assert.strictEqual(JSON.stringify(w.punch || null), keep, '확인 처리 중 근무 중 상태가 바뀜');
    assert.strictEqual(w.pending, undefined);
  });
  return rows.length;
}

let rowsTotal = 0;
console.log('=== [6] 출퇴근 무작위 반복 검증 (' + ROUNDS + '회) ===');
for (let i = 1; i <= ROUNDS; i++) {
  try { rowsTotal += round(i); }
  catch (e) { console.error('  ✗ ' + i + '회차 실패\n    ' + (e && e.stack || e)); process.exit(1); }
}
console.log('  ✓ ' + ROUNDS + '회 · 출퇴근 기록 ' + rowsTotal + '줄: 오류 없음, 장부 재생 = 이 기기, 확인 필요 처리 정상');
console.log('  (확인 필요 ' + round.stat.pend + '건, 근무한 날 ' + round.stat.shifts + '칸 포함)');
console.log('총 ' + ROUNDS + '개 출퇴근 무작위 시나리오 통과!');
