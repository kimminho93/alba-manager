/*
 * src/xlsx.js — 외부 라이브러리 없는 순수 JS OpenXML(.xlsx) 생성기
 *   - ZIP(무압축 STORE) + CRC32 직접 구현
 *   - 인라인 문자열, 숫자 서식(#,##0), 굵게/배경색/테두리 스타일, 열 너비, 셀 병합 지원
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

  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  /* ---------- CRC32 ---------- */
  var CRC_TABLE = (function () {
    var t = new Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xffffffff;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  function utf8(str) {
    return new TextEncoder().encode(str);
  }

  /* ---------- ZIP (STORE) ---------- */
  function zipStore(files) {
    var chunks = [];
    var central = [];
    var offset = 0;
    var dosTime = 0;
    var dosDate = ((2025 - 1980) << 9) | (1 << 5) | 1; // 2025-01-01 고정 (재현 가능한 출력)

    files.forEach(function (f) {
      var name = utf8(f.name);
      var data = typeof f.data === 'string' ? utf8(f.data) : f.data;
      var crc = crc32(data);

      var lh = new Uint8Array(30 + name.length);
      var lv = new DataView(lh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true); // UTF-8 파일명
      lv.setUint16(8, 0, true); // STORE
      lv.setUint16(10, dosTime, true);
      lv.setUint16(12, dosDate, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, name.length, true);
      lv.setUint16(28, 0, true);
      lh.set(name, 30);
      chunks.push(lh, data);

      var ch = new Uint8Array(46 + name.length);
      var cv = new DataView(ch.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, dosTime, true);
      cv.setUint16(14, dosDate, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, data.length, true);
      cv.setUint32(24, data.length, true);
      cv.setUint16(28, name.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      ch.set(name, 46);
      central.push(ch);

      offset += lh.length + data.length;
    });

    var cdSize = central.reduce(function (s, c) { return s + c.length; }, 0);
    var end = new Uint8Array(22);
    var ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    var all = chunks.concat(central, [end]);
    var total = all.reduce(function (s, c) { return s + c.length; }, 0);
    var out = new Uint8Array(total);
    var p = 0;
    all.forEach(function (c) { out.set(c, p); p += c.length; });
    return out;
  }

  /* ---------- SpreadsheetML ---------- */
  // 글꼴/채우기/테두리/숫자서식 정의 (인덱스는 아래 배열 순서)
  var FONT_NAME = '<name val="맑은 고딕"/><family val="2"/>';
  var FONTS = [
    '<font><sz val="11"/>' + FONT_NAME + '</font>',                                              // 0 기본
    '<font><b/><sz val="11"/>' + FONT_NAME + '</font>',                                          // 1 굵게
    '<font><b/><sz val="15"/>' + FONT_NAME + '</font>',                                          // 2 제목(기존)
    '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/>' + FONT_NAME + '</font>',                   // 3 굵은 흰색
    '<font><b/><sz val="20"/><color rgb="FFFFFFFF"/>' + FONT_NAME + '</font>',                   // 4 큰 흰색(상단 띠)
    '<font><sz val="10"/><color rgb="FF5B6478"/>' + FONT_NAME + '</font>',                       // 5 회색 작은 글씨
    '<font><b/><sz val="20"/><color rgb="FF1F3A8A"/>' + FONT_NAME + '</font>',                   // 6 큰 금액
    '<font><b/><sz val="11"/><color rgb="FFC62828"/>' + FONT_NAME + '</font>',                   // 7 빨강 굵게(일요일)
    '<font><b/><sz val="11"/><color rgb="FF1F56C4"/>' + FONT_NAME + '</font>'                    // 8 파랑 굵게(토요일)
  ];
  var FILLS = [
    '<fill><patternFill patternType="none"/></fill>',                                                              // 0
    '<fill><patternFill patternType="gray125"/></fill>',                                                           // 1
    '<fill><patternFill patternType="solid"><fgColor rgb="FFDDE7F5"/><bgColor indexed="64"/></patternFill></fill>', // 2 연한 파랑(헤더)
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4CC"/><bgColor indexed="64"/></patternFill></fill>', // 3 연한 노랑
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE3F7EC"/><bgColor indexed="64"/></patternFill></fill>', // 4 연한 초록
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFDE2E2"/><bgColor indexed="64"/></patternFill></fill>', // 5 연한 빨강
    '<fill><patternFill patternType="solid"><fgColor rgb="FF1F3A8A"/><bgColor indexed="64"/></patternFill></fill>', // 6 진한 파랑(상단 띠)
    '<fill><patternFill patternType="solid"><fgColor rgb="FF3563F0"/><bgColor indexed="64"/></patternFill></fill>', // 7 파랑(구역 제목)
    '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F4F8"/><bgColor indexed="64"/></patternFill></fill>', // 8 연한 회색(항목명)
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE9EBF0"/><bgColor indexed="64"/></patternFill></fill>', // 9 회색(휴무)
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEAF1FF"/><bgColor indexed="64"/></patternFill></fill>'  // 10 연한 하늘(토요일)
  ];
  var THIN = '<left style="thin"><color rgb="FFBFC6D4"/></left><right style="thin"><color rgb="FFBFC6D4"/></right>' +
    '<top style="thin"><color rgb="FFBFC6D4"/></top><bottom style="thin"><color rgb="FFBFC6D4"/></bottom><diagonal/>';
  var BORDERS = [
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>' +
      '<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>',
    '<border>' + THIN + '</border>'
  ];
  var NUMFMTS = '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0"/>' +
    '<numFmt numFmtId="165" formatCode="#,##0&quot;원&quot;"/></numFmts>';

  // [이름, 글꼴, 채우기, 테두리, 숫자서식, 가로정렬, 줄바꿈]  — 앞의 10개(0~9)는 기존 인덱스 유지
  var XF_DEFS = [
    ['default', 0, 0, 0, 0, null, false],
    ['header', 1, 2, 1, 0, 'center', true],
    ['money', 0, 0, 1, 3, null, false],
    ['moneyBold', 1, 3, 1, 3, null, false],
    ['title', 2, 0, 0, 0, null, false],
    ['text', 0, 0, 1, 0, null, true],
    ['textBold', 1, 3, 1, 0, null, true],
    ['num', 0, 0, 1, 0, 'center', false],
    ['ok', 1, 4, 1, 0, 'center', false],
    ['bad', 1, 5, 1, 0, 'center', false],
    // ---- 새 스타일 ----
    ['band', 4, 6, 0, 0, 'left', false],       // 상단 큰 제목 띠
    ['sub', 5, 0, 0, 0, 'left', true],         // 회색 작은 설명
    ['section', 3, 7, 2, 0, 'left', false],    // 구역 제목 (파란 바)
    ['label', 1, 8, 2, 0, 'left', true],       // 항목명 (회색 칸)
    ['value', 0, 0, 2, 0, 'left', true],       // 값 (왼쪽 정렬)
    ['cText', 0, 0, 2, 0, 'center', true],     // 가운데 정렬 글자
    ['cSat', 8, 10, 2, 0, 'center', false],    // 토요일 (파랑)
    ['cSun', 7, 5, 2, 0, 'center', false],     // 일요일 (빨강)
    ['cOff', 5, 9, 2, 0, 'center', false],     // 휴무 (회색)
    ['hours', 0, 0, 2, 164, 'center', false],  // 시간 (소수 1자리)
    ['hoursTot', 1, 8, 2, 164, 'center', false],
    ['tot', 1, 8, 2, 0, 'center', true],       // 합계 행
    ['bigMoney', 6, 3, 2, 165, 'center', false], // 큰 실수령액
    ['bigLabel', 1, 3, 2, 0, 'center', false],
    ['warn', 1, 3, 2, 0, 'center', true],      // 노랑 강조 (예외 등)
    ['moneyC', 0, 0, 2, 3, 'right', false],    // 금액 (연한 테두리)
    ['moneyCBold', 1, 3, 2, 3, 'right', false],
    ['okC', 1, 4, 2, 0, 'center', true],       // 초록 (대상/지급)
    ['badC', 1, 5, 2, 0, 'center', true]       // 빨강 (제외)
  ];
  var STYLE = { plain: 0 };
  XF_DEFS.forEach(function (d, i) { STYLE[d[0]] = i; });

  var STYLES_XML = (function () {
    var xfs = XF_DEFS.map(function (d) {
      var al = '<alignment' + (d[5] ? ' horizontal="' + d[5] + '"' : '') + ' vertical="center"' + (d[6] ? ' wrapText="1"' : '') + '/>';
      return '<xf numFmtId="' + d[4] + '" fontId="' + d[1] + '" fillId="' + d[2] + '" borderId="' + d[3] + '" xfId="0"' +
        (d[4] ? ' applyNumberFormat="1"' : '') + ' applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' + al + '</xf>';
    });
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + NUMFMTS +
      '<fonts count="' + FONTS.length + '">' + FONTS.join('') + '</fonts>' +
      '<fills count="' + FILLS.length + '">' + FILLS.join('') + '</fills>' +
      '<borders count="' + BORDERS.length + '">' + BORDERS.join('') + '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="' + xfs.length + '">' + xfs.join('') + '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>';
  })();

  function esc(s) {
    return String(s)
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function colName(i) {
    var s = '';
    var n = i + 1;
    while (n > 0) {
      var m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function cellXml(ref, cell) {
    var v = cell, style;
    if (cell !== null && typeof cell === 'object') {
      v = cell.v;
      style = cell.s;
    }
    var sIdx = STYLE[style] !== undefined ? STYLE[style] : (typeof v === 'number' ? STYLE.num : STYLE.text);
    var sAttr = sIdx ? ' s="' + sIdx + '"' : '';
    if (v === null || v === undefined || v === '') {
      return sIdx ? '<c r="' + ref + '"' + sAttr + '/>' : '';
    }
    if (typeof v === 'number' && isFinite(v)) {
      return '<c r="' + ref + '"' + sAttr + '><v>' + v + '</v></c>';
    }
    return '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  }

  function sheetXml(sheet) {
    var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    // 시트 속성: 탭 색 / 한 페이지 너비에 맞춰 인쇄
    x += '<sheetPr>' + (sheet.tabColor ? '<tabColor rgb="' + sheet.tabColor + '"/>' : '') + '<pageSetUpPr fitToPage="1"/></sheetPr>';
    // 보기 설정: 눈금선 숨김 / 제목 행 틀 고정(freezeRows) / 첫 열 고정(freezeCols)
    var fr = sheet.freezeRows || 0, fc = sheet.freezeCols || 0;
    x += '<sheetViews><sheetView workbookViewId="0"' + (sheet.hideGrid ? ' showGridLines="0"' : '') + '>';
    if (fr || fc) {
      var tl = colName(fc) + (fr + 1);
      var active = fr && fc ? 'bottomRight' : (fr ? 'bottomLeft' : 'topRight');
      x += '<pane' + (fc ? ' xSplit="' + fc + '"' : '') + (fr ? ' ySplit="' + fr + '"' : '') +
        ' topLeftCell="' + tl + '" activePane="' + active + '" state="frozen"/><selection pane="' + active + '"/>';
    }
    x += '</sheetView></sheetViews>';
    x += '<sheetFormatPr defaultRowHeight="20" customHeight="1"/>';
    if (sheet.colWidths && sheet.colWidths.length) {
      x += '<cols>';
      sheet.colWidths.forEach(function (w, i) {
        x += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
      });
      x += '</cols>';
    }
    x += '<sheetData>';
    (sheet.rows || []).forEach(function (row, r) {
      if (!row || !row.length) return;
      var cells = '';
      row.forEach(function (cell, c) { cells += cellXml(colName(c) + (r + 1), cell); });
      var ht = sheet.rowHeights && sheet.rowHeights[r];
      if (cells) x += '<row r="' + (r + 1) + '"' + (ht ? ' ht="' + ht + '" customHeight="1"' : '') + '>' + cells + '</row>';
    });
    x += '</sheetData>';
    if (sheet.merges && sheet.merges.length) {
      x += '<mergeCells count="' + sheet.merges.length + '">';
      sheet.merges.forEach(function (m) { x += '<mergeCell ref="' + m + '"/>'; });
      x += '</mergeCells>';
    }
    x += '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>';
    x += '<pageSetup paperSize="9" orientation="' + (sheet.landscape ? 'landscape' : 'portrait') + '" fitToWidth="1" fitToHeight="0"/>';
    x += '</worksheet>';
    return x;
  }

  function safeSheetNames(sheets) {
    var used = {};
    return sheets.map(function (s, i) {
      var base = String(s.name || 'Sheet' + (i + 1)).replace(/[\[\]:*?\/\\]/g, '').trim().slice(0, 31) || 'Sheet' + (i + 1);
      var name = base, n = 2;
      while (used[name.toLowerCase()]) {
        var suffix = ' (' + n++ + ')';
        name = base.slice(0, 31 - suffix.length) + suffix;
      }
      used[name.toLowerCase()] = true;
      return name;
    });
  }

  /**
   * sheets: [{ name, rows: [[cell, ...], ...], colWidths?: [number], merges?: ['A1:D1'],
   *           tabColor?: 'FF3563F0', hideGrid?: bool, freezeRows?: n, freezeCols?: n, rowHeights?: {행번호(0부터): 높이}, landscape?: bool }]
   * cell  : 'text' | 123 | { v: any, s: 'header'|'money'|'moneyBold'|'title'|'text'|'textBold'|'num'|'ok'|'bad'|'plain' }
   * return: Uint8Array (.xlsx 바이너리)
   */
  function buildXlsx(sheets) {
    if (!sheets || !sheets.length) sheets = [{ name: 'Sheet1', rows: [] }];
    var names = safeSheetNames(sheets);
    var files = [];

    var ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>';
    sheets.forEach(function (_, i) {
      ct += '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    });
    ct += '</Types>';
    files.push({ name: '[Content_Types].xml', data: ct });

    files.push({
      name: '_rels/.rels',
      data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>'
    });

    var wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';
    names.forEach(function (n, i) {
      wb += '<sheet name="' + esc(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    });
    wb += '</sheets></workbook>';
    files.push({ name: 'xl/workbook.xml', data: wb });

    var rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    sheets.forEach(function (_, i) {
      rels += '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
    });
    rels += '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
    rels += '</Relationships>';
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: rels });

    files.push({ name: 'xl/styles.xml', data: STYLES_XML });
    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s) });
    });

    return zipStore(files);
  }

  return {
    XLSX_MIME: XLSX_MIME,
    crc32: crc32,
    zipStore: zipStore,
    buildXlsx: buildXlsx
  };
});

