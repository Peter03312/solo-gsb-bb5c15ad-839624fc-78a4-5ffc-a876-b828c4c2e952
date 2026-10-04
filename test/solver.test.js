'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { solve } = require('../src/solver');
const { ordinalFromIso, isoFromOrdinal } = require('../src/dates');

function events(...titles) {
  return titles.map((title, i) => ({ id: i + 1, title }));
}
function sel(claimId, start, end) {
  return {
    claimId,
    startOrd: ordinalFromIso(start),
    endOrd: ordinalFromIso(end),
    source: '',
    label: `${start}~${end}`,
  };
}
function selectedMap(arr) {
  const m = new Map();
  arr.forEach((s, i) => m.set(i + 1, s));
  return m;
}

test('日精度严格先后：同日无解，次日可行', () => {
  const evs = events('A', 'B');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];

  let r = solve(evs, selectedMap([sel(1, '1958-03-01', '1958-03-01'), sel(2, '1958-03-01', '1958-03-01')]), rels);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'temporal');
  assert.deepStrictEqual(r.errors[0].eventIds, [1, 2]);
  assert.deepStrictEqual(r.errors[0].relationIds, [1]);

  r = solve(evs, selectedMap([sel(1, '1958-03-01', '1958-03-01'), sel(2, '1958-03-02', '1958-03-02')]), rels);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(isoFromOrdinal(r.dates.get(1)), '1958-03-01');
  assert.strictEqual(isoFromOrdinal(r.dates.get(2)), '1958-03-02');
});

test('粗粒度跨区间传播：12月 → 次年1月 可行，→ 同年1月 无解', () => {
  const evs = events('动员会', '通水');
  const rels = [{ id: 1, earlierId: 1, laterId: 2 }];

  const ok = solve(
    evs,
    selectedMap([sel(10, '1958-12-01', '1958-12-31'), sel(20, '1959-01-01', '1959-01-31')]),
    rels
  );
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(isoFromOrdinal(ok.dates.get(2)), '1959-01-01');

  const bad = solve(
    evs,
    selectedMap([sel(10, '1958-12-01', '1958-12-31'), sel(20, '1958-01-01', '1958-01-31')]),
    rels
  );
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.errors[0].type, 'temporal');
});

test('长链传播把后期事件推出区间', () => {
  const evs = events('A', 'B', 'C');
  const rels = [
    { id: 1, earlierId: 1, laterId: 2 },
    { id: 2, earlierId: 2, laterId: 3 },
  ];
  const r = solve(
    evs,
    selectedMap([
      sel(1, '1958-01-01', '1958-12-31'),
      sel(2, '1958-01-01', '1958-12-31'),
      sel(3, '1958-01-05', '1958-01-10'), // 最早被迫到 1958-01-03，仍可行
    ]),
    rels
  );
  assert.strictEqual(r.ok, true);

  const r2 = solve(
    evs,
    selectedMap([
      sel(1, '1958-12-01', '1958-12-31'),
      sel(2, '1958-12-01', '1958-12-31'),
      sel(3, '1958-01-01', '1958-01-10'),
    ]),
    rels
  );
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.errors[0].type, 'temporal');
  assert.deepStrictEqual(r2.errors[0].eventIds, [1, 2, 3]);
  assert.deepStrictEqual(r2.errors[0].relationIds, [1, 2]);
});

test('关系成环：报 cycle 且列出涉事事件与关系', () => {
  const evs = events('A', 'B', 'C');
  const rels = [
    { id: 1, earlierId: 1, laterId: 2 },
    { id: 2, earlierId: 2, laterId: 3 },
    { id: 3, earlierId: 3, laterId: 1 },
  ];
  const r = solve(
    evs,
    selectedMap([
      sel(1, '1958-01-01', '1958-12-31'),
      sel(2, '1958-01-01', '1958-12-31'),
      sel(3, '1958-01-01', '1958-12-31'),
    ]),
    rels
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'cycle');
  assert.deepStrictEqual(new Set(r.errors[0].eventIds), new Set([1, 2, 3]));
  assert.deepStrictEqual(new Set(r.errors[0].relationIds), new Set([1, 2, 3]));
});

test('自环也是环', () => {
  const evs = events('A');
  const r = solve(evs, selectedMap([sel(1, '1958-01-01', '1958-12-31')]), [
    { id: 9, earlierId: 1, laterId: 1 },
  ]);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'cycle');
});

test('缺少被选主张报 missing 并指出事件', () => {
  const evs = events('A', 'B');
  const r = solve(evs, new Map([[1, sel(1, '1958-01-01', '1958-01-01')]]), []);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'missing');
  assert.deepStrictEqual(r.errors[0].eventIds, [2]);
});

test('无边时各事件取区间起点', () => {
  const evs = events('A', 'B');
  const r = solve(
    evs,
    selectedMap([sel(1, '1962-01-01', '1962-12-31'), sel(2, '1962-10-01', '1962-10-31')]),
    []
  );
  assert.strictEqual(r.ok, true);
  assert.strictEqual(isoFromOrdinal(r.dates.get(1)), '1962-01-01');
  assert.strictEqual(isoFromOrdinal(r.dates.get(2)), '1962-10-01');
});

