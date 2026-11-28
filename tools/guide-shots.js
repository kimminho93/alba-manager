#!/usr/bin/env node
/*
 * tools/guide-shots.js — 사용 방법(가이드) 스크린샷 10장을 다시 찍는다.
 *
 *   node tools/guide-shots.js            → web/img/guide-*.webp 덮어쓰기
 *   node tools/guide-shots.js --out DIR  → 다른 폴더에 저장(확인용)
 *
 * - 이 PC에 깔린 Microsoft Edge를 헤드리스로 띄워 개발자 프로토콜(CDP)로 조종한다. 추가 설치·다운로드 없음.
 * - 빈 임시 프로필을 써서 평소 브라우저 데이터는 건드리지 않는다. 끝나면 임시 프로필을 지운다.
 * - 앱은 이 저장소의 web/ 폴더를 로컬 서버(server/app.js --static)로 띄워서 연다. 이미 8000번이 떠 있으면 그대로 쓴다.
 * - 예시 데이터(알바생 3명, 근무, 출퇴근)는 화면을 실제로 눌러서 만든다. 구글 연동·실제 매장 데이터와 무관하다.
 * - 크기: 390×844 화면을 1.5배로 찍어 585×1266(예전 가이드 그림과 같은 크기), 라이트 모드, 한국어.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > 0 ? path.resolve(process.argv[outIdx + 1]) : path.join(ROOT, 'web', 'img');
const APP_PORT = 8000, CDP_PORT = 9333;
const BASE = 'http://localhost:' + APP_PORT + '/';

const EDGE = [
  process.env.EDGE_BIN,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
].filter(p => p && fs.existsSync(p))[0];

const sleep = ms => new Promise(r => setTimeout(r, ms));
function getJson(url) {
  return new Promise((res, rej) => http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
}
function ping(url) { return new Promise(res => http.get(url, r => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false))); }

async function main() {
  if (!EDGE) throw new Error('Microsoft Edge를 찾지 못했습니다(EDGE_BIN 환경 변수로 경로를 줄 수 있어요).');
  fs.mkdirSync(OUT, { recursive: true });

  // 1) 앱 서버
  let server = null;
  if (!(await ping(BASE))) {
    server = cp.spawn(process.execPath, [path.join(ROOT, 'server', 'app.js'), '--static', '--port', String(APP_PORT)], { cwd: ROOT, stdio: 'ignore' });
    for (let i = 0; i < 40 && !(await ping(BASE)); i++) await sleep(250);
  }

  // 2) Edge (빈 임시 프로필)
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'alba-shots-'));
  const edge = cp.spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--lang=ko-KR',
    '--remote-debugging-port=' + CDP_PORT, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
  let ver = null;
  for (let i = 0; i < 60 && !ver; i++) { try { ver = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/version'); } catch (e) { await sleep(250); } }
  if (!ver) throw new Error('Edge 개발자 연결을 열지 못했습니다.');
  const list = await getJson('http://127.0.0.1:' + CDP_PORT + '/json/list');
  const page = list.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let seq = 0; const wait = new Map(); const loads = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
    else if (m.method === 'Page.loadEventFired') loads.splice(0).forEach(f => f());
  };
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; wait.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); });
  const run = async (code) => {
    const r = await send('Runtime.evaluate', { expression: '(async () => {' + code + '})()', awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('페이지 스크립트 오류: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  const go = async (url) => { const p = new Promise(r => loads.push(r)); await send('Page.navigate', { url }); await p; await sleep(900); };
  const shot = async (name) => {
    await sleep(700);   // 화면 전환(흐려졌다 나타나는) 효과가 끝나기를 기다림
    const r = await send('Page.captureScreenshot', { format: 'webp', quality: 82 });
    fs.writeFileSync(path.join(OUT, 'guide-' + name + '.webp'), Buffer.from(r.data, 'base64'));
    console.log('찍음: guide-' + name + '.webp');
  };

  try {
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1.5, mobile: true });
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
    await send('Emulation.setLocaleOverride', { locale: 'ko-KR' }).catch(() => {});
    await go(BASE);

    // 공통 도우미(페이지 안): 탭 열기, 기다리기, 확인창 자동 '예', 토스트 숨김
    const H = `
      window.confirm = () => true;
      const $ = id => document.getElementById(id);
      const w = ms => new Promise(r => setTimeout(r, ms));
      const tab = async t => { document.querySelector('.tabs .tab[data-tab="' + t + '"]').click(); await w(300); window.scrollTo(0, 0); };
      if (!document.getElementById('shotStyle')) { const s = document.createElement('style'); s.id = 'shotStyle'; s.textContent = '.toast{display:none!important}'; document.head.appendChild(s); }
    `;
    // 예시 데이터 만들기: 한국어, 라이트, 가게 이름, 알바생 3명, 이번 달 근무
    await run(H + `
      if (window.AlbaLang) AlbaLang.set('ko');
      document.documentElement.setAttribute('data-theme', 'light'); try { localStorage.setItem('alba.theme', 'light'); } catch (e) {}
      await tab('settings');
      $('sStoreName').value = '우리분식 본점'; $('sStoreName').dispatchEvent(new Event('input', { bubbles: true })); $('sStoreName').dispatchEvent(new Event('change', { bubbles: true }));
      $('sOwnerName').value = '김사장'; $('sOwnerName').dispatchEvent(new Event('input', { bubbles: true })); $('sOwnerName').dispatchEvent(new Event('change', { bubbles: true }));
      await w(300);
      const add = async (n, pw) => {
        await tab('payroll');
        const f = $('addWorkerForm'); f.hidden = false; $('awName').value = n; $('awPw').value = pw;
        f.requestSubmit($('btnAddWorker')); await w(500);
        const later = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '나중에' && b.offsetParent); if (later) later.click();
        await w(200);
      };
      await add('홍길동', '1234'); await add('김철수', '5678'); await add('이영희', '5555');
      // 홍길동: 이번 달 오늘 전까지 평일 근무
      await tab('payroll');
      [...document.querySelectorAll('#workerChips button')].find(b => b.textContent.includes('홍길동')).click(); await w(400);
      const today = new Date().getDate();
      const cells = () => [...document.querySelectorAll('#monthCalBody td.cal-day-cell')];
      for (const td of cells()) {
        const d = Number(td.querySelector('.cal-date-num').textContent), col = td.cellIndex;
        if (d >= today || col >= 5) continue;
        cells().find(x => Number(x.querySelector('.cal-date-num').textContent) === d).click(); await w(250);
        const q = [...document.querySelectorAll('#dayModal button')].find(b => /~/.test(b.textContent)); if (q) q.click();
        await w(120); [...document.querySelectorAll('#dayModal button')].find(b => /완료/.test(b.textContent)).click(); await w(200);
      }
      return 'ok';
    `);
    // 출퇴근: 홍길동·김철수 출근, 이영희는 3시간 전 출근한 것으로 만들어 퇴근 결과를 찍을 수 있게
    await run(H + `
      await tab('punch');
      const punch = async (n, pw) => {
        [...document.querySelectorAll('#punchList .punch-row')].find(r => r.innerText.startsWith(n)).click(); await w(300);
        $('punchPwInput').value = pw; $('punchPwOk').click(); await w(600);
        const c = document.querySelector('#punchResult .btn-big'); if (c && !$('punchResult').hidden) c.click(); await w(300);
      };
      await punch('홍길동', '1234'); await punch('김철수', '5678'); await punch('이영희', '5555');
      const ws = JSON.parse(localStorage.getItem('alba.workers.v2'));
      const lee = (ws.workers || ws).find ? (ws.workers || ws).find(x => x.name === '이영희') : null;
      if (lee && lee.punch) {
        const t = new Date(Date.now() - 3 * 3600 * 1000), p2 = n => (n < 10 ? '0' : '') + n;
        lee.punch.date = t.getFullYear() + '-' + p2(t.getMonth() + 1) + '-' + p2(t.getDate());
        lee.punch.time = lee.punch.at = p2(t.getHours()) + ':' + p2(t.getMinutes());
        localStorage.setItem('alba.workers.v2', JSON.stringify(ws));
      }
      return lee ? 'ok' : 'no-lee';
    `);
    await go(BASE + '?shots=1');

    // 1) 출퇴근 화면
    await run(H + `await tab('punch'); return 1;`); await shot('punch-list');
    // 2) 비밀번호 입력
    await run(H + `[...document.querySelectorAll('#punchList .punch-row')].find(r => r.innerText.startsWith('이영희')).click(); await w(300); $('punchPwInput').value = '5555'; return 1;`);
    await shot('punch-pw');
    // 3) 퇴근 결과
    await run(H + `$('punchPwOk').click(); await w(700); return 1;`); await shot('punch-out');
    await run(H + `const c = document.querySelector('#punchResult .btn-big'); if (c) c.click(); await w(300); return 1;`);
    // 4) 근무·급여(달력)
    // 이름 칩·달·줄 돈 보기 아래로 달력이 보이게 달력 머리 근처까지 내린다
    await run(H + `await tab('payroll'); [...document.querySelectorAll('#workerChips button')].find(b => b.textContent.includes('홍길동')).click(); await w(500);
      const top = $('pMonthLabel').getBoundingClientRect().top + window.scrollY - 16; window.scrollTo(0, top); await w(200); return 1;`);
    await shot('main');
    // 5) 날짜 창
    await run(H + `const td = [...document.querySelectorAll('#monthCalBody td.cal-day-cell')].find(t => t.querySelector('.cal-shift-range span')); td.click(); await w(500); return 1;`);
    await shot('day');
    await run(H + `[...document.querySelectorAll('#dayModal button')].find(b => /완료/.test(b.textContent)).click(); await w(300); return 1;`);
    // 6) 줄 돈 보기
    await run(H + `$('moneyToggle').click(); await w(300); $('moneyToggle').scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); await w(200); return 1;`);
    await shot('money');
    await run(H + `$('moneyToggle').click(); await w(200); window.scrollTo(0, 0); return 1;`);
    // 7) 정산 설정 창
    await run(H + `$('openSet').click(); await w(500); return 1;`); await shot('set');
    await run(H + `$('setSheetDone').click(); await w(300); return 1;`);
    // 8) 알바생 추가 창
    await run(H + `$('chipAdd').click(); await w(400); $('awName').value = '박민수'; return 1;`); await shot('add');
    await run(H + `$('addSheetClose').click(); await w(300); return 1;`);
    // 9) 정산 명단(⋯ 메뉴 연 모습)
    await run(H + `const m = document.querySelector('#tab-payroll .more-menu'); m.scrollIntoView({ block: 'center' }); m.open = true; await w(300); return 1;`);
    await shot('roster');
    // 10) 엑셀로 받을 알바생 고르기
    await run(H + `$('btnRosterXlsx').click(); await w(500); return 1;`); await shot('export');
  } finally {
    try { ws.close(); } catch (e) {}
    try { edge.kill(); } catch (e) {}
    if (server) try { server.kill(); } catch (e) {}
    await sleep(600);
    try { fs.rmSync(prof, { recursive: true, force: true }); } catch (e) {}
  }
  console.log('끝: ' + OUT);
}

main().catch(e => { console.error('실패: ' + (e && e.message || e)); process.exit(1); });
