/*
 * src/checklist.js — 매장 위생 점검 41개 항목 자동 판정
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

  /* 매장 위생 점검 41개 항목 (번호는 점검 기준 문서 순서 그대로)
     [번호, 점검 항목, 기준·참고(없으면 '')] */
  var GROUP_DEFS = [
    { key: 'basic', title: '식재료·조리 기본', items: [
      [1, '소비기한이 경과된 원재료를 보관·사용·판매하지 않는가?', ''],
      [2, '오일 산가는 3.0 이하로 관리하는가?', '산가 3.0 이하'],
      [3, '조리 시 올바른 매뉴얼을 준수하며, 내부까지 완전히 조리되었는가?', '']
    ] },
    { key: 'person', title: '개인위생', items: [
      [4, '모든 근무자의 건강진단결과서가 발급되어 있으며, 만료일이 경과되지 않았는가?', ''],
      [5, '모자, 머리망, 마스크를 올바르게 착용하고 있는가?', ''],
      [6, '손에 의한 오염이 없도록 관리하며, 손에 상처가 있는 근무자는 올바른 처치 후 근무하고 있는가?', ''],
      [7, '모든 싱크에 손 세척에 필요한 용품이 비치되어 있으며, 손 소독제는 사용기한 내의 제품을 구비하여 올바르게 사용하고 있는가?', ''],
      [8, '유니폼 가이드를 올바르게 준수하고 있는가?', '']
    ] },
    { key: 'foreign', title: '이물 관리', items: [
      [9, '중대 이물이 혼입되지 않도록 관리하고 있는가?', '철수세미 보관·사용 / 금속·유리·칼날 파손 / 중대해충(쥐, 바퀴벌레)'],
      [10, '기타 이물이 혼입되지 않도록 관리하고 있는가?', '기타 이물: 종이, 플라스틱, 비닐, 알루미늄 호일 등 (행정처분 시 그 외 이물에 해당)']
    ] },
    { key: 'material', title: '원재료 보관·관리', items: [
      [11, '원산지 게시물에 기재된 원산지와 동일한 원재료를 사용·보관하는가?', ''],
      [12, '야채 세척·소독 방법을 정확히 알고 실행하고 있으며, 올바른 소독제를 사용하고 있는가?', ''],
      [13, '식품표시사항에 기재된 보관 방법(온도)에 따라 원재료를 보관하고 있는가?', ''],
      [14, '해동하여 사용하는 원재료는 올바른 기준에 따라 해동 관리하는가?', '해동: 냉장 24시간, 사용기한: 48h (기본)'],
      [15, '모든 원재료는 식품표시사항이 훼손되거나 누락되지 않게 관리하고 있는가?', ''],
      [16, '원재료 및 제조와 관련 부자재는 오염되지 않도록 안전하게 보관하고 있는가?', ''],
      [17, '근무자용 식품 또는 물품을 판매용 원·부재료와 분리·구분하여 보관하고 있는가?', ''],
      [18, '전처리가 완료된 원재료에 사용기한 스티커가 올바르게 부착되어 있으며, 사용 기한을 준수하고 있는가?', '']
    ] },
    { key: 'temp', title: '온도 관리', items: [
      [19, '조리 완료 및 조리 후 보관중인 제품의 품온은 기준에 적합한가?', '조리 완료 즉시 75°C 이상 / 조리 후 보관 시 60°C 이상'],
      [20, '냉장 및 냉동고는 기준 온도로 세팅되어 있으며, 적절한 온도를 유지하고 있는가?', '냉장 0~5°C / 냉동 -18°C 이하'],
      [21, '후라이어 오일의 온도는 170도 이상으로 유지되며, 그리들 조리 시 온도를 체크하며 올바른 온도를 유지하는가?', '후라이어 오일 170°C 이상']
    ] },
    { key: 'tools', title: '소도구·화학제품', items: [
      [22, '소도구(도마, 칼, 집게, 소스병 등) 및 고객 제공용 식기류를 올바르게 관리하고 있는가?', ''],
      [23, '화학제품을 용도에 맞게 사용하며, 주방용으로 허가되지 않은 화학 제품을 주방 내 보관하거나 사용하지는 않는가?', '과일·채소용, 식품용 기구·용기용, 식품제조·가공장치용']
    ] },
    { key: 'kitchen', title: '주방 청결', items: [
      [24, '후드 및 환기구는 청결하게 관리하고 있는가?', ''],
      [25, '조리 및 보관 장비는 청결히 관리되고 있는가?', ''],
      [26, '제조가 이루어지는 구역은 청결히 관리되고 있는가?', '배터테이블, 버거테이블, 제조선반 등'],
      [27, '제빙기, 음료 제조 기기는 청결히 관리되고 있는가?', ''],
      [28, '냉장고, 냉동고에 파손된 부분이 없으며, 청결하게 관리하고 있는가?', ''],
      [29, '기타 장비, 기기는 청결히 관리하고 있는가?', '키오스크, POS, 빌지출력기, 정제기 등'],
      [30, '주방 구역의 바닥, 벽, 천장 등을 청결하게 관리하고 있는가?', '냉·난방기 포함'],
      [31, '선반, 기타 보관 공간(창고 등)을 청결하게 관리하고 있는가?', ''],
      [32, '타월은 용도를 구분하여 사용하고 있으며, 청결한 상태를 유지하고 있는가?', ''],
      [33, '싱크, 배수구는 오염이 없도록 청결하게 관리하고 있는가?', '']
    ] },
    { key: 'shop', title: '매장·외부·방충', items: [
      [34, '고객 구역의 바닥, 벽, 천장, 조명 등을 청결하게 관리하고 있는가?', '환기시설 / 냉·난방기 포함'],
      [35, '고객 구역의 테이블과 의자를 올바르게 관리하고 있는가?', ''],
      [36, '출입문 내·외부 및 주변, 간판, 어닝, 외부 구역 조명 등을 올바르게 관리하고 있는가?', ''],
      [37, '뚜껑이 있는 쓰레기통을 구비하여, 쓰레기통이 넘치지 않고 적절하게 밀폐 관리되고 있는가?', '더스트 박스 포함'],
      [38, '방충·방서 관리를 하고 있으며, 침입 요소를 올바르게 차단, 관리하고 있는가?', '']
    ] },
    { key: 'docs', title: '교육·게시물·서류', items: [
      [39, '기존 및 신규 영업자 식품위생교육 이수하였으며, 수료증을 매장 내 보관하고 있는가?', ''],
      [40, '영양성분 게시물 / 원산지 표시물은 최신 정보로 게시되어 있는가?', ''],
      [41, '산가페이퍼를 구비하고 있으며, 올바른 방법으로 보관 및 사용하고 있는가?', '']
    ] }
  ];

  var CHECKLIST_GROUPS = GROUP_DEFS.map(function (g) {
    return {
      key: g.key,
      title: g.title,
      items: g.items.map(function (it) { return { no: it[0], text: it[1], standard: it[2] }; })
    };
  });

  var TOTAL_ITEMS = 41;
  var FRIDGE_ITEM = 20; // 냉장·냉동 온도 항목: 체크 + 측정 온도가 기준 안이어야 적합

  function toNoList(v) {
    var out = [];
    (Array.isArray(v) ? v : []).forEach(function (x) {
      var n = Math.floor(Number(x));
      if (n >= 1 && n <= TOTAL_ITEMS && out.indexOf(n) < 0) out.push(n);
    });
    return out.sort(function (a, b) { return a - b; });
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
      checks: toNoList(raw.checks) // 적합(체크)한 항목 번호 목록
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
    var groups = CHECKLIST_GROUPS.map(function (g) {
      var items = g.items.map(function (it) {
        var checked = inp.checks.indexOf(it.no) >= 0;
        var ok = checked;
        var note = checked ? '확인 완료' : '체크 미완료';
        if (it.no === FRIDGE_ITEM) {
          ok = checked && fridgeOk && freezerOk;
          note = '냉장 ' + fmtTemp(inp.fridgeTemp) + (fridgeOk ? '' : '(이탈)') +
            ' · 냉동 ' + fmtTemp(inp.freezerTemp) + (freezerOk ? '' : '(이탈)') +
            (checked ? '' : ' · 체크 미완료');
        }
        return {
          no: it.no,
          id: 'q' + it.no,
          text: it.text,
          standard: it.standard,
          checked: checked,
          ok: ok,
          status: ok ? '적합 (O)' : '점검필요 (X)',
          note: note
        };
      });
      return { key: g.key, title: g.title, items: items };
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
    TOTAL_ITEMS: TOTAL_ITEMS,
    CHECKLIST_GROUPS: CHECKLIST_GROUPS,
    normalizeChecklistInput: normalizeChecklistInput,
    isFridgeOk: isFridgeOk,
    isFreezerOk: isFreezerOk,
    buildChecklist: buildChecklist
  };
});

