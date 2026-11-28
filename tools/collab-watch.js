#!/usr/bin/env node
/*
 * tools/collab-watch.js — Claude ↔ 제미나이 협업 상황판 (이 PC에서만 열린다)
 *
 *   npm run collab   →   http://127.0.0.1:8787
 *
 * 보여 주는 것 (3초마다 새로 고침, 읽기만 한다):
 *   1. Claude가 쓴 작업 지시서(docs/design/briefs/*.md)와 시안별 진행 상태
 *   2. 제미나이가 지금 실행 중인지, 지금 무엇을 계획·진행 중인지(~/.gemini/antigravity-cli/brain 의 최근 작업 메모)
 *   3. 제미나이가 만든 파일(docs/design/mockups/wide/)과 미리보기
 *   4. 제미나이 응답 로그(logs/gemini/*.log)와 Claude 검토 메모(logs/gemini/review.md)
 *
 * 외부 패키지 없음. 127.0.0.1에만 열고, 정해진 폴더 밖 파일은 열지 않는다.
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var cp = require('child_process');

var ROOT = path.resolve(__dirname, '..');
var PORT = +(process.env.COLLAB_PORT || 8787);
var DIRS = {
  briefs: path.join(ROOT, 'docs', 'design', 'briefs'),
  out: path.join(ROOT, 'docs', 'design', 'mockups', 'wide'),
  phone: path.join(ROOT, 'docs', 'design', 'mockups'),
  logs: path.join(ROOT, 'logs', 'gemini'),
  brain: path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain')
};
var VARIANTS = ['I', 'J', 'K', 'L', 'M'];
var PAGES = ['Punch', 'Pay', 'Chk', 'QR', 'Set'];

function list(dir, filter) {
  try {
    return fs.readdirSync(dir).filter(filter || function () { return true; }).map(function (n) {
      var st = fs.statSync(path.join(dir, n));
      return { name: n, size: st.size, mtime: st.mtimeMs, dir: st.isDirectory() };
    });
  } catch (e) { return []; }
}
function readText(file, max) {
  try { var s = fs.readFileSync(file, 'utf8'); return max && s.length > max ? s.slice(-max) : s; } catch (e) { return ''; }
}

/* 제미나이(agy -p) 프로세스 수. 매번 부르면 무거우니 5초 캐시 */
var procCache = { at: 0, n: 0 };
function geminiRunning() {
  if (Date.now() - procCache.at < 5000) return procCache.n;
  var n = 0;
  try {
    if (process.platform === 'win32') {
      var out = cp.execFileSync('powershell.exe', ['-NoProfile', '-Command',
        "@(Get-CimInstance Win32_Process -Filter \"Name='agy.exe'\" | Where-Object { $_.CommandLine -match ' -p ' }).Count"],
        { encoding: 'utf8', timeout: 4000, windowsHide: true });
      n = parseInt(out, 10) || 0;
    } else {
      n = cp.execSync("pgrep -fc 'agy.* -p ' || true", { encoding: 'utf8' }).trim() | 0;
    }
  } catch (e) { n = -1; }
  procCache = { at: Date.now(), n: n };
  return n;
}

/* 가장 최근 제미나이 작업 메모(brain/<id>/ 안의 .md) */
function latestBrain() {
  var dirs = list(DIRS.brain, function () { return true; }).filter(function (d) { return d.dir; })
    .sort(function (a, b) { return b.mtime - a.mtime; }).slice(0, 3);
  for (var i = 0; i < dirs.length; i++) {
    var base = path.join(DIRS.brain, dirs[i].name);
    var notes = [];
    (function walk(d, depth) {
      list(d).forEach(function (f) {
        var p = path.join(d, f.name);
        if (f.dir && depth < 2) walk(p, depth + 1);
        else if (/\.(md|txt)$/i.test(f.name) && f.size < 200000) notes.push({ name: path.relative(base, p).replace(/\\/g, '/'), mtime: f.mtime, text: readText(p, 6000) });
      });
    })(base, 0);
    var feed = activity(path.join(base, '.system_generated', 'logs', 'transcript.jsonl'));
    if (notes.length || feed.length || i === dirs.length - 1) {
      notes.sort(function (a, b) { return b.mtime - a.mtime; });
      return { id: dirs[i].name, mtime: dirs[i].mtime, notes: notes, feed: feed };
    }
  }
  return null;
}

