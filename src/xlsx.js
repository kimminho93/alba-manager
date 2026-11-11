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
  var STYLE = {
    default: 0, header: 1, money: 2, moneyBold: 3, title: 4,
    text: 5, textBold: 6, num: 7, ok: 8, bad: 9, plain: 0
  };

  var STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3">' +
    '<font><sz val="11"/><name val="맑은 고딕"/><family val="2"/></font>' +
    '<font><b/><sz val="11"/><name val="맑은 고딕"/><family val="2"/></font>' +
    '<font><b/><sz val="15"/><name val="맑은 고딕"/><family val="2"/></font>' +
    '</fonts>' +
    '<fills count="6">' +
    '<fill><patternFill patternType="none"/></fill>' +
    '<fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFDDE7F5"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF4CC"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFE3F7EC"/><bgColor indexed="64"/></patternFill></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFFDE2E2"/><bgColor indexed="64"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="2">' +
    '<border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left style="thin"><color auto="1"/></left><right style="thin"><color auto="1"/></right>' +
    '<top style="thin"><color auto="1"/></top><bottom style="thin"><color auto="1"/></bottom><diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="10">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
    '<xf numFmtId="3" fontId="1" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '<xf numFmtId="0" fontId="1" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';

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
      if (cells) x += '<row r="' + (r + 1) + '">' + cells + '</row>';
    });
    x += '</sheetData>';
    if (sheet.merges && sheet.merges.length) {
      x += '<mergeCells count="' + sheet.merges.length + '">';
      sheet.merges.forEach(function (m) { x += '<mergeCell ref="' + m + '"/>'; });
      x += '</mergeCells>';
    }
    x += '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>';
    x += '<pageSetup paperSize="9" orientation="portrait" fitToWidth="1"/>';
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
   * sheets: [{ name, rows: [[cell, ...], ...], colWidths?: [number], merges?: ['A1:D1'] }]
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

