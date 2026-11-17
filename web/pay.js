/* 손님용 계좌이체 안내 페이지: 주소의 # 뒤 정보만 읽어 보여 주고 복사 (서버로 아무것도 보내지 않음) */
(function () {
  'use strict';
  var en = !/^ko\b/i.test(navigator.language || 'ko');
  var T = {
    title: '계좌이체 안내', sub: '계좌이체 안내', bank: '은행', no: '계좌번호', holder: '예금주',
    copyNo: '📋 계좌번호 복사', copyAll: '은행 이름까지 복사', copied: '✅ 복사했어요! 이제 송금 앱을 여세요',
    copiedBtn: '✅ 복사 완료', fail: '복사하지 못했어요. 계좌번호를 길게 눌러 복사해 주세요.',
    howto: '복사한 뒤 쓰시는 은행 앱이나 토스·카카오페이를 열면 계좌번호를 붙여 넣을 수 있어요.',
    check1: '송금하기 전에 받는 분 이름이 ', check2: ' 인지 꼭 확인하세요.',
    bad: '안내 정보를 읽을 수 없어요. 매장에 계좌번호를 직접 물어봐 주세요.'
  };
  if (en) T = {
    title: 'Bank transfer', sub: 'Bank transfer details', bank: 'Bank', no: 'Account no.', holder: 'Account holder',
    copyNo: '📋 Copy account number', copyAll: 'Copy with bank name', copied: '✅ Copied! Now open your banking app',
    copiedBtn: '✅ Copied', fail: "Couldn't copy. Long-press the account number to copy it.",
    howto: 'After copying, open your banking or payment app and paste the account number.',
    check1: 'Before sending, make sure the recipient name is ', check2: '.',
    bad: "Couldn't read the details. Please ask the store for the account number."
  };
  function $(id) { return document.getElementById(id); }
  function clean(s, max) { return typeof s === 'string' && s.length && s.length <= max && !/[\u0000-\u001f<>]/.test(s) ? s : null; }
  function decode(h) {
    var m = /(?:^#|&)d=([A-Za-z0-9_-]{8,600})(?:&|$)/.exec(h || '');
    if (!m) return null;
    try {
      var b = atob(m[1].replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((m[1].length + 3) % 4));
      var bytes = new Uint8Array(b.length);
      for (var i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
      var a = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!Array.isArray(a) || a[0] !== 1) return null;
      var bank = clean(a[1], 20), no = clean(a[2], 30), holder = clean(a[3], 20);
      var store = a[4] === '' ? '' : clean(a[4], 30);
      if (!bank || !no || !holder || store === null) return null;
      var digits = no.replace(/-/g, '');
      if (!/^[0-9-]+$/.test(no) || digits.length < 8 || digits.length > 20 || /^-|-$|--/.test(no)) return null;
      return { bank: bank, no: no, digits: digits, holder: holder, store: store };
    } catch (e) { return null; }
  }
  function copy(text, cb) {
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
      var ok = false; try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta); cb(ok);
    }
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(function () { cb(true); }, legacy);
    else legacy();
  }
  document.title = T.title;
  document.documentElement.lang = en ? 'en' : 'ko';
  $('sub').textContent = T.sub; $('lBank').textContent = T.bank; $('lNo').textContent = T.no; $('lHolder').textContent = T.holder;
  $('copyNo').textContent = T.copyNo; $('copyAll').textContent = T.copyAll; $('howto').textContent = T.howto; $('bad').textContent = T.bad;
  var d = decode(location.hash);
  if (!d) { $('bad').hidden = false; return; }
  $('store').textContent = d.store;
  $('bank').textContent = d.bank; $('no').textContent = d.no; $('holder').textContent = d.holder;
  var chk = $('check');
  chk.textContent = '';
  chk.appendChild(document.createTextNode(T.check1));
  var b = document.createElement('b'); b.textContent = d.holder; chk.appendChild(b);
  chk.appendChild(document.createTextNode(T.check2));
  $('ok').hidden = false;
  function done(btn, ok) {
    $('done').textContent = ok ? T.copied : T.fail;
    if (ok) { btn.classList.add('copied'); if (btn.id === 'copyNo') btn.textContent = T.copiedBtn; }
  }
  $('copyNo').addEventListener('click', function () { var me = this; copy(d.digits, function (ok) { done(me, ok); }); });
  $('copyAll').addEventListener('click', function () { var me = this; copy(d.bank + ' ' + d.digits, function (ok) { done(me, ok); }); });
})();
