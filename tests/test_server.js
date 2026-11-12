#!/usr/bin/env node
/*
 * tests/test_server.js — Node 내장 HTTP 서버 API & .xlsx 바이너리 응답 통합 테스트
 */
'use strict';

const assert = require('assert');
const http = require('http');
const { createServer } = require('../server/app.js');

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  console.log('=== [통합 테스트] 서버 API & 정적 서빙 & .xlsx 검증 ===');
  const server = createServer({ quiet: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    // 1. /api/health
    const h = await request(port, 'GET', '/api/health');
    assert.strictEqual(h.status, 200);
    assert.strictEqual(JSON.parse(h.body.toString()).ok, true);
    console.log('  ✓ GET /api/health');

    // 2. /api/parse-text
    const pt = await request(port, 'POST', '/api/parse-text', { text: '영희 80시간 만원' });
    assert.strictEqual(pt.status, 200);
    const parsed = JSON.parse(pt.body.toString());
    assert.strictEqual(parsed.name, '영희');
    assert.strictEqual(parsed.hourlyWage, 10000);
    console.log('  ✓ POST /api/parse-text');

    // 3. /api/payroll & /api/payroll/excel
    const pr = await request(port, 'POST', '/api/payroll', {
      input: { name: '영희', hourlyWage: 10000, totalHours: 80, includeWeekly: true, tax: '3.3' }
    });
    assert.strictEqual(pr.status, 200);
    assert.strictEqual(JSON.parse(pr.body.toString()).gross, 960000);

    const px = await request(port, 'POST', '/api/payroll/excel', {
      input: { name: '영희', hourlyWage: 10000, totalHours: 80 }
    });
    assert.strictEqual(px.status, 200);
    assert.strictEqual(px.body[0], 0x50);
    assert.strictEqual(px.body[1], 0x4b);
    console.log('  ✓ POST /api/payroll & /api/payroll/excel (.xlsx ZIP)');

    // 4. /api/checklist & /api/checklist/excel
    const ck = await request(port, 'POST', '/api/checklist', {
      input: { store: '테스트점', checks: Array.from({ length: 41 }, (_, i) => i + 1) }
    });
    assert.strictEqual(ck.status, 200);
    assert.strictEqual(JSON.parse(ck.body.toString()).allPass, true);

    const cx = await request(port, 'POST', '/api/checklist/excel', {
      input: { store: '테스트점', checks: Array.from({ length: 41 }, (_, i) => i + 1) }
    });
    assert.strictEqual(cx.status, 200);
    assert.strictEqual(cx.body[0], 0x50);
    console.log('  ✓ POST /api/checklist & /api/checklist/excel (.xlsx ZIP)');

    // 5. 정적 index.html 서빙
    const idx = await request(port, 'GET', '/');
    assert.strictEqual(idx.status, 200);
    assert.ok(idx.body.toString('utf8').includes('사장님 도우미'));
    console.log('  ✓ GET / (web/index.html 정적 서빙)');

    console.log('\n모든 서버 통합 테스트 통과!\n');
  } finally {
    server.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

