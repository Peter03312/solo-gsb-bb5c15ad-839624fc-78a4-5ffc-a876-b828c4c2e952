'use strict';

// 长链回归：编辑者分批整理出逐日相接的 6000 个事件与 5999 条「先于」关系后，
// 校验（validate）、即时发布（publish）、预约建立（schedules）必须对同一草稿
// 得出一致结果，且不再因递归求解触发调用栈溢出（HTTP 500）。
//
// 为避免上万次 HTTP 往返，事件 / 主张 / 关系直接批量写入内存库；
// 三个被测入口仍全部走真实 HTTP。

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb, getDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app, scheduler } = require('../src/server');
const { ordinalFromIso, isoFromOrdinal } = require('../src/dates');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  scheduler.stop();
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM publish_schedules;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
  `);
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Editor-Token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const N = 6000;

// 批量构造链 1 先于 2 先于 … 先于 N；event i 的日精度主张钉在 base+(i-1) 天。
// closeTail=true 时再加一条 N→1 闭合成大环。
function seedChain({ closeCycle = false, pinSameDay = false } = {}) {
  const db = getDb();
  const insEvent = db.prepare('INSERT INTO events (title, description) VALUES (?, ?)');
  const insClaim = db.prepare(`
    INSERT INTO claims (event_id, precision, year, month, day, date_label,
                        interval_start, interval_end, source, note)
    VALUES (?, 'day', ?, ?, ?, ?, ?, ?, ?, '')
  `);
  const insRel = db.prepare('INSERT INTO relations (earlier_id, later_id, source, note) VALUES (?, ?, ?, ?)');

  const baseOrd = ordinalFromIso('1958-01-01');
  const selection = [];
  const tx = db.transaction(() => {
    for (let i = 1; i <= N; i++) {
      const eid = insEvent.run(`事件${i}`, '').lastInsertRowid;
      const ord = pinSameDay ? baseOrd : baseOrd + (i - 1);
      const iso = isoFromOrdinal(ord);
      const [y, m, d] = iso.split('-').map(Number);
      const cid = insClaim.run(eid, y, m, d, iso, iso, iso, `链证${i}`).lastInsertRowid;
      selection.push({ eventId: eid, claimId: cid });
    }
    for (let i = 1; i < N; i++) insRel.run(i, i + 1, `链证${i}`, '');
    if (closeCycle) insRel.run(N, 1, '闭合成环', '');
  });
  tx();
  return selection;
}

function hoursFromNow(h) {
  return new Date(Date.now() + h * 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function countRows(table) {
  return getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
}

test('可解长链：validate / publish / 预约三处一致，求解日在区间内且严格相差一天', async () => {
  const selection = seedChain();

  // 1) 发布前校验（旧实现在此调用栈溢出 → 500）
  const v = await call('POST', '/api/editor/validate', { selection });
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.json.ok, true, JSON.stringify(v.json).slice(0, 300));
  assert.strictEqual(v.json.preview.length, N);

  // preview 已按求解日升序，事件 i 的求解日即链上第 i 天
  const byEvent = new Map(v.json.preview.map((p) => [p.eventId, p]));
  const baseOrd = ordinalFromIso('1958-01-01');
  for (let i = 1; i <= N; i++) {
    const p = byEvent.get(i);
    assert.strictEqual(p.resolvedDate, isoFromOrdinal(baseOrd + i - 1));
    assert.strictEqual(p.resolvedDate >= p.intervalStart && p.resolvedDate <= p.intervalEnd, true);
  }
  assert.strictEqual(v.json.preview[0].resolvedDate, '1958-01-01');
  assert.strictEqual(v.json.preview.at(-1).resolvedDate, isoFromOrdinal(baseOrd + N - 1));

  // 2) 即时发布成功（基于第 0 版）→ 第 1 版，快照求解日与校验完全一致
  const p = await call('POST', '/api/editor/publish', { selection, baseVersionNo: 0, editor: '长链编辑' });
  assert.strictEqual(p.status, 201, JSON.stringify(p.json).slice(0, 300));
  assert.strictEqual(p.json.versionNo, 1);
  assert.strictEqual(p.json.version.eventCount, N);
  assert.strictEqual(p.json.version.relationCount, N - 1);
  const publishedDate = new Map(p.json.version.events.map((e) => [e.eventId, e.resolvedDate]));
  for (const row of v.json.preview) {
    assert.strictEqual(publishedDate.get(row.eventId), row.resolvedDate);
  }

  // 3) 同稿建立预约（基于第 1 版）：冻结求解日与前两处一致
  const s = await call('POST', '/api/editor/schedules', {
    selection,
    scheduledAt: hoursFromNow(2),
    baseVersionNo: 1,
    editor: '长链编辑',
  });
  assert.strictEqual(s.status, 201, JSON.stringify(s.json).slice(0, 300));
  assert.strictEqual(s.json.schedule.status, 'pending');
  assert.strictEqual(s.json.schedule.eventCount, N);
  assert.strictEqual(s.json.schedule.relationCount, N - 1);
  const frozenDate = new Map(s.json.schedule.frozen.events.map((e) => [e.eventId, e.resolvedDate]));
  for (const row of v.json.preview) {
    assert.strictEqual(frozenDate.get(row.eventId), row.resolvedDate);
  }

  // 预约尚未到期，版本仍只有 1 个
  assert.strictEqual(countRows('versions'), 1);
  assert.strictEqual(countRows('publish_schedules'), 1);

  // 访客公开读出仍正常
  const pub = await fetch(`${base}/api/public/chronicle`).then((r) => r.json());
  assert.strictEqual(pub.currentVersionNo, 1);
  assert.strictEqual(pub.version.events.length, N);
});

test('长链闭合成环：三处同一 cycle 见证；发布与预约均不落库', async () => {
  const selection = seedChain({ closeCycle: true });

  const v = await call('POST', '/api/editor/validate', { selection });
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.json.ok, false);
  assert.strictEqual(v.json.errors[0].type, 'cycle');
  assert.strictEqual(new Set(v.json.errors[0].eventIds).size, N);
  assert.strictEqual(v.json.errors[0].relationIds.length, N);

  const p = await call('POST', '/api/editor/publish', { selection, baseVersionNo: 0 });
  assert.strictEqual(p.status, 422);
  assert.strictEqual(p.json.errors[0].type, 'cycle');
  assert.deepStrictEqual(new Set(p.json.errors[0].eventIds), new Set(v.json.errors[0].eventIds));
  assert.deepStrictEqual(new Set(p.json.errors[0].relationIds), new Set(v.json.errors[0].relationIds));

  const s = await call('POST', '/api/editor/schedules', {
    selection,
    scheduledAt: hoursFromNow(2),
    baseVersionNo: 0,
  });
  assert.strictEqual(s.status, 422);
  assert.strictEqual(s.json.errors[0].type, 'cycle');

  // 失败不写版本、不写预约
  assert.strictEqual(countRows('versions'), 0);
  assert.strictEqual(countRows('publish_schedules'), 0);
});

test('长链时间无解：三处同一 temporal 见证（事件与关系）；均不落库', async () => {
  // 全部事件钉在 1958-01-01：关系 1→2 即刻矛盾
  const selection = seedChain({ pinSameDay: true });

  const v = await call('POST', '/api/editor/validate', { selection });
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.json.ok, false);
  assert.strictEqual(v.json.errors[0].type, 'temporal');
  assert.ok(v.json.errors[0].eventIds.includes(1));
  assert.ok(v.json.errors[0].eventIds.includes(2));
  assert.ok(v.json.errors[0].relationIds.length >= 1);

  const p = await call('POST', '/api/editor/publish', { selection, baseVersionNo: 0 });
  assert.strictEqual(p.status, 422);
  assert.strictEqual(p.json.errors[0].type, 'temporal');
  assert.deepStrictEqual(p.json.errors[0].eventIds, v.json.errors[0].eventIds);
  assert.deepStrictEqual(p.json.errors[0].relationIds, v.json.errors[0].relationIds);

  const s = await call('POST', '/api/editor/schedules', {
    selection,
    scheduledAt: hoursFromNow(2),
    baseVersionNo: 0,
  });
  assert.strictEqual(s.status, 422);
  assert.strictEqual(s.json.errors[0].type, 'temporal');

  assert.strictEqual(countRows('versions'), 0);
  assert.strictEqual(countRows('publish_schedules'), 0);
});

test('长链可解但基准版本过期：先校验通过，发布 / 预约仍报 409 且不写预约', async () => {
  const selection = seedChain();
  const v = await call('POST', '/api/editor/validate', { selection });
  assert.strictEqual(v.json.ok, true);

  // 先发布第 1 版；再带着过期基准 0 去发布 / 建预约
  const first = await call('POST', '/api/editor/publish', { selection, baseVersionNo: 0 });
  assert.strictEqual(first.status, 201);

  const stale = await call('POST', '/api/editor/publish', { selection, baseVersionNo: 0 });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(stale.json.currentVersionNo, 1);

  const s = await call('POST', '/api/editor/schedules', {
    selection,
    scheduledAt: hoursFromNow(2),
    baseVersionNo: 0,
  });
  assert.strictEqual(s.status, 409);
  assert.strictEqual(s.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(countRows('publish_schedules'), 0);
  assert.strictEqual(countRows('versions'), 1); // 仅首次发布存在
});
