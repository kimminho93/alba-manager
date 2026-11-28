#!/usr/bin/env node
/*
 * tools/collab/server.js — Claude ↔ 제미나이 협업 센터 (이 PC에서만 열린다)
 *
 *   npm run collab   →   http://127.0.0.1:8787
 *
 * - 입력창 하나로 Claude(Claude Code CLI)와 제미나이(안티그래비티 agy)에게 일을 준다.
 * - 자동 배정: 오늘 토큰을 덜 쓴 쪽이 받는다. 한쪽이 실패(로그인·한도)하면 다른 쪽으로 넘긴다.
 * - 넘기기: 답 마지막 줄의 `@제미나이: 할 일` / `@claude: 할 일`을 상대에게 이어서 맡긴다(최대 2번).
 * - 한 번에 한 작업만 돈다(같은 파일을 동시에 고치지 않게). 나머지는 줄을 선다.
 * - 기록: logs/collab/jobs.jsonl(작업), logs/collab/ledger.jsonl(토큰. tools/gemini.sh 실행분도 여기에 쌓인다)
 *
 * 보안: 127.0.0.1에만 열고 Host 헤더를 확인한다(DNS 리바인딩 방지). 작업을 시키는 요청은
 *       서버가 켜질 때 만든 비밀값(X-Collab-Token)과 Origin이 맞아야 한다(다른 웹사이트가 몰래 시키지 못하게).
 *       미리보기 파일은 sandbox로 열어 비밀값을 읽지 못하게 한다. git commit·push는 어느 쪽에도 허용하지 않는다.
 */
'use strict';
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var cp = require('child_process');
var crypto = require('crypto');

var ROOT = path.resolve(__dirname, '..', '..');
var PORT = +(process.env.COLLAB_PORT || 8787);
var TOKEN = crypto.randomBytes(16).toString('hex');
var GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-4-neon-high';
var CLAUDE_MODEL = process.env.CLAUDE_MODEL || '';            // 비우면 Claude Code 기본 모델
var MAX_HANDOFF = 2;
var JOB_TIMEOUT_MS = 30 * 60 * 1000;

var DIRS = {
  briefs: path.join(ROOT, 'docs', 'design', 'briefs'),
  out: path.join(ROOT, 'docs', 'design', 'mockups', 'wide'),
  logs: path.join(ROOT, 'logs', 'gemini'),
  center: path.join(ROOT, 'logs', 'collab'),
  brain: path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain')
};
fs.mkdirSync(DIRS.center, { recursive: true });
var JOBS_FILE = path.join(DIRS.center, 'jobs.jsonl');
var LEDGER_FILE = path.join(DIRS.center, 'ledger.jsonl');

