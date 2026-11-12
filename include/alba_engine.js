/*
 * include/alba_engine.js — 엔진 공개 API "헤더" (Node 전용 진입점)
 * server/app.js, src/main.js, tests/*.js 가 이 파일 하나만 require 합니다.
 * 브라우저에서는 tools/build.js 가 src/*.js 를 합친 web/engine.js 를 사용합니다.
 */
'use strict';

module.exports = Object.assign(
  {},
  require('../src/i18n.js'),
  require('../src/lang_en.js'),
  require('../src/math_ops.js'),
  require('../src/stats.js'),
  require('../src/parser.js'),
  require('../src/payroll.js'),
  require('../src/checklist.js'),
  require('../src/workers.js'),
  require('../src/backup.js'),
  require('../src/xlsx.js'),
  require('../src/reports.js')
);

