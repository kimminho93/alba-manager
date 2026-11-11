#!/usr/bin/env node
/*
 * server/app.js — 외부 패키지 없이 Node.js 표준 모듈(http, fs, path)만으로 동작하는 서버
 *   - 정적 파일: web/ 서빙
 *   - API
 *       GET  /api/health
 *       POST /api/parse-text        { text }
 *       POST /api/payroll           { input }
 *       POST /api/payroll/excel     { input } | { roster: [input, ...] }   → .xlsx
 *       POST /api/checklist         { input }
 *       POST /api/checklist/excel   { input } | { archive: [input, ...] }  → .xlsx
 *
 *   node server/app.js [--port 8000] [--static]
 *     --static : API 비활성화 (GitHub Pages 와 같은 '웹 단독' 모드 시뮬레이션)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const E = require('../include/alba_engine.js');

const WEB_ROOT = path.resolve(__dirname, '..', 'web');
const MAX_BODY = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8'
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function sendXlsx(res, bytes, filename) {
  const buf = Buffer.from(bytes);
  res.writeHead(200, {
    'Content-Type': E.XLSX_MIME,
    'Content-Length': buf.length,
    'Content-Disposition': "attachment; filename=\"download.xlsx\"; filename*=UTF-8''" + encodeURIComponent(filename),
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, '요청 본문이 너무 큽니다.'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch (e) {
        reject(new HttpError(400, 'JSON 형식이 올바르지 않습니다.'));
      }
    });
    req.on('error', reject);
  });
}

function asList(v, label) {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, label + ' 목록이 비어 있습니다.');
  if (v.length > 500) throw new HttpError(400, label + ' 목록은 최대 500건입니다.');
  return v;
}

const ROUTES = {
  'GET /api/health': () => ({ json: { ok: true, engine: E.ENGINE_VERSION, runtime: 'node ' + process.version } }),

  'POST /api/parse-text': (body) => ({ json: E.parseText(String(body.text || '')) }),

  'POST /api/payroll': (body) => ({ json: E.calculatePayroll(body.input || body) }),

  'POST /api/payroll/excel': (body) => {
    if (body.roster) {
      const results = asList(body.roster, '정산 명단').map(E.calculatePayroll);
      return { xlsx: E.payrollRosterXlsx(results), filename: E.rosterFileName(results) };
    }
    const r = E.calculatePayroll(body.input || body);
    return { xlsx: E.payrollSlipXlsx(r), filename: E.payrollFileName(r) };
  },

  'POST /api/checklist': (body) => ({ json: E.buildChecklist(body.input || body) }),

  'POST /api/checklist/excel': (body) => {
    if (body.archive) {
      const results = asList(body.archive, '점검 보관함').map(E.buildChecklist);
      return { xlsx: E.checklistArchiveXlsx(results), filename: E.archiveFileName(results) };
    }
    const c = E.buildChecklist(body.input || body);
    return { xlsx: E.checklistXlsx(c), filename: E.checklistFileName(c) };
  }
};

function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    return sendJson(res, 400, { error: '잘못된 경로' });
  }
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(WEB_ROOT, '.' + rel);
  if (file !== WEB_ROOT && !file.startsWith(WEB_ROOT + path.sep)) {
    return sendJson(res, 403, { error: '접근할 수 없는 경로' });
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache'
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

function createServer(opts) {
  const staticOnly = !!(opts && opts.staticOnly);
  const quiet = !!(opts && opts.quiet);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const started = Date.now();
    try {
      if (pathname.startsWith('/api/')) {
        if (staticOnly) throw new HttpError(404, '웹 단독 모드: API 비활성화');
        const handler = ROUTES[req.method + ' ' + pathname];
        if (!handler) throw new HttpError(404, '존재하지 않는 API: ' + req.method + ' ' + pathname);
        const body = req.method === 'POST' ? await readJson(req) : {};
        const out = handler(body);
        if (out.xlsx) sendXlsx(res, out.xlsx, out.filename);
        else sendJson(res, 200, out.json);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url.pathname);
      } else {
        throw new HttpError(405, '허용되지 않는 메서드');
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500 && !quiet) console.error(e);
      sendJson(res, status, { error: e.message || '서버 오류' });
    } finally {
      if (!quiet && pathname.startsWith('/api/')) {
        console.log('[api] ' + req.method + ' ' + pathname + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms');
      }
    }
  });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const pi = args.indexOf('--port');
  const port = Number(pi >= 0 ? args[pi + 1] : process.env.PORT) || 8000;
  const staticOnly = args.includes('--static');

  try {
    require('../tools/build.js').build({ quiet: true }); // web/engine.js 를 src 와 항상 동기화
  } catch (e) {
    console.warn('[build] web/engine.js 갱신 실패 (기존 파일 사용):', e.message);
  }

  createServer({ staticOnly }).listen(port, () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' 사장님 도우미 ' + (staticOnly ? '[웹 단독 모드 · API 꺼짐]' : '[서버 모드 · API 켜짐]'));
    console.log(' http://localhost:' + port + '/');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  });
}

module.exports = { createServer, ROUTES };

