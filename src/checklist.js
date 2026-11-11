/*
 * src/checklist.js — 위생 점검 / 소방 안전 법정 9대 점검 항목 자동 완성
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./math_ops.js'));
  } else {
    root.AlbaEngine = root.AlbaEngine || {};
    Object.assign(root.AlbaEngine, factory(root.AlbaEngine));
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M) {
  'use strict';

  var FRIDGE_MIN = 0, FRIDGE_MAX = 5, FREEZER_MAX = -18;

  var CHECK_LABELS = {
    check1: '냉장·냉동 온도 정상 & 소비기한 경과 식재료 없음',
    check2: '개인위생(보건증·위생모) & 조리장·칼·도마 소독 완료',
    check3: '소화기·비상구 확보 & 가스밸브·누전차단기 이상 없음'
  };

  var CHECKLIST_GROUPS = [
    {
      key: 'food', title: '식품보관·온도', check: 'check1',
      items: [
        { id: 'fridge', text: '냉장고 온도 적정 유지', standard: '0~5°C' },
        { id: 'freezer', text: '냉동고 온도 적정 유지', standard: '-18°C 이하' },
        { id: 'expiry', text: '소비기한 경과 원료·제품 보관 여부', standard: '경과 제품 없음' }
      ]
    },
    {
      key: 'hygiene', title: '조리장·개인위생', check: 'check2',
      items: [
        { id: 'health', text: '종사자 건강진단(보건증) 유효 및 위생모·마스크 착용', standard: '보건증 유효·착용' },
        { id: 'utensil', text: '칼·도마·행주 구분 사용 및 열탕·살균 소독', standard: '구분 사용·소독' },
        { id: 'floor', text: '조리장 바닥·배수구 청결 및 방충·방서 관리', standard: '청결·방충망' }
      ]
    },
    {
      key: 'fire', title: '소방·가스·전기', check: 'check3',
      items: [
        { id: 'extinguisher', text: '소화기 비치 상태 및 압력게이지(녹색) 정상 여부', standard: '게이지 녹색' },
        { id: 'exit', text: '비상구·피난통로 적치물 제거 및 유도등 점등', standard: '통로 확보·점등' },
        { id: 'gas', text: '가스 누출 경보기·중간밸브 잠금 및 누전차단기 점검', standard: '경보기·밸브·차단기 정상' }
      ]
    }
  ];

  function toBool(v) {
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on';
  }

  function tempValue(v, def) {
    if (v === undefined) return def;
    var n = M.toNumber(v, NaN);
    return isFinite(n) ? Math.round(n * 10) / 10 : null;
  }

  function normalizeChecklistInput(raw) {
    raw = raw || {};
    var date = typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) ? raw.date : '';
    return {
      store: String(raw.store || '').trim().slice(0, 40),
      date: date,
      inspector: String(raw.inspector || '').trim().slice(0, 20),
      fridgeTemp: tempValue(raw.fridgeTemp, 3.0),
      freezerTemp: tempValue(raw.freezerTemp, -18.5),
      memo: String(raw.memo || '').slice(0, 500),
      check1: toBool(raw.check1),
      check2: toBool(raw.check2),
      check3: toBool(raw.check3)
    };
  }

  function fmtTemp(t) {
    return t === null ? '미입력' : M.formatNum(t, 1) + '°C';
  }

  function isFridgeOk(t) { return t !== null && t >= FRIDGE_MIN && t <= FRIDGE_MAX; }
  function isFreezerOk(t) { return t !== null && t <= FREEZER_MAX; }

  /** 점검표 생성 메인 함수 */
  function buildChecklist(raw) {
    var inp = normalizeChecklistInput(raw);
    var fridgeOk = isFridgeOk(inp.fridgeTemp);
    var freezerOk = isFreezerOk(inp.freezerTemp);
    var no = 0;
    var groups = CHECKLIST_GROUPS.map(function (g) {
      var checked = inp[g.check];
      return {
        key: g.key,
        title: g.title,
        check: g.check,
        checked: checked,
        items: g.items.map(function (it) {
          var ok = checked;
          var note = checked ? '확인 완료' : '체크 미완료';
          if (it.id === 'fridge') {
            ok = checked && fridgeOk;
            note = '측정 ' + fmtTemp(inp.fridgeTemp) + (fridgeOk ? '' : ' · 기준 이탈') + (checked ? '' : ' · 체크 미완료');
          } else if (it.id === 'freezer') {
            ok = checked && freezerOk;
            note = '측정 ' + fmtTemp(inp.freezerTemp) + (freezerOk ? '' : ' · 기준 이탈') + (checked ? '' : ' · 체크 미완료');
          }
          no += 1;
          return {
            no: no,
            id: it.id,
            text: it.text,
            standard: it.standard,
            ok: ok,
            status: ok ? '적합 (O)' : '점검필요 (X)',
            note: note
          };
        })
      };
    });
    var items = [];
    groups.forEach(function (g) { items = items.concat(g.items); });
    var passCount = items.filter(function (i) { return i.ok; }).length;
    var total = items.length;
    var failCount = total - passCount;
    return {
      input: inp,
      store: inp.store || '(매장명 미입력)',
      date: inp.date,
      inspector: inp.inspector || '-',
      fridgeTemp: inp.fridgeTemp,
      freezerTemp: inp.freezerTemp,
      fridgeOk: fridgeOk,
      freezerOk: freezerOk,
      memo: inp.memo,
      groups: groups,
      items: items,
      passCount: passCount,
      failCount: failCount,
      total: total,
      allPass: failCount === 0,
      verdict: failCount === 0 ? '전 항목 적합' : '점검필요 ' + failCount + '건'
    };
  }

  return {
    CHECK_LABELS: CHECK_LABELS,
    CHECKLIST_GROUPS: CHECKLIST_GROUPS,
    normalizeChecklistInput: normalizeChecklistInput,
    isFridgeOk: isFridgeOk,
    isFreezerOk: isFreezerOk,
    buildChecklist: buildChecklist
  };
});

