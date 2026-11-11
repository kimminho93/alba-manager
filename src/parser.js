/*
 * src/parser.js — 한 줄 자연어 급여 파서
 *   "철수 이번 달 총 62시간, 시급 10,000원 지각 20분"
 *   "영희 80시간 만원"
 *   "민수 주 14시간 시급 11,000원 주휴미포함"
 *   "지민 평일 5시간 시급 10,500원 4시간 이상 식대 8,000원"
 * 시급/식대 표현: 10,000원 / 10000원 / 만원 / 1만원 / 1만 500원 / 1.2만원 / 만오천원 / 8천원
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

  var KO_DIGIT = { '영': 0, '공': 0, '일': 1, '이': 2, '삼': 3, '사': 4, '오': 5, '육': 6, '륙': 6, '칠': 7, '팔': 8, '구': 9 };
  var KO_UNIT = { '십': 10, '백': 100, '천': 1000 };
  var AMOUNT_CHAR = /[0-9.,\s만천백십일이삼사오육칠팔구]/;
  var STOP_WORDS = ['이번', '지난', '이번달', '지난달', '총', '월', '주', '매주', '주당', '매일', '하루', '평일', '주말', '시급', '식대', '한달', '오늘', '알바', '알바생'];
  var hasOwn = Object.prototype.hasOwnProperty;

  /** 만 미만 단위 해석: "500", "1.2", "오천", "5천", "오천오백", "8천" */
  function parseSmallKorean(s) {
    if (!s) return 0;
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    var total = 0, cur = null, i = 0;
    while (i < s.length) {
      var ch = s.charAt(i);
      if (/[0-9]/.test(ch)) {
        var m = /^\d+(\.\d+)?/.exec(s.slice(i));
        cur = parseFloat(m[0]);
        i += m[0].length;
        continue;
      }
      if (hasOwn.call(KO_DIGIT, ch)) { cur = KO_DIGIT[ch]; i++; continue; }
      if (hasOwn.call(KO_UNIT, ch)) { total += (cur === null ? 1 : cur) * KO_UNIT[ch]; cur = null; i++; continue; }
      return NaN;
    }
    if (cur !== null) total += cur;
    return total;
  }

  /** "1만 500원" → 10500, "만오천" → 15000, "1.2만" → 12000, "10,000" → 10000, "8천원" → 8000 */
  function parseKoreanAmount(text) {
    var s = String(text === null || text === undefined ? '' : text).replace(/[\s,]/g, '').replace(/원$/, '');
    if (!s) return NaN;
    var idx = s.indexOf('만');
    if (idx === -1) {
      var v = parseSmallKorean(s);
      return isNaN(v) ? NaN : Math.round(v);
    }
    if (s.indexOf('만', idx + 1) !== -1) return NaN;
    var left = s.slice(0, idx), right = s.slice(idx + 1);
    var l = left === '' ? 1 : parseSmallKorean(left);
    var r = right === '' ? 0 : parseSmallKorean(right);
    if (isNaN(l) || isNaN(r)) return NaN;
    return Math.round(l * 10000 + r);
  }

  /** 문장에서 시급(원) 추출. "원" 앞의 금액 구간을 역방향으로 읽습니다. */
  function extractWage(text) {
    var candidates = [];
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) !== '원') continue;
      var j = i - 1;
      while (j >= 0 && AMOUNT_CHAR.test(text.charAt(j))) j--;
      var seg = text.slice(j + 1, i).trim();
      if (!seg) continue;
      var tokens = seg.split(/\s+/);
      var res = tokens.pop();
      while (tokens.length && /만$/.test(tokens[tokens.length - 1]) && res.indexOf('만') === -1) {
        res = tokens.pop() + res;
      }
      res = res.replace(/^[.,]+/, '');
      var amount = parseKoreanAmount(res);
      var prefix = text.slice(Math.max(0, j - 10), j + 1);
      var nearMeal = /(식대|식비|밥값)\s*[:은는이]?\s*$/.test(prefix);
      if (!isNaN(amount) && amount >= 100 && amount <= 10000000 && !nearMeal) {
        candidates.push({
          amount: amount,
          raw: res + '원',
          nearWage: /(시급|시간당)\s*[:은는이]?\s*$/.test(prefix)
        });
      }
    }
    var pick = null;
    for (var k = 0; k < candidates.length; k++) {
      if (candidates[k].nearWage) { pick = candidates[k]; break; }
    }
    if (!pick && candidates.length) pick = candidates[0];
    if (pick) return pick;
    var m = /(?:시급|시간당)\s*[:은는]?\s*(\d[\d,]*)/.exec(text);
    if (m) {
      var n = M.toNumber(m[1], NaN);
      if (isFinite(n) && n >= 100) return { amount: Math.round(n), raw: m[1] };
    }
    return null;
  }

  function extractName(src) {
    var first = (src.split(/[\s,]+/)[0] || '').replace(/(씨|님)$/, '');
    if (!/^[가-힣A-Za-z]{1,10}$/.test(first)) return null;
    if (STOP_WORDS.indexOf(first) !== -1) return null;
    if (/(시간|시급|식대|주휴|지각|조퇴|보험|세금|이번|지난|매주|평일|주말|하루|매일)/.test(first)) return null;
    if (/원$/.test(first)) return null;
    return first;
  }

  /**
   * 한 줄 문장 → 급여 입력값
   */
  function parseText(text) {
    var src = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
    var out = {
      name: null,
      hourlyWage: null,
      mode: null,
      totalHours: null,
      weekHours: null,
      dailyHours: null,
      lateMinutes: 0,
      includeWeekly: true,
      includeMeal: null,
      mealMinHours: null,
      mealAmount: null,
      tax: null,
      summary: [],
      raw: src
    };
    if (!src) return out;

    // 1) 지각/조퇴 (먼저 제거해서 근무시간과 혼동 방지)
    var late = 0, lateFound = false;
    var rest = src.replace(/(지각|조퇴|외출)\s*(\d+(?:\.\d+)?)\s*(분|시간)/g, function (_, kind, n, unit) {
      late += unit === '시간' ? parseFloat(n) * 60 : parseFloat(n);
      lateFound = true;
      return ' ';
    });
    out.lateMinutes = Math.round(late);

    // 2) 식대 기준시간 ("4시간 이상 식대", "일 5시간 이상 식대") 추출 및 제거
    rest = rest.replace(/(?:일|하루)?\s*(\d+(?:\.\d+)?)\s*시간\s*이상\s*(?=(?:근무\s*(?:시\s*)?)?(?:식대|식비|밥값))/g, function (_, h) {
      out.mealMinHours = parseFloat(h);
      out.includeMeal = true;
      return ' ';
    });

    // 3) 식대 금액 / 포함 여부 추출
    if (/(?:식대|식비|밥값)\s*(?:미포함|불포함|제외|없음|없이|x\b)/i.test(rest)) {
      out.includeMeal = false;
    } else {
      var mealMatch = /(?:식대|식비|밥값)\s*[:은는]?\s*([0-9.,만천백십일이삼사오육칠팔구\s]+?)\s*원/.exec(rest);
      if (mealMatch) {
        var ma = parseKoreanAmount(mealMatch[1]);
        if (!isNaN(ma) && ma >= 500 && ma <= 100000) {
          out.mealAmount = ma;
          out.includeMeal = true;
        }
      } else if (/(?:식대|식비|밥값)\s*(?:포함|지급|추가|있음|o\b)/i.test(rest)) {
        out.includeMeal = true;
      }
    }

    // 4) 이름
    out.name = extractName(src);

    // 5) 시급
    var wage = extractWage(rest);
    if (wage) out.hourlyWage = wage.amount;

    // 6) 근무시간 — 일별("평일 5시간", "주말 6시간", "하루/매일 5시간") -> 주별("주 14시간") -> 월 총("총 62시간")
    var weekdayMatch = /(?:평일|월~금|주\s*5일)\s*(?:하루\s*|일\s*)?(\d+(?:\.\d+)?)\s*시간/.exec(rest);
    var weekendMatch = /(?:주말|토일|토·일)\s*(?:하루\s*|일\s*)?(\d+(?:\.\d+)?)\s*시간/.exec(rest);
    var dailyMatch = /(?:매일|하루|일)\s*(\d+(?:\.\d+)?)\s*시간(?:\s*(\d+)\s*일)?/.exec(rest);

    if (weekdayMatch || weekendMatch) {
      var wdH = weekdayMatch ? parseFloat(weekdayMatch[1]) : 0;
      var weH = weekendMatch ? parseFloat(weekendMatch[1]) : 0;
      var dh = [];
      for (var w = 0; w < 4; w++) {
        for (var d = 0; d < 7; d++) {
          dh.push(d < 5 ? wdH : weH);
        }
      }
      out.mode = 'daily';
      out.dailyHours = dh;
      var wSum = M.round2(wdH * 5 + weH * 2);
      out.weekHours = [wSum, wSum, wSum, wSum];
      out.totalHours = M.round2(wSum * 4);
    } else if (dailyMatch) {
      var dayH = parseFloat(dailyMatch[1]);
      var numDays = dailyMatch[2] ? Math.min(28, Math.max(1, parseInt(dailyMatch[2], 10))) : 20;
      var dh2 = [];
      var filled = 0;
      for (var w2 = 0; w2 < 4; w2++) {
        for (var d2 = 0; d2 < 7; d2++) {
          if (numDays <= 20 ? (d2 < 5 && filled < numDays) : (filled < numDays)) {
            dh2.push(dayH);
            filled++;
          } else {
            dh2.push(0);
          }
        }
      }
      out.mode = 'daily';
      out.dailyHours = dh2;
      out.weekHours = [0, 1, 2, 3].map(function (wi) {
        var s = 0;
        for (var di = 0; di < 7; di++) s += dh2[wi * 7 + di];
        return M.round2(s);
      });
      out.totalHours = M.round2(dayH * filled);
    } else {
      var wm = /(?:^|[^가-힣])(?:매\s*)?주당?\s*(\d+(?:\.\d+)?)\s*시간/.exec(rest);
      if (wm) {
        var h = parseFloat(wm[1]);
        out.mode = 'weekly';
        out.weekHours = [h, h, h, h];
        out.totalHours = M.round2(h * 4);
      } else {
        var tm = /(\d+(?:\.\d+)?)\s*(?:시간|hrs?\b|h\b)/i.exec(rest);
        if (tm) {
          out.mode = 'total';
          out.totalHours = parseFloat(tm[1]);
        }
      }
    }

    // 7) 주휴 포함 여부
    var weeklyMentioned = false;
    if (/주휴\s*(?:수당)?\s*(?:미포함|불포함|제외|없음|없이|빼고|x\b|안\s*줌)/i.test(rest)) {
      out.includeWeekly = false;
      weeklyMentioned = true;
    } else if (/주휴\s*(?:수당)?\s*(?:포함|있음|o\b)/i.test(rest)) {
      out.includeWeekly = true;
      weeklyMentioned = true;
    }

    // 8) 세금
    if (/4\s*대\s*보험|4대/.test(rest)) out.tax = '4ins';
    else if (/3\.3/.test(rest)) out.tax = '3.3';
    else if (/무세금|노세금|비과세|세금\s*(?:없음|없이|미적용|제외|x\b|0)|미적용|0\s*%/i.test(rest)) out.tax = 'none';

    // 9) 인식 결과 요약
    if (out.name) out.summary.push('👤 ' + out.name);
    if (out.mode === 'daily') out.summary.push('📅 일별 입력 (총 ' + M.formatNum(out.totalHours) + '시간)');
    else if (out.mode === 'weekly') out.summary.push('⏱ 주 ' + M.formatNum(out.weekHours[0]) + '시간 × 4주');
    else if (out.mode === 'total') out.summary.push('⏱ 총 ' + M.formatNum(out.totalHours) + '시간');
    if (out.hourlyWage) out.summary.push('💵 시급 ' + M.formatWon(out.hourlyWage) + '원');
    if (out.includeMeal) {
      out.summary.push('🍚 식대 ' + M.formatWon(out.mealAmount || 8000) + '원 (' + M.formatNum(out.mealMinHours || 4) + 'h↑)');
    }
    if (lateFound) out.summary.push('⏰ 지각·조퇴 ' + out.lateMinutes + '분');
    out.summary.push(out.includeWeekly ? '✅ 주휴 포함' + (weeklyMentioned ? '' : '(기본)') : '🚫 주휴 미포함');
    if (out.tax) out.summary.push('🧾 ' + ({ '3.3': '3.3%', '4ins': '4대보험', 'none': '세금 미적용' })[out.tax]);
    return out;
  }

  return {
    parseKoreanAmount: parseKoreanAmount,
    extractWage: extractWage,
    parseText: parseText
  };
});
