/*
 * src/backup.js — 백업 파일(.json) 만들기 / 읽기
 *   구글 계정이 바뀌거나 기기를 옮길 때 기록(정산 명단·점검 보관함·빠른 시간대·매장 정보)을 파일로 옮긴다.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./payroll.js'), require('./checklist.js'));
  } else {
    root.AlbaEngine = root.AlbaEngine || {};
    Object.assign(root.AlbaEngine, factory(root.AlbaEngine, root.AlbaEngine));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P, C) {
  'use strict';

  var APP = 'alba-manager';
  var VERSION = 1;
  var MAX_BYTES = 5 * 1024 * 1024;
  var MAX_ROSTER = 500;
  var MAX_ARCHIVE = 3700;

  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

  /** 백업 파일 내용(문자열)을 만든다. data = { roster, archive, presets, store } */
  function buildBackup(data, now) {
    data = data || {};
    return JSON.stringify({
      app: APP,
      version: VERSION,
      exportedAt: new Date(now === undefined ? Date.now() : now).toISOString(),
      data: {
        roster: Array.isArray(data.roster) ? data.roster : [],
        archive: Array.isArray(data.archive) ? data.archive : [],
        presets: Array.isArray(data.presets) ? data.presets : [],
        store: isObj(data.store) ? data.store : {}
      }
    }, null, 2);
  }

  function backupFileName(now) {
    var d = new Date(now === undefined ? Date.now() : now);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return '사장님도우미_백업_' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.json';
  }

  /** 백업 파일 내용을 읽어 검사한다. → { ok, data, counts } | { ok:false, error } */
  function parseBackup(text) {
    if (typeof text !== 'string' || !text.trim()) return { ok: false, error: '비어 있는 파일입니다.' };
    if (text.length > MAX_BYTES) return { ok: false, error: '파일이 너무 큽니다.' };
    var obj;
    try { obj = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { return { ok: false, error: '백업 파일이 아닙니다. (읽을 수 없는 파일)' }; }
    if (!isObj(obj) || obj.app !== APP || !isObj(obj.data)) return { ok: false, error: '사장님 도우미 백업 파일이 아닙니다.' };
    if (Number(obj.version) > VERSION) return { ok: false, error: '더 새로운 버전의 백업 파일입니다. 앱을 새로고침한 뒤 다시 시도해 주세요.' };

    var d = obj.data;
    var roster = Array.isArray(d.roster) ? d.roster : [];
    var archive = Array.isArray(d.archive) ? d.archive : [];
    var presets = Array.isArray(d.presets) ? d.presets : [];
    var store = isObj(d.store) ? d.store : {};
    if (roster.length > MAX_ROSTER || archive.length > MAX_ARCHIVE) return { ok: false, error: '기록이 너무 많은 파일입니다.' };

    // 실제로 계산할 수 있는 항목만 받는다 (깨진 항목이 화면을 망치지 않도록)
    var okRoster = roster.filter(function (x) {
      if (!isObj(x)) return false;
      try { P.calculatePayroll(x); return true; } catch (e) { return false; }
    });
    var okArchive = archive.filter(function (x) {
      if (!isObj(x)) return false;
      try { C.buildChecklist(x); return true; } catch (e) { return false; }
    });
    var okPresets = presets.filter(function (p) {
      return isObj(p) && /^\d{1,2}:\d{2}$/.test(String(p.start)) && /^\d{1,2}:\d{2}$/.test(String(p.end));
    });
    var okStore = {
      store: typeof store.store === 'string' ? store.store.slice(0, 40) : '',
      inspector: typeof store.inspector === 'string' ? store.inspector.slice(0, 20) : ''
    };

    return {
      ok: true,
      data: { roster: okRoster, archive: okArchive, presets: okPresets, store: okStore },
      counts: { roster: okRoster.length, archive: okArchive.length, skipped: (roster.length - okRoster.length) + (archive.length - okArchive.length) },
      exportedAt: typeof obj.exportedAt === 'string' ? obj.exportedAt : ''
    };
  }

  return { buildBackup: buildBackup, backupFileName: backupFileName, parseBackup: parseBackup };
});
