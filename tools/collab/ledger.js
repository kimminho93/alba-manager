#!/usr/bin/env node
/*
 * tools/collab/ledger.js <agy JSON 로그> [지시서]
 * tools/gemini.sh가 부른다. 제미나이 JSON 결과에서
 *   1) 응답 글을 <로그>.txt 로 저장하고
 *   2) 토큰을 logs/collab/ledger.jsonl 에 쌓는다(협업 센터의 토큰 비교에 쓰임)
 * 성공이면 "ok", 아니면 "fail"을 출력한다.
 */
'use strict';
var fs = require('fs');
var path = require('path');
var log = process.argv[2], brief = process.argv[3] || '';
var raw = ''; try { raw = fs.readFileSync(log, 'utf8'); } catch (e) {}
var j = null;
raw.split(/\r?\n/).filter(function (l) { return /^\s*\{/.test(l); }).forEach(function (l) { try { j = JSON.parse(l); } catch (e) {} });
if (!j) { try { j = JSON.parse(raw); } catch (e) {} }
if (!j) { process.stdout.write('fail'); process.exit(0); }
fs.writeFileSync(log + '.txt', String(j.response || ''));
var u = j.usage || {};
var usage = { input: u.input_tokens || 0, output: (u.output_tokens || 0) + (u.thinking_tokens || 0), cacheWrite: 0, cacheRead: u.cache_read_tokens || 0 };
var weighted = Math.round(usage.input + usage.output + usage.cacheRead * 0.1);
if (weighted > 0) {
  var dir = path.resolve(__dirname, '..', '..', 'logs', 'collab');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, 'ledger.jsonl'), JSON.stringify({ at: Date.now(), agent: 'gemini', source: 'gemini.sh', brief: brief, usage: usage, weighted: weighted, cost: 0 }) + '\n');
}
process.stdout.write(j.status === 'SUCCESS' && j.response ? 'ok' : 'fail');
