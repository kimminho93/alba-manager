/*
 * src/qr.js — 외부 라이브러리 없는 QR 코드 생성기 (계좌 안내 QR 용)
 *   - 바이트 모드, 오류 정정 M(약 15% 복구), 버전 1~15 (최대 412바이트)
 *   - 결과: 0/1 격자 → SVG 문자열 (화면·인쇄 모두 선명)
 *   표준: ISO/IEC 18004. 다른 QR 판독기(카메라 앱)로 읽히는지 tests 에서 확인
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

  /* 버전별 [블록당 오류정정 코드 수, 짧은 블록 수, 짧은 블록 데이터 수, 긴 블록 수] — 오류 정정 M */
  var EC_M = [null,
    [10, 1, 16, 0], [16, 1, 28, 0], [26, 1, 44, 0], [18, 2, 32, 0], [24, 2, 43, 0],
    [16, 4, 27, 0], [18, 4, 31, 0], [22, 2, 38, 2], [22, 3, 36, 2], [26, 4, 43, 1],
    [30, 1, 50, 4], [22, 6, 36, 2], [22, 8, 37, 1], [24, 4, 40, 5], [24, 5, 41, 5]];
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46],
    [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70]];
  var MAX_VER = 15;

  function dataCapacity(v) { var e = EC_M[v]; return e[1] * e[2] + e[3] * (e[2] + 1); }

  /* ---------- 리드-솔로몬 (GF(256), 다항식 0x11D) ---------- */
  function gfMul(x, y) {
    var z = 0;
    for (var i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
  }
  function rsDivisor(degree) {
    var r = [];
    for (var i = 0; i < degree - 1; i++) r.push(0);
    r.push(1);
    var root = 1;
    for (var k = 0; k < degree; k++) {
      for (var j = 0; j < r.length; j++) {
        r[j] = gfMul(r[j], root);
        if (j + 1 < r.length) r[j] ^= r[j + 1];
      }
      root = gfMul(root, 0x02);
    }
    return r;
  }
  function rsRemainder(data, divisor) {
    var r = divisor.map(function () { return 0; });
    data.forEach(function (b) {
      var f = b ^ r.shift();
      r.push(0);
      for (var i = 0; i < divisor.length; i++) r[i] ^= gfMul(divisor[i], f);
    });
    return r;
  }

  /* 문자열 → UTF-8 바이트 */
  function utf8(s) {
    var out = [];
    s = String(s);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xD800 && c < 0xDC00 && i + 1 < s.length) {
        var d = s.charCodeAt(i + 1);
        if (d >= 0xDC00 && d < 0xE000) { c = 0x10000 + ((c - 0xD800) << 10) + (d - 0xDC00); i++; }
      }
      if (c >= 0xD800 && c < 0xE000) c = 0xFFFD;   // 짝 없는 반쪽 글자는 대체 문자로 (표준 UTF-8만 만들기)
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  /* 데이터 비트열 → 오류정정 포함 최종 코드워드 */
  function codewords(bytes, v) {
    var bits = [];
    function put(val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    put(4, 4);   // 바이트 모드
    put(bytes.length, v < 10 ? 8 : 16);
    bytes.forEach(function (b) { put(b, 8); });
    var cap = dataCapacity(v) * 8;
    put(0, Math.min(4, cap - bits.length));
    while (bits.length % 8) bits.push(0);
    var data = [];
    for (var i = 0; i < bits.length; i += 8) {
      var b = 0;
      for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
      data.push(b);
    }
    for (var p = 0; data.length < dataCapacity(v); p++) data.push(p % 2 ? 0x11 : 0xEC);
    var e = EC_M[v], div = rsDivisor(e[0]), blocks = [], ecs = [], at = 0;
    for (var k = 0; k < e[1] + e[3]; k++) {
      var len = e[2] + (k < e[1] ? 0 : 1);
      var blk = data.slice(at, at + len);
      at += len;
      blocks.push(blk);
      ecs.push(rsRemainder(blk, div));
    }
    var out = [];
    for (var m = 0; m <= e[2]; m++) blocks.forEach(function (bk) { if (m < bk.length) out.push(bk[m]); });
    for (var n = 0; n < e[0]; n++) ecs.forEach(function (ec) { out.push(ec[n]); });
    return out;
  }

  /* ---------- 격자 그리기 ---------- */
  function Grid(v) {
    this.size = v * 4 + 17;
    this.m = [];
    this.fn = [];
    for (var y = 0; y < this.size; y++) { this.m.push(new Array(this.size).fill(0)); this.fn.push(new Array(this.size).fill(false)); }
  }
  Grid.prototype.set = function (x, y, dark) { this.m[y][x] = dark ? 1 : 0; this.fn[y][x] = true; };

  function drawFunction(g, v) {
    var s = g.size, i;
    for (i = 0; i < s; i++) { g.set(6, i, i % 2 === 0); g.set(i, 6, i % 2 === 0); }   // 타이밍 패턴
    [[3, 3], [s - 4, 3], [3, s - 4]].forEach(function (c) {   // 찾기 패턴 + 분리대
      for (var dy = -4; dy <= 4; dy++) for (var dx = -4; dx <= 4; dx++) {
        var x = c[0] + dx, y = c[1] + dy;
        if (x < 0 || y < 0 || x >= s || y >= s) continue;
        var d = Math.max(Math.abs(dx), Math.abs(dy));
        g.set(x, y, d !== 2 && d !== 4);
      }
    });
    var al = ALIGN[v], n = al.length;
    for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === n - 1) || (a === n - 1 && b === 0)) continue;
      for (var dy2 = -2; dy2 <= 2; dy2++) for (var dx2 = -2; dx2 <= 2; dx2++) {
        g.set(al[a] + dx2, al[b] + dy2, Math.max(Math.abs(dx2), Math.abs(dy2)) !== 1);
      }
    }
    drawFormat(g, 0);   // 자리 확보 (나중에 실제 값으로 덮어씀)
    if (v >= 7) {
      var rem = v;
      for (i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var bits = (v << 12) | rem;
      for (i = 0; i < 18; i++) {
        var bit = (bits >>> i) & 1, p = s - 11 + i % 3, q = Math.floor(i / 3);
        g.set(p, q, bit); g.set(q, p, bit);
      }
    }
  }

  function drawFormat(g, mask) {
    var data = (0 << 3) | mask, rem = data, i, s = g.size;   // 오류 정정 M = 00
    for (i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    var bits = ((data << 10) | rem) ^ 0x5412;
    function b(k) { return (bits >>> k) & 1; }
    for (i = 0; i <= 5; i++) g.set(8, i, b(i));
    g.set(8, 7, b(6)); g.set(8, 8, b(7)); g.set(7, 8, b(8));
    for (i = 9; i < 15; i++) g.set(14 - i, 8, b(i));
    for (i = 0; i < 8; i++) g.set(s - 1 - i, 8, b(i));
    for (i = 8; i < 15; i++) g.set(8, s - 15 + i, b(i));
    g.set(8, s - 8, 1);   // 항상 검은 칸
  }

  function drawData(g, cw) {
    var s = g.size, i = 0, total = cw.length * 8;
    for (var right = s - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < s; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, up = ((right + 1) & 2) === 0, y = up ? s - 1 - vert : vert;
          if (!g.fn[y][x] && i < total) { g.m[y][x] = (cw[i >>> 3] >>> (7 - (i & 7))) & 1; i++; }
        }
      }
    }
  }

  function maskBit(k, x, y) {
    switch (k) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
      case 5: return x * y % 2 + x * y % 3 === 0;
      case 6: return (x * y % 2 + x * y % 3) % 2 === 0;
      default: return ((x + y) % 2 + x * y % 3) % 2 === 0;
    }
  }
  function applyMask(g, k) {
    for (var y = 0; y < g.size; y++) for (var x = 0; x < g.size; x++) {
      if (!g.fn[y][x] && maskBit(k, x, y)) g.m[y][x] ^= 1;
    }
  }

  /* 판독이 쉬운 무늬를 고르기 위한 벌점 (표준의 4가지 규칙) */
  function penalty(g) {
    var s = g.size, m = g.m, p = 0, x, y, k;
    function runs(get) {
      for (var a = 0; a < s; a++) {
        var run = 1;
        for (var b = 1; b <= s; b++) {
          if (b < s && get(a, b) === get(a, b - 1)) run++;
          else { if (run >= 5) p += run - 2; run = 1; }
        }
      }
    }
    runs(function (a, b) { return m[a][b]; });
    runs(function (a, b) { return m[b][a]; });
    for (y = 0; y < s - 1; y++) for (x = 0; x < s - 1; x++) {
      var c = m[y][x];
      if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3;
    }
    var pat = [1, 0, 1, 1, 1, 0, 1], i;
    function at(get, a, b) { return b < 0 || b >= s ? 0 : get(a, b); }
    function finder(get) {
      for (var a = 0; a < s; a++) for (var b = -4; b < s; b++) {
        var ok = true;
        for (k = 0; k < 7 && ok; k++) ok = at(get, a, b + k) === pat[k];
        if (!ok) continue;
        var before = true, after = true;
        for (i = 1; i <= 4; i++) { if (at(get, a, b - i)) before = false; if (at(get, a, b + 6 + i)) after = false; }
        if (before || after) p += 40;
      }
    }
    finder(function (a, b) { return m[a][b]; });
    finder(function (a, b) { return m[b][a]; });
    var dark = 0;
    for (y = 0; y < s; y++) for (x = 0; x < s; x++) dark += m[y][x];
    p += Math.floor(Math.abs(dark * 20 - s * s * 10) / (s * s)) * 10;
    return p;
  }

  /**
   * 글자 → QR 격자. 너무 길면 null.
   * @param {string} text
   * @param {number} [forceMask] 0~7 (시험용)
   * @returns {{size:number, modules:number[][], version:number, mask:number}|null}
   */
  function qrEncode(text, forceMask) {
    var bytes = utf8(text);
    var v = 1;
    while (v <= MAX_VER && bytes.length > dataCapacity(v) - (v < 10 ? 2 : 3)) v++;
    if (v > MAX_VER) return null;
    var cw = codewords(bytes, v);
    var best = null;
    for (var k = 0; k < 8; k++) {
      if (forceMask !== undefined && forceMask !== k) continue;
      var g = new Grid(v);
      drawFunction(g, v);
      drawData(g, cw);
      applyMask(g, k);
      drawFormat(g, k);
      var pen = forceMask !== undefined ? 0 : penalty(g);
      if (!best || pen < best.pen) best = { pen: pen, g: g, mask: k };
    }
    return { size: best.g.size, modules: best.g.m, version: v, mask: best.mask };
  }

  /** QR → SVG 문자열 (가장자리 여백 4칸, 검은 칸은 한 경로) */
  function qrSvg(text, opts) {
    var q = qrEncode(text);
    if (!q) return '';
    var o = opts || {}, quiet = 4, n = q.size + quiet * 2, d = '';
    for (var y = 0; y < q.size; y++) {
      for (var x = 0; x < q.size; x++) {
        if (!q.modules[y][x]) continue;
        var w = 1;
        while (x + w < q.size && q.modules[y][x + w]) w++;
        d += 'M' + (x + quiet) + ' ' + (y + quiet) + 'h' + w + 'v1h-' + w + 'z';
        x += w - 1;
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" shape-rendering="crispEdges"' +
      (o.label ? ' role="img" aria-label="' + String(o.label).replace(/[&<>"']/g, '') + '"' : '') + '>' +
      '<rect width="' + n + '" height="' + n + '" fill="#fff"/><path fill="#000" d="' + d + '"/></svg>';
  }

  return { qrEncode: qrEncode, qrSvg: qrSvg };
});
