/*
 * src/i18n.js — 언어(한국어/English) 선택과 번역 도우미
 *   - 원문(한국어) 문장 자체를 키로 씁니다.  t('{n}명', {n: 3})  →  ko: "3명" / en: "3 staff"
 *   - 영어 사전에 없는 문장은 한국어 그대로 나옵니다(화면이 비지 않도록).
 *   - 각 모듈은 자기 영어 사전을 add() 로 등록합니다.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AlbaEngine = root.AlbaEngine || {};
    Object.assign(root.AlbaEngine, factory());
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var LANG = 'ko';
  var DICT = {};
  var PATS = [];   // [정규식, 영어 치환(문자열 또는 함수)] — 숫자가 섞인 짧은 문구용(예: '3명')

  function setLang(l) { LANG = (l === 'en') ? 'en' : 'ko'; return LANG; }
  function getLang() { return LANG; }
  function add(map) { for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k)) DICT[k] = map[k]; }
  function addPatterns(list) { list.forEach(function (p) { PATS.push(p); }); }
  function has(ko) { return Object.prototype.hasOwnProperty.call(DICT, ko); }
  function t(ko, vars) {
    var s = ko;
    if (LANG === 'en') {
      if (has(ko)) s = DICT[ko];
      else if (typeof ko === 'string') {
        for (var i = 0; i < PATS.length; i++) if (PATS[i][0].test(ko)) { s = ko.replace(PATS[i][0], PATS[i][1]); break; }
      }
    }
    if (vars) s = s.replace(/\{(\w+)\}/g, function (m, k) { return vars[k] === undefined ? m : String(vars[k]); });
    return s;
  }
  /** 브라우저 언어가 한국어가 아니면 'en' (navigator.language 값을 넘겨 받음) */
  function detectLang(navLang) { return /^ko\b/i.test(String(navLang || '')) ? 'ko' : 'en'; }

  return { setLang: setLang, getLang: getLang, addDict: add, addPatterns: addPatterns, hasText: has, t: t, detectLang: detectLang };
});