/* 제미나이 실시간 활동(transcript.jsonl 끝부분) → [{at, kind, text}] */
var TOOL_KO = { read_file: '파일 읽기', write_file: '파일 쓰기', write_to_file: '파일 쓰기', replace_file_content: '파일 고치기',
  edit_file: '파일 고치기', list_dir: '폴더 보기', list_directory: '폴더 보기', find_by_name: '파일 찾기', grep_search: '내용 찾기',
  view_file: '파일 읽기', run_command: '명령 실행' };
function short(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function activity(file) {
  var lines = readText(file, 400000).split('\n').filter(Boolean).slice(-40);
  var out = [];
  lines.forEach(function (ln) {
    var j; try { j = JSON.parse(ln); } catch (e) { return; }
    var at = Date.parse(j.created_at) || 0;
    if (j.type === 'PLANNER_RESPONSE') {
      if (j.thinking) out.push({ at: at, kind: 'think', text: short(j.thinking, 220) });
      if (j.content) out.push({ at: at, kind: 'say', text: short(j.content, 300) });
      (j.tool_calls || []).forEach(function (t) {
        var a = t.args || {};
        var target = a.Path || a.TargetFile || a.AbsolutePath || a.DirectoryPath || a.SearchPath || a.CommandLine || '';
        target = String(target).replace(/^"|"$/g, '').replace(/^.*alba-manager[\\/]/, '');
        out.push({ at: at, kind: 'tool', text: (TOOL_KO[t.name] || t.name) + (target ? ' · ' + target : '') });
      });
    } else if (j.source === 'USER' || j.type === 'USER_INPUT') {
      out.push({ at: at, kind: 'user', text: '작업 지시를 받음' });
    }
  });
  return out.slice(-15).reverse();
}

function state() {
  var outs = list(DIRS.out, function (n) { return /\.html$/.test(n); });
  var logs = list(DIRS.logs, function (n) { return /\.log$/.test(n); }).sort(function (a, b) { return a.mtime - b.mtime; });
  var running = geminiRunning();
  var variants = VARIANTS.map(function (v) {
    var vlogs = logs.filter(function (l) { return l.name.indexOf('_wide_' + v + '.log') > 0; });
    var last = vlogs[vlogs.length - 1];
    var made = PAGES.filter(function (p) { return outs.some(function (o) { return o.name === v + '_' + p + '.html'; }); });
    var st = 'wait';
    if (last) st = last.size === 0 ? (running > 0 ? 'run' : 'stop') : 'done';
    return { v: v, status: st, made: made, log: last ? last.name : null, brief: fs.existsSync(path.join(DIRS.briefs, 'wide_' + v + '.md')) };
  });
  return {
    now: Date.now(),
    running: running,
    variants: variants,
    briefs: list(DIRS.briefs, function (n) { return /\.md$/.test(n); }),
    outputs: outs.sort(function (a, b) { return b.mtime - a.mtime; }),
    logs: logs.reverse().slice(0, 15),
    brain: latestBrain(),
    review: readText(path.join(DIRS.logs, 'review.md'), 20000)
  };
}

/* 정해진 폴더 안의 파일만 연다 */
function safeFile(kind, name) {
  var dir = { brief: DIRS.briefs, out: DIRS.out, log: DIRS.logs }[kind];
  if (!dir || !name || /[\\/]|\.\./.test(name)) return null;
  var p = path.join(dir, name);
  return p.indexOf(dir + path.sep) === 0 && fs.existsSync(p) ? p : null;
}

var TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

var server = http.createServer(function (req, res) {
  var u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(state()));
  }
  var m = u.pathname.match(/^\/(brief|out|log)\/([^/]+)$/);
  if (m) {
    var f = safeFile(m[1], decodeURIComponent(m[2]));
    if (!f) { res.writeHead(404); return res.end('없음'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(f).pipe(res);
  }
  if (u.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(PAGE);
  }
  res.writeHead(404); res.end('없음');
});

var PAGE = String.raw`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>협업 상황판</title>
<style>
:root{--bg:#f2f4f6;--card:#fff;--ink:#191f28;--sub:#4e5968;--mute:#8b95a1;--line:#e5e8eb;--blue:#3182f6;--blue-bg:#e8f3ff;--red:#f04452;--amber-bg:#fff4e5;--amber:#b25e00;--green:#03b26c;--green-bg:#e6f8f0}
@media (prefers-color-scheme:dark){:root{--bg:#101215;--card:#1b1e23;--ink:#eceef1;--sub:#b0b8c1;--mute:#8b95a1;--line:#2c3036;--blue-bg:#16263d;--amber-bg:#3a2a12;--amber:#f5b45a;--green-bg:#123026}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.55 'Noto Sans KR',system-ui,sans-serif}
header{padding:20px 24px 4px;display:flex;align-items:center;gap:14px;flex-wrap:wrap}
h1{margin:0;font-size:20px}
.pill{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:15px;font-weight:700;font-size:13px;background:var(--card)}
.dot{width:8px;height:8px;border-radius:4px;background:var(--mute)}
.on .dot{background:var(--blue);animation:b 1s infinite alternate}@keyframes b{to{opacity:.3}}
.flow{display:flex;align-items:center;gap:8px;color:var(--sub);font-size:13px;margin-left:auto}
.flow b{color:var(--ink)}
main{display:grid;grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:16px;padding:16px 24px 32px}
@media (max-width:900px){main{grid-template-columns:1fr;padding:12px 16px}header{padding:16px 16px 0}}
.card{background:var(--card);border-radius:18px;padding:16px 18px;min-width:0}
.card h2{margin:0 0 10px;font-size:15px;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.card h2 small{font-weight:500;color:var(--mute);font-size:12px}
.span{grid-column:1/-1}
.steps{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px}
@media (max-width:700px){.steps{grid-template-columns:repeat(2,minmax(0,1fr))}}
.step{border:1px solid var(--line);border-radius:14px;padding:12px}
.step .v{font-size:18px;font-weight:800}
.tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;font-weight:700;background:var(--bg);color:var(--sub)}
.tag.run{background:var(--blue-bg);color:var(--blue)}.tag.done{background:var(--green-bg);color:var(--green)}.tag.stop{background:var(--amber-bg);color:var(--amber)}
.bar{height:6px;border-radius:3px;background:var(--line);margin:8px 0 4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--blue)}
.pages{display:flex;flex-wrap:wrap;gap:4px;font-size:11px;color:var(--mute)}.pages span.ok{color:var(--green);font-weight:700}
ul{list-style:none;margin:0;padding:0}li{display:flex;justify-content:space-between;gap:10px;padding:6px 0;border-top:1px solid var(--line);font-size:13px}li:first-child{border-top:0}
li .t{color:var(--mute);white-space:nowrap;font-variant-numeric:tabular-nums}
a{color:var(--blue);text-decoration:none;word-break:break-all}a:hover{text-decoration:underline}
pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12.5px/1.6 ui-monospace,Consolas,monospace;background:var(--bg);border-radius:12px;padding:12px;max-height:360px;overflow:auto}
.note{margin-bottom:10px}.note b{font-size:12px;color:var(--sub)}
.who{font-size:12px;font-weight:700;padding:2px 8px;border-radius:8px}.who.c{background:#f3e8ff;color:#7c3aed}.who.g{background:var(--blue-bg);color:var(--blue)}
@media (prefers-color-scheme:dark){.who.c{background:#2a1d40;color:#c4a1ff}}
.preview{display:flex;gap:12px;align-items:flex-start}
.preview .frame{width:472px;height:328px;flex:none;overflow:hidden;border-radius:12px;border:1px solid var(--line);background:#fff}
.preview iframe{width:1180px;height:820px;border:0;transform:scale(.4);transform-origin:0 0}
@media (max-width:700px){.preview{flex-direction:column}.preview .frame{width:100%;height:auto;aspect-ratio:1180/820}}
.empty{color:var(--mute);font-size:13px}
</style></head><body>
<header>
  <h1>Claude ↔ 제미나이 협업 상황판</h1>
  <span class="pill" id="run"><span class="dot"></span><span>확인 중</span></span>
  <span class="flow"><span class="who c">Claude</span> 지시서 작성 → <span class="who g">제미나이</span> 파일 작성 → <span class="who c">Claude</span> 검토</span>
</header>
<main>
  <section class="card span"><h2>시안별 진행 <small id="upd"></small></h2><div class="steps" id="steps"></div></section>
  <section class="card"><h2><span><span class="who g">제미나이</span> 지금 하는 일</span><small id="bid"></small></h2><div id="brain"></div></section>
  <section class="card"><h2><span><span class="who c">Claude</span> 검토 메모</span><small>logs/gemini/review.md</small></h2><div id="review"></div></section>
  <section class="card span"><h2>방금 만든 화면 미리보기 <small id="pname"></small></h2><div class="preview" id="preview"><span class="empty">아직 만든 파일이 없습니다.</span></div></section>
  <section class="card"><h2><span><span class="who g">제미나이</span> 만든 파일</span><small>docs/design/mockups/wide</small></h2><ul id="outs"></ul></section>
  <section class="card"><h2><span><span class="who c">Claude</span> 지시서 · <span class="who g">제미나이</span> 응답 로그</span></h2><ul id="docs"></ul></section>
</main>
<script>
var LABEL={wait:'대기',run:'진행 중',done:'끝',stop:'멈춤'};
var PNAME={Punch:'출퇴근',Pay:'근무·급여',Chk:'위생 점검',QR:'QR',Set:'설정'};
function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
function tm(ms){var d=new Date(ms);return d.toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}
function kb(n){return n<1024?n+'B':(n/1024).toFixed(1)+'KB'}
function link(href,text){var a=el('a',null,text);a.href=href;a.target='_blank';a.rel='noopener';return a}
var lastPreview='';
function render(s){
  var run=document.getElementById('run');run.className='pill'+(s.running>0?' on':'');
  run.lastChild.textContent=s.running>0?'제미나이 실행 중':(s.running<0?'실행 상태 확인 불가':'제미나이 쉬는 중');
  document.getElementById('upd').textContent=tm(s.now)+' 기준 · 3초마다 새로 고침';
  var st=document.getElementById('steps');st.textContent='';
  s.variants.forEach(function(v){
    var d=el('div','step');var top=el('div');top.style.cssText='display:flex;justify-content:space-between;align-items:center';
    top.appendChild(el('span','v','시안 '+v.v));top.appendChild(el('span','tag '+v.status,LABEL[v.status]));d.appendChild(top);
    var bar=el('div','bar'),i=el('i');i.style.width=(v.made.length/5*100)+'%';bar.appendChild(i);d.appendChild(bar);
    var pg=el('div','pages');['Punch','Pay','Chk','QR','Set'].forEach(function(p){var ok=v.made.indexOf(p)>=0;var sp=el('span',ok?'ok':'',(ok?'✓':'·')+PNAME[p]);pg.appendChild(sp)});d.appendChild(pg);
    st.appendChild(d)});
  var b=document.getElementById('brain');b.textContent='';
  if(s.brain){document.getElementById('bid').textContent='작업 '+s.brain.id.slice(0,8)+' · '+tm(s.brain.mtime);
    var feed=s.brain.feed||[];
    if(feed.length){var ago=Math.round((s.now-feed[0].at)/1000);
      b.appendChild(el('div','empty','마지막 활동 '+(ago<60?ago+'초':Math.floor(ago/60)+'분 '+(ago%60)+'초')+' 전'+(s.running>0&&ago>30?' · 긴 파일을 한 번에 쓰는 중일 수 있어요':'')));
      var ul=el('ul');feed.forEach(function(f){var li=el('li');var KIND={think:'생각',tool:'도구',say:'답',user:'지시'};
        var l=el('span');l.appendChild(el('span','tag'+(f.kind==='tool'?' run':''),KIND[f.kind]||f.kind));l.appendChild(document.createTextNode(' '+f.text));
        li.appendChild(l);li.appendChild(el('span','t',tm(f.at)));ul.appendChild(li)});b.appendChild(ul)}
    if(!s.brain.notes.length&&!feed.length)b.appendChild(el('div','empty','작업 메모가 아직 없습니다(생각 중이거나 파일을 쓰는 중).'));
    s.brain.notes.slice(0,3).forEach(function(n){var w=el('div','note');w.appendChild(el('b',null,n.name+' · '+tm(n.mtime)));w.appendChild(el('pre',null,n.text));b.appendChild(w)})}
  else b.appendChild(el('div','empty','제미나이 작업 기록이 없습니다.'));
  var r=document.getElementById('review');r.textContent='';
  if(s.review)r.appendChild(el('pre',null,s.review));else r.appendChild(el('div','empty','시안이 다 만들어지면 Claude가 검토 결과를 여기에 적습니다.'));
  var o=document.getElementById('outs');o.textContent='';
  if(!s.outputs.length)o.appendChild(el('li','empty','아직 없음'));
  s.outputs.forEach(function(f){var li=el('li');li.appendChild(link('/out/'+encodeURIComponent(f.name),f.name));li.appendChild(el('span','t',kb(f.size)+' · '+tm(f.mtime)));o.appendChild(li)});
  var latest=s.outputs.filter(function(f){return f.name!=='index.html'})[0];
  if(latest&&latest.name+latest.mtime!==lastPreview){lastPreview=latest.name+latest.mtime;
    var p=document.getElementById('preview');p.textContent='';var fr=el('div','frame');var ifr=el('iframe');ifr.src='/out/'+encodeURIComponent(latest.name)+'?t='+latest.mtime;ifr.title=latest.name;fr.appendChild(ifr);p.appendChild(fr);
    var side=el('div');side.appendChild(el('div',null,latest.name));side.appendChild(link('/out/'+encodeURIComponent(latest.name),'실제 크기로 열기'));p.appendChild(side);
    document.getElementById('pname').textContent=tm(latest.mtime)}
  var dl=document.getElementById('docs');dl.textContent='';
  s.briefs.forEach(function(f){var li=el('li');var l=el('span');l.appendChild(el('span','who c','지시서'));l.appendChild(document.createTextNode(' '));l.appendChild(link('/brief/'+encodeURIComponent(f.name),f.name));li.appendChild(l);li.appendChild(el('span','t',tm(f.mtime)));dl.appendChild(li)});
  s.logs.forEach(function(f){var li=el('li');var l=el('span');l.appendChild(el('span','who g','응답'));l.appendChild(document.createTextNode(' '));l.appendChild(link('/log/'+encodeURIComponent(f.name),f.name));li.appendChild(l);li.appendChild(el('span','t',f.size?kb(f.size):'작성 중'));dl.appendChild(li)});
}
function tick(){fetch('/api/state',{cache:'no-store'}).then(function(r){return r.json()}).then(render).catch(function(){document.getElementById('run').lastChild.textContent='상황판 서버가 꺼졌습니다'})}
tick();setInterval(tick,3000);
</script></body></html>`;

server.listen(PORT, '127.0.0.1', function () {
  console.log('협업 상황판: http://127.0.0.1:' + PORT + '  (끄려면 Ctrl+C)');
});
