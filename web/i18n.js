/*
 * web/i18n.js — 화면 언어(한국어 / English) 전환
 *   - 처음에는 브라우저 언어를 따라가고(한국어가 아니면 English), 🌐 버튼이나 설정에서 바꾸면 기억합니다.
 *   - 화면에 이미 적힌 한국어(index.html)는 영어 사전(lang_web.js)으로 바꿔 끼우고, 한국어로 돌아올 때는 원문을 복원합니다.
 *   - 앱이 나중에 만들어 넣는 화면 조각도 MutationObserver 로 같은 방식으로 번역합니다.
 *   - 문장 번역 자체는 엔진의 E.t(원문, 변수) 를 씁니다. 영어 사전에 없으면 한국어가 그대로 나옵니다.
 */
(function () {
  'use strict';
  var E = window.AlbaEngine;
  if (!E || !E.t) return;

  var KEY = 'alba.lang';
  var HANGUL = /[가-힣]/;
  var INLINE = { B: 1, STRONG: 1, I: 1, EM: 1, SPAN: 1, KBD: 1, CODE: 1, U: 1, SMALL: 1, MARK: 1, BR: 1, A: 1, SUP: 1, SUB: 1 };
  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, SVG: 1, NOSCRIPT: 1 };
  var ATTRS = ['aria-label', 'placeholder', 'title', 'alt'];

  var collecting = null;   // 개발용: 번역 사전에 없는 문구 수집
  function look(k) { if (collecting) { if (E.t(k) === k) collecting[k] = 1; return k; } return E.t(k); }
  var saved = [];          // 번역하면서 지운 원문: { el|node, html|text|attr, ko }
  var observer = null;

  function norm(s) { return String(s).replace(/\s+/g, ' ').trim(); }

  function stored() {
    try { var v = localStorage.getItem(KEY); return v === 'en' || v === 'ko' ? v : null; } catch (e) { return null; }
  }
  function get() { return E.getLang(); }

  /* 안에 아이디가 붙은 조각이 없고 인라인 태그뿐이면, 그 요소 전체를 한 문장으로 번역 */
  function inlineOnly(el) {
    for (var i = 0; i < el.children.length; i++) {
      var c = el.children[i];
      if (!INLINE[c.tagName] || c.id || !inlineOnly(c)) return false;
    }
    return true;
  }

  function tAttrs(el) {
    for (var i = 0; i < ATTRS.length; i++) {
      var a = ATTRS[i], v = el.getAttribute && el.getAttribute(a);
      if (v && HANGUL.test(v)) {
        var en = look(norm(v));
        if (en !== norm(v)) { saved.push({ el: el, attr: a, ko: v }); el.setAttribute(a, en); }
      }
    }
  }

  function tText(node) {
    var v = node.nodeValue;
    if (!v || !HANGUL.test(v)) return;
    var core = norm(v);
    var en = look(core);
    if (en === core) return;
    saved.push({ node: node, ko: v });
    node.nodeValue = v.replace(/\S[\s\S]*\S|\S/, function () { return en; });
  }

  function tEl(el) {
    if (!el || el.nodeType !== 1 || SKIP[el.tagName.toUpperCase()] || el.hasAttribute('data-no-i18n')) return;
    tAttrs(el);
    if (el.hasAttribute('data-en')) {   // 같은 한글이 문맥마다 다르게 번역돼야 할 때(요일 등)
      if (!collecting) { saved.push({ el: el, html: el.innerHTML }); el.textContent = el.getAttribute('data-en'); }
      return;
    }
    if (HANGUL.test(el.textContent) && inlineOnly(el)) {
      var key = norm(el.innerHTML);
      var en = look(key);
      if (collecting) { if (en === key) return; }
      if (en !== key) { saved.push({ el: el, html: el.innerHTML }); el.innerHTML = en; return; }
      if (!el.children.length) { // 숫자 섞인 짧은 문구('3명')는 패턴으로
        var tx = norm(el.textContent), en2 = look(tx);
        if (en2 !== tx) { saved.push({ el: el, html: el.innerHTML }); el.textContent = en2; return; }
      }
    }
    for (var n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3) tText(n);
      else if (n.nodeType === 1) tEl(n);
    }
  }

  function translateAll() {
    tEl(document.body);
    var m = document.querySelector('meta[name="description"]');
    document.title = look(document.title);
    if (m) tAttrsMeta(m);
    document.querySelectorAll('meta[property="og:title"],meta[property="og:description"]').forEach(tAttrsMeta);
  }
  function tAttrsMeta(m) {
    var v = m.getAttribute('content');
    if (v && HANGUL.test(v)) { var en = look(norm(v)); if (en !== norm(v)) { saved.push({ el: m, attr: 'content', ko: v }); m.setAttribute('content', en); } }
  }

  function restoreAll() {
    for (var i = saved.length - 1; i >= 0; i--) {
      var s = saved[i];
      if (s.attr) s.el.setAttribute(s.attr, s.ko);
      else if (s.node) s.node.nodeValue = s.ko;
      else if (s.el) s.el.innerHTML = s.html;
    }
    saved = [];
  }

  /* 앱이 나중에 넣는 조각(달력, 명단, 알림 등)도 번역 */
  function watch() {
    if (observer || !window.MutationObserver) return;
    observer = new MutationObserver(function (list) {
      if (get() !== 'en') return;
      list.forEach(function (r) {
        r.addedNodes.forEach(function (n) {
          if (n.nodeType === 3) {
            var p = n.parentNode;
            if (p && p.nodeType === 1 && !SKIP[p.tagName.toUpperCase()]) tText(n);
          } else if (n.nodeType === 1) tEl(n);
        });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  function apply(lang, persist) {
    var cur = get();
    if (persist) { try { localStorage.setItem(KEY, lang); } catch (e) {} }
    if (cur === 'en' && lang !== 'en') restoreAll();
    E.setLang(lang);
    document.documentElement.setAttribute('lang', lang);
    if (lang === 'en') { restoreAll(); translateAll(); watch(); }
    syncControls();
    window.dispatchEvent(new CustomEvent('alba:lang', { detail: { lang: lang } }));
  }

  function syncControls() {
    var l = get();
    var b = document.getElementById('langBtn');
    if (b) { b.textContent = l === 'en' ? '🌐 한국어' : '🌐 EN'; b.setAttribute('data-no-i18n', ''); b.title = l === 'en' ? '한국어로 보기' : 'View in English'; }
    var sel = document.getElementById('sLang');
    if (sel) sel.value = l;
  }

  function init() {
    var lang = stored() || E.detectLang(navigator.language || (navigator.languages && navigator.languages[0]) || 'ko');
    document.documentElement.setAttribute('lang', lang);
    E.setLang(lang);
    if (lang === 'en') { translateAll(); watch(); }
    syncControls();
    var b = document.getElementById('langBtn');
    if (b) b.addEventListener('click', function () { apply(get() === 'en' ? 'ko' : 'en', true); });
    var sel = document.getElementById('sLang');
    if (sel) sel.addEventListener('change', function () { apply(sel.value === 'en' ? 'en' : 'ko', true); });
  }

  function collect() { collecting = {}; try { translateAll(); } finally { var r = Object.keys(collecting); collecting = null; saved = []; return r; } }
  window.AlbaLang = { collect: collect, get: get, set: function (l) { apply(l, true); }, init: init, translate: translateAll, _saved: function () { return saved.length; } };
  init();
})();