/* ---------------- 공통 도우미 ---------------- */
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
function readJsonl(file, max) {
  return readText(file, max || 2000000).split('\n').filter(Boolean).map(function (l) { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
}
function appendJsonl(file, obj) { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
function short(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
function dayKey(ms) { var d = new Date(ms); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }

/* ---------------- 실행 파일 찾기 ---------------- */
function onPath(name) {
  try {
    var out = cp.execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split(/\r?\n/).filter(Boolean)[0] || '';
  } catch (e) { return ''; }
}
function findClaude() {
  if (process.env.CLAUDE_BIN && fs.existsSync(process.env.CLAUDE_BIN)) return process.env.CLAUDE_BIN;
  var p = onPath('claude'); if (p) return p;
  // 데스크톱 앱에 들어 있는 Claude Code (버전 폴더가 바뀌므로 가장 최근 것)
  var base = path.join(process.env.LOCALAPPDATA || '', 'Claude-Data');
  var found = [];
  list(base).filter(function (d) { return d.dir && /^claude_/.test(d.name); }).forEach(function (d) {
    var cc = path.join(base, d.name, 'claude-code');
    list(cc).forEach(function (v) {
      list(path.join(cc, v.name)).forEach(function (h) {
        var exe = path.join(cc, v.name, h.name, 'claude.exe');
        try { found.push({ p: exe, t: fs.statSync(exe).mtimeMs }); } catch (e) {}
      });
    });
  });
  found.sort(function (a, b) { return b.t - a.t; });
  return found.length ? found[0].p : '';
}
function findAgy() {
  var p = onPath('agy'); if (p) return p;
  var c = path.join(os.homedir(), '.gemini', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy');
  return fs.existsSync(c) ? c : '';
}
var BIN = { claude: findClaude(), gemini: findAgy() };
var NAME = { claude: 'Claude', gemini: '제미나이' };
var OTHER = { claude: 'gemini', gemini: 'claude' };
var agentState = { claude: { problem: BIN.claude ? '' : '실행 파일 없음', problemAt: 0, lastSession: '' }, gemini: { problem: BIN.gemini ? '' : '실행 파일 없음', problemAt: 0, lastSession: '' } };
var PROBLEM_TTL = 10 * 60 * 1000;   // 로그인·한도 문제는 10분 뒤 다시 시도해 본다(그사이 로그인했을 수 있으므로)
function setProblem(a, p) { agentState[a].problem = p; agentState[a].problemAt = p ? Date.now() : 0; }
function problemOf(a) {
  var st = agentState[a];
  if (st.problem && st.problemAt && Date.now() - st.problemAt > PROBLEM_TTL) setProblem(a, '');
  return st.problem;
}

/* ---------------- 토큰 장부 ---------------- */
/* 비교 기준(weighted): 입력 + 출력 + 캐시 생성 + 캐시 읽기×0.1 — Claude Code는 매번 긴 기본 지시문을 캐시에서 읽으므로 그대로 더하면 불공평하다 */
function weighted(u) { return Math.round((u.input || 0) + (u.output || 0) + (u.cacheWrite || 0) + (u.cacheRead || 0) * 0.1); }
function todayUsage() {
  var today = dayKey(Date.now()), sum = { claude: { tokens: 0, runs: 0, cost: 0 }, gemini: { tokens: 0, runs: 0, cost: 0 } };
  readJsonl(LEDGER_FILE).forEach(function (e) {
    if (!sum[e.agent] || dayKey(e.at) !== today) return;
    sum[e.agent].tokens += e.weighted || 0; sum[e.agent].runs++; sum[e.agent].cost += e.cost || 0;
  });
  return sum;
}

/* ---------------- 작업 줄 ---------------- */
var jobs = readJsonl(JOBS_FILE).slice(-80);          // 지난 기록(끝난 것)
var queue = [];
var running = null;
var seq = Date.now();

function available(agent) { return !!BIN[agent] && !problemOf(agent); }

function pickAgent(target, prefer) {
  var u = todayUsage();
  var txt = 'Claude ' + u.claude.tokens.toLocaleString() + ' / 제미나이 ' + u.gemini.tokens.toLocaleString();
  if (target === 'claude' || target === 'gemini') return { agent: target, reason: '직접 지정 (오늘 ' + txt + ')' };
  if (prefer) {   // 상대가 넘긴 일: 받을 쪽이 못 하면 넘긴 쪽이 이어서 한다
    if (available(prefer)) return { agent: prefer, reason: NAME[OTHER[prefer]] + '가 넘긴 일 → ' + NAME[prefer] };
    return { agent: OTHER[prefer], reason: NAME[prefer] + ' 사용 불가(' + (problemOf(prefer) || '?') + ') → 넘긴 ' + NAME[OTHER[prefer]] + '가 직접' };
  }
  if (!available('claude') && available('gemini')) return { agent: 'gemini', reason: 'Claude 사용 불가(' + (agentState.claude.problem || '?') + ') → 제미나이' };
  if (!available('gemini') && available('claude')) return { agent: 'claude', reason: '제미나이 사용 불가(' + (agentState.gemini.problem || '?') + ') → Claude' };
  var a = u.claude.tokens < u.gemini.tokens ? 'claude' : 'gemini';     // 같으면 제미나이(더 저렴)
  return { agent: a, reason: '오늘 토큰 ' + txt + ' → 덜 쓴 ' + NAME[a] };
}

function newJob(o) {
  var j = {
    id: 'j' + (seq++).toString(36), at: Date.now(), prompt: o.prompt, target: o.target || 'auto', cont: !!o.cont,
    parent: o.parent || '', depth: o.depth || 0, from: o.from || 'user', prefer: o.prefer || '', status: 'queued',
    agent: '', reason: '', reply: '', error: '', usage: null, weighted: 0, cost: 0, files: [], started: 0, ended: 0, handoff: '', tries: []
  };
  queue.push(j);
  jobs.push(j);
  setImmediate(pump);
  return j;
}

function gitStatus() {
  try { return cp.execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', windowsHide: true }).split('\n').filter(Boolean); } catch (e) { return []; }
}

function preamble(agent, job) {
  var u = todayUsage(), me = u[agent].tokens, you = u[OTHER[agent]].tokens;
  var lines = [
    '너는 "사장님 도우미" 저장소(' + ROOT + ')에서 Claude와 제미나이가 함께 일하는 팀의 ' + NAME[agent] + '다.',
    '사용자는 협업 센터 입력창 하나로 둘에게 일을 주고, 둘의 답을 같은 로그 창에서 본다.',
    '',
    '[규칙]',
    '- 먼저 CLAUDE.md를 읽고 그 규칙을 따른다. 답은 한국어로 짧고 구체적으로.',
    '- git commit·push·브랜치 변경은 하지 않는다(커밋은 사용자 대화창의 Claude가 검토 후에 한다).',
    '- 파일을 고쳤다면 무엇을 왜 고쳤는지 파일 경로와 함께 적는다. 앱 코드(web/, src/, server/)는 계산·동기화·보안을 바꾸지 않는다.',
    '- 구글 로그인·OAuth·비밀번호 입력은 하지 않는다.'
  ];
  if (agent === 'gemini') lines.push('- 터미널(셸) 명령은 실행하지 않는다(무인 실행이라 자동 거부되고 작업이 멈춘다). 파일 도구만 쓴다.');
  lines.push('', '[오늘 토큰] 너 ' + me.toLocaleString() + ' · 상대(' + NAME[OTHER[agent]] + ') ' + you.toLocaleString());
  if (job.depth < MAX_HANDOFF) {
    lines.push('[넘기기] 일을 나눌 수 있고 상대가 덜 썼다면, 상대가 혼자 할 수 있는 부분(큰 파일 작성, 검토 등)을 넘겨도 된다.',
      '넘길 때는 답의 맨 마지막 줄에 정확히 한 줄: `@' + (agent === 'claude' ? '제미나이' : 'claude') + ': <구체적인 할 일>`. 넘길 게 없으면 쓰지 않는다.');
  }
  if (job.parent) {
    var p = jobs.filter(function (x) { return x.id === job.parent; })[0];
    if (p) lines.push('', '[앞 단계] ' + NAME[p.agent] + '가 너에게 넘긴 일이다. 그 답 요약:', short(p.reply, 2500));
  }
  lines.push('', '[요청]', job.prompt);
  return lines.join('\n');
}

function claudeArgs(prompt, job) {
  var a = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'acceptEdits',
    '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(node tests/*),Bash(node tools/*),Bash(git status*),Bash(git diff*),Bash(git log*)'];
  if (CLAUDE_MODEL) a.push('--model', CLAUDE_MODEL);
  if (job.cont && agentState.claude.lastSession) a.push('--resume', agentState.claude.lastSession);
  return a;
}
function geminiArgs(prompt, job) {
  var a = ['-p', prompt, '--model', GEMINI_MODEL, '--mode', 'accept-edits', '--output-format', 'json', '--add-dir', ROOT, '--print-timeout', '1500s'];
  if (job.cont && agentState.gemini.lastSession) a.push('--conversation', agentState.gemini.lastSession);
  return a;
}

/* stdout에서 마지막 JSON 객체를 꺼낸다 */
function lastJson(s) {
  var lines = String(s || '').split(/\r?\n/).filter(function (l) { return /^\s*\{/.test(l); });
  for (var i = lines.length - 1; i >= 0; i--) { try { return JSON.parse(lines[i]); } catch (e) {} }
  try { return JSON.parse(s); } catch (e) { return null; }
}

function parseResult(agent, stdout, stderr, err) {
  var j = lastJson(stdout);
  var r = { ok: false, reply: '', usage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, cost: 0, session: '', problem: '' };
  if (agent === 'claude' && j) {
    var u = j.usage || {};
    r.usage = { input: u.input_tokens || 0, output: u.output_tokens || 0, cacheWrite: u.cache_creation_input_tokens || 0, cacheRead: u.cache_read_input_tokens || 0 };
    r.cost = j.total_cost_usd || 0; r.session = j.session_id || '';
    r.reply = j.result || '';
    r.ok = !j.is_error;
    if (/not logged in|\/login/i.test(r.reply)) r.problem = '로그인 필요';
    else if (/limit|quota|rate/i.test(r.reply) && !r.ok) r.problem = '사용 한도';
  } else if (agent === 'gemini' && j) {
    var g = j.usage || {};
    r.usage = { input: g.input_tokens || 0, output: (g.output_tokens || 0) + (g.thinking_tokens || 0), cacheWrite: 0, cacheRead: g.cache_read_tokens || 0 };
    r.session = j.conversation_id || '';
    r.reply = j.response || '';
    r.ok = j.status === 'SUCCESS' && !!r.reply;
    if (/no output produced/i.test(stdout + stderr)) r.problem = '';
  }
  if (!j) {
    r.reply = short((stdout || '') + '\n' + (stderr || ''), 2000) || (err ? String(err.message || err) : '응답 없음');
    if (/not logged in|login/i.test(r.reply)) r.problem = '로그인 필요';
  }
  if (err && err.killed) r.reply = (r.reply ? r.reply + '\n' : '') + '(시간 초과 또는 멈춤으로 중단됨)';
  return r;
}

var child = null;
function runAgent(agent, job, done) {
  var prompt = preamble(agent, job);
  var args = agent === 'claude' ? claudeArgs(prompt, job) : geminiArgs(prompt, job);
  child = cp.execFile(BIN[agent], args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: JOB_TIMEOUT_MS, windowsHide: true },
    function (err, stdout, stderr) { child = null; done(parseResult(agent, stdout, stderr, err)); });
}

function pump() {
  if (running || !queue.length) return;
  var job = queue.shift();
  running = job;
  var pick = pickAgent(job.target, job.prefer);
  job.agent = pick.agent; job.reason = pick.reason; job.status = 'running'; job.started = Date.now();
  var before = gitStatus();
  (function attempt(agent) {
    job.agent = agent;
    job.tries.push(agent);
    runAgent(agent, job, function (r) {
      var entry = { at: Date.now(), agent: agent, source: 'center', job: job.id, usage: r.usage, weighted: weighted(r.usage), cost: r.cost };
      if (entry.weighted > 0) appendJsonl(LEDGER_FILE, entry);
      job.usage = r.usage; job.weighted = (job.weighted || 0) + entry.weighted; job.cost = (job.cost || 0) + (r.cost || 0);
      if (r.session) agentState[agent].lastSession = r.session;
      if (r.problem) setProblem(agent, r.problem);
      else if (r.ok) setProblem(agent, '');
      // 자동 배정이었고 실패했으면 다른 쪽으로 한 번 넘긴다
      if (!r.ok && job.target === 'auto' && job.tries.length < 2 && available(OTHER[agent])) {
        job.reason += ' · ' + NAME[agent] + ' 실패(' + (r.problem || short(r.reply, 60)) + ') → ' + NAME[OTHER[agent]] + '로 바꿈';
        return attempt(OTHER[agent]);
      }
      job.reply = r.reply; job.status = r.ok ? 'done' : 'failed'; job.error = r.ok ? '' : (r.problem || '실패');
      job.ended = Date.now();
      var after = gitStatus();
      job.files = after.filter(function (l) { return before.indexOf(l) < 0; }).map(function (l) { return l.slice(3); });
      // 넘기기: 답의 마지막 줄이 @상대: 할 일
      var m = parseHandoff(job.reply);
      if (r.ok && m && job.depth < MAX_HANDOFF) {
        var to = /claude|클로드/i.test(m[1]) ? 'claude' : 'gemini';
        if (to !== agent) {
          job.handoff = to;
          newJob({ prompt: m[2].trim(), target: 'auto', prefer: to, parent: job.id, depth: job.depth + 1, from: agent });
        }
      }
      appendJsonl(JOBS_FILE, job);
      running = null;
      setImmediate(pump);
    });
  })(pick.agent);
}

/* 답의 마지막 줄이 `@상대: 할 일` 이면 넘기기. 할 일 안에 백틱(파일 경로)이 있어도 된다 */
function parseHandoff(reply) {
  var lines = String(reply || '').trim().split(/\r?\n/);
  var last = (lines[lines.length - 1] || '').trim().replace(/^`|`$/g, '');
  var m = /^@(claude|클로드|제미나이|gemini)\s*[:：]\s*(.+)$/i.exec(last);
  return m && m[2].trim().length > 3 ? m : null;
}

function stopRunning() {
  if (!child) return false;
  try {
    if (process.platform === 'win32') cp.execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  } catch (e) {}
  return true;
}

/* ---------------- 제미나이 실시간 활동 (brain/transcript) ---------------- */
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
var TOOL_KO = { read_file: '파일 읽기', write_file: '파일 쓰기', write_to_file: '파일 쓰기', replace_file_content: '파일 고치기',
  edit_file: '파일 고치기', list_dir: '폴더 보기', list_directory: '폴더 보기', find_by_name: '파일 찾기', grep_search: '내용 찾기',
  view_file: '파일 읽기', run_command: '명령 실행' };
function activity(file) {
  var out = [];
  readText(file, 400000).split('\n').filter(Boolean).slice(-40).forEach(function (ln) {
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
    }
  });
  return out.slice(-15).reverse();
}
function latestBrain() {
  var dirs = list(DIRS.brain).filter(function (d) { return d.dir; }).sort(function (a, b) { return b.mtime - a.mtime; }).slice(0, 3);
  for (var i = 0; i < dirs.length; i++) {
    var base = path.join(DIRS.brain, dirs[i].name);
    var feed = activity(path.join(base, '.system_generated', 'logs', 'transcript.jsonl'));
    if (feed.length || i === dirs.length - 1) return { id: dirs[i].name, mtime: dirs[i].mtime, feed: feed };
  }
  return null;
}

/* ---------------- 상태 ---------------- */
function designProgress(outs) {
  var logs = list(DIRS.logs, function (n) { return /\.log$/.test(n); });
  return ['I', 'J', 'K', 'L', 'M'].map(function (v) {
    var made = ['Punch', 'Pay', 'Chk', 'QR', 'Set'].filter(function (p) { return outs.some(function (o) { return o.name === v + '_' + p + '.html'; }); });
    return { v: v, made: made, ran: logs.some(function (l) { return l.name.indexOf('_wide_' + v) > 0; }) };
  });
}
function publicJob(j) {
  return { id: j.id, at: j.at, prompt: j.prompt, target: j.target, prefer: j.prefer, cont: j.cont, parent: j.parent, depth: j.depth, from: j.from, status: j.status,
    agent: j.agent, reason: j.reason, reply: j.reply, error: j.error, weighted: j.weighted, cost: j.cost, files: j.files, started: j.started, ended: j.ended, handoff: j.handoff };
}
function state() {
  var outs = list(DIRS.out, function (n) { return /\.html$/.test(n); });
  var u = todayUsage();
  var gr = geminiRunning();
  return {
    now: Date.now(),
    agents: ['claude', 'gemini'].map(function (a) {
      return { id: a, name: NAME[a], bin: !!BIN[a], problem: problemOf(a), busy: !!(running && running.agent === a) || (a === 'gemini' && gr > 0 && !running),
        today: u[a], canContinue: !!agentState[a].lastSession };
    }),
    next: pickAgent('auto'),
    running: running ? publicJob(running) : null,
    queue: queue.map(publicJob),
    jobs: jobs.slice(-60).map(publicJob),
    gemini: { running: gr, brain: latestBrain() },
    outputs: outs.sort(function (a, b) { return b.mtime - a.mtime; }).slice(0, 12),
    design: designProgress(outs),
    briefs: list(DIRS.briefs, function (n) { return /\.md$/.test(n); }),
    logs: list(DIRS.logs, function (n) { return /\.log$/.test(n); }).sort(function (a, b) { return b.mtime - a.mtime; }).slice(0, 10),
    review: readText(path.join(DIRS.logs, 'review.md'), 20000)
  };
}

/* ---------------- HTTP ---------------- */
var HOSTS = ['127.0.0.1:' + PORT, 'localhost:' + PORT];
var ORIGINS = HOSTS.map(function (h) { return 'http://' + h; });
var TYPES = { '.html': 'text/html; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8' };
var PAGE_FILE = path.join(__dirname, 'page.html');

function send(res, code, type, body, extra) {
  var h = Object.assign({ 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }, extra || {});
  res.writeHead(code, h); res.end(body);
}
/* 미리보기 파일: 정해진 폴더 안만, sandbox(스크립트는 되지만 이 서버의 비밀값·API는 못 씀) */
function safePath(rel) {
  rel = String(rel || '').replace(/\\/g, '/');
  if (!rel || rel.indexOf('..') >= 0 || /^\//.test(rel) || /:/.test(rel)) return null;
  if (!/^(docs|web)\//.test(rel) && !/^logs\/gemini\/[^/]+\.(log|md)$/.test(rel)) return null;
  var p = path.join(ROOT, rel);
  if (p.indexOf(ROOT + path.sep) !== 0 || !fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return TYPES[path.extname(p).toLowerCase()] ? p : null;
}
function readBody(req, cb) {
  var size = 0, chunks = [];
  req.on('data', function (c) { size += c.length; if (size > 100000) { req.destroy(); return; } chunks.push(c); });
  req.on('end', function () { try { cb(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { cb(null); } });
}

var server = http.createServer(function (req, res) {
  if (HOSTS.indexOf(String(req.headers.host || '')) < 0) return send(res, 421, 'text/plain; charset=utf-8', '잘못된 Host');
  var u = new URL(req.url, 'http://127.0.0.1');

  if (req.method === 'POST') {
    var origin = req.headers.origin;
    if (req.headers['x-collab-token'] !== TOKEN || (origin && ORIGINS.indexOf(origin) < 0)) return send(res, 403, 'text/plain; charset=utf-8', '권한 없음');
    if (u.pathname === '/api/ask') {
      return readBody(req, function (b) {
        var prompt = b && typeof b.prompt === 'string' ? b.prompt.trim() : '';
        if (!prompt || prompt.length > 20000) return send(res, 400, 'application/json', JSON.stringify({ error: '요청 내용이 비었거나 너무 깁니다' }));
        var target = ['auto', 'claude', 'gemini'].indexOf(b.target) >= 0 ? b.target : 'auto';
        var j = newJob({ prompt: prompt, target: target, cont: !!b.cont });
        send(res, 200, 'application/json', JSON.stringify({ id: j.id }));
      });
    }
    if (u.pathname === '/api/stop') return send(res, 200, 'application/json', JSON.stringify({ stopped: stopRunning() }));
    if (u.pathname === '/api/clear-problem') {
      ['claude', 'gemini'].forEach(function (a) { setProblem(a, BIN[a] ? '' : '실행 파일 없음'); });
      return send(res, 200, 'application/json', '{"ok":true}');
    }
    return send(res, 404, 'text/plain; charset=utf-8', '없음');
  }

  if (u.pathname === '/api/state') return send(res, 200, 'application/json; charset=utf-8', JSON.stringify(state()));
  if (u.pathname === '/file' || /^\/out\//.test(u.pathname)) {
    var rel = u.pathname === '/file' ? u.searchParams.get('p') : 'docs/design/mockups/wide/' + decodeURIComponent(u.pathname.slice(5));
    var f = safePath(rel);
    if (!f) return send(res, 404, 'text/plain; charset=utf-8', '없음');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(f).toLowerCase()], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox allow-scripts', 'Referrer-Policy': 'no-referrer' });
    return fs.createReadStream(f).pipe(res);
  }
  if (u.pathname === '/') {
    var html = readText(PAGE_FILE).replace('__COLLAB_TOKEN__', TOKEN);
    return send(res, 200, 'text/html; charset=utf-8', html, { 'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
  }
  send(res, 404, 'text/plain; charset=utf-8', '없음');
});

server.listen(PORT, '127.0.0.1', function () {
  console.log('협업 센터: http://127.0.0.1:' + PORT + '  (끄려면 Ctrl+C)');
  console.log('Claude: ' + (BIN.claude || '없음'));
  console.log('제미나이: ' + (BIN.gemini || '없음') + ' (모델 ' + GEMINI_MODEL + ')');
});