// ---------- 长链（数千事件逐日相接）：回归调用栈溢出 ----------

function chainGraph(n) {
  const evs = [];
  const rels = [];
  for (let i = 1; i <= n; i++) evs.push({ id: i, title: `事件${i}` });
  for (let i = 1; i < n; i++) {
    rels.push({ id: 10000 + i, earlierId: i, laterId: i + 1, source: `链证${i}` });
  }
  return { evs, rels };
}

test('6000 事件可解长链：不溢出，每个求解日在区间内且关系两端严格相差一天', () => {
  const N = 6000;
  const { evs, rels } = chainGraph(N);
  // 每事件区间恰好为链上该轮到的那一天（区间足够覆盖 +5999 天的传播）
  const selected = new Map();
  for (let i = 1; i <= N; i++) {
    const ord = ordinalFromIso('1958-01-01') + (i - 1);
    selected.set(i, {
      claimId: i,
      startOrd: ord,
      endOrd: ord,
      source: '',
      label: `第${i}日`,
    });
  }
  const r = solve(evs, selected, rels);
  assert.strictEqual(r.ok, true);
  for (let i = 1; i <= N; i++) {
    const ord = r.dates.get(i);
    assert.ok(ord >= ordinalFromIso('1958-01-01') + i - 1 && ord <= ordinalFromIso('1958-01-01') + i - 1);
    if (i > 1) assert.strictEqual(ord, r.dates.get(i - 1) + 1, `关系 ${i - 1} 两端必须恰好相差一天`);
  }
});

test('6000 事件首尾相接后闭合成环：报 cycle 且见证含全部事件与关系', () => {
  const N = 6000;
  const { evs, rels } = chainGraph(N);
  rels.push({ id: 99999, earlierId: N, laterId: 1 }); // 闭合成大环
  const selected = new Map();
  for (let i = 1; i <= N; i++) {
    const ord = ordinalFromIso('1958-01-01') + (i - 1);
    selected.set(i, { claimId: i, startOrd: ord, endOrd: ord, source: '', label: `第${i}日` });
  }
  const r = solve(evs, selected, rels);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'cycle');
  assert.strictEqual(new Set(r.errors[0].eventIds).size, N);
  assert.deepStrictEqual(new Set(r.errors[0].relationIds), new Set([...rels.map((x) => x.id)]));
});

test('6000 事件长链末端附近的小环也能检出（不溢出）', () => {
  const N = 6000;
  const { evs, rels } = chainGraph(N);
  rels.push({ id: 99999, earlierId: N, laterId: N - 2 }); // 末端 3 节点小环
  const selected = new Map();
  for (let i = 1; i <= N; i++) {
    selected.set(i, {
      claimId: i,
      startOrd: ordinalFromIso('1958-01-01'),
      endOrd: ordinalFromIso('1980-12-31'),
      source: '',
      label: '宽区间',
    });
  }
  const r = solve(evs, selected, rels);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'cycle');
  assert.deepStrictEqual(new Set(r.errors[0].eventIds), new Set([N - 2, N - 1, N]));
});

test('6000 事件长链时间无解：见证链一路追到末端事件（不溢出）', () => {
  const N = 6000;
  const { evs, rels } = chainGraph(N);
  // 全部钉死在同一天：第二个事件就被迫 +1，矛盾在链首附近即可见证
  const selected = new Map();
  for (let i = 1; i <= N; i++) {
    const ord = ordinalFromIso('1958-03-01');
    selected.set(i, { claimId: i, startOrd: ord, endOrd: ord, source: '', label: '同日' });
  }
  const r = solve(evs, selected, rels);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'temporal');
  assert.ok(r.errors[0].eventIds.length >= 2);
  assert.ok(r.errors[0].relationIds.length >= 1);
  assert.deepStrictEqual(r.errors[0].eventIds[0], 1);
});

test('6000 事件长链矛盾仅在末端显现：见证链覆盖整条链', () => {
  const N = 6000;
  const { evs, rels } = chainGraph(N);
  // 前 N-1 个事件区间宽，最后一个只允许 1958-01-01（链迫使它到约 1974 年）
  const selected = new Map();
  for (let i = 1; i < N; i++) {
    selected.set(i, {
      claimId: i,
      startOrd: ordinalFromIso('1958-01-01'),
      endOrd: ordinalFromIso('1980-12-31'),
      source: '',
      label: '宽区间',
    });
  }
  const ord0 = ordinalFromIso('1958-01-01');
  selected.set(N, { claimId: N, startOrd: ord0, endOrd: ord0, source: '', label: '钉死首日' });
  const r = solve(evs, selected, rels);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.errors[0].type, 'temporal');
  // 末端事件为矛盾点，链回溯到链首
  assert.strictEqual(r.errors[0].eventIds[0], 1);
  assert.strictEqual(r.errors[0].eventIds.at(-1), N);
  assert.strictEqual(r.errors[0].eventIds.length, N);
  assert.strictEqual(r.errors[0].relationIds.length, N - 1);
});
