#!/usr/bin/env node
/* 개발용: 번역 사전에 없는 한국어 문구를 찾습니다.  node tools/i18n_scan.js [파일...] */
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const I = require('../src/i18n.js');
require('../src/lang_en.js');
try { require('../web/lang_web.js'); } catch (e) { /* 아직 없음 */ }
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['src/payroll.js','src/checklist.js','src/workers.js','src/backup.js','src/reports.js'];
const STRICT = /(?:\bt|\bP\.t|\bM\.t|\bH|\bT|\bB|\bP|\bTITLE|\bS\s*\(\s*'[A-Za-z]+'\s*,\s*|tx)\s*\(?\s*'((?:[^'\\]|\\.)*[가-힣](?:[^'\\]|\\.)*)'/g;
const LOOSE = /'((?:[^'\\]|\\.)*[가-힣](?:[^'\\]|\\.)*)'/g;   // LOOSE=1: 한글이 든 작은따옴표 문자열 전부
const re = process.env.LOOSE ? LOOSE : STRICT;
I.setLang('en');
const miss = new Set();
for (const f of files) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).map((l) => l.replace(/\s\/\/.*$/, '')).join('\n');
  let m;
  while ((m = re.exec(src))) {
    const k = m[1].replace(/\\'/g, "'");
    if (I.t(k) === k) miss.add(k);
  }
}
miss.forEach((k) => console.log(k));
console.error('누락 ' + miss.size + '개');
