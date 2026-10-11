'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const core = require('../core.js');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const batchSource = source.slice(source.indexOf('// 次の送信までの待ち時間'), source.indexOf('/* ---------- アサーション'));
function setup(send) {
  const nodes = new Map();
  const node = () => ({ children: [], replaceChildren(...children) { this.children = children; }, append(child) { this.children.push(child); } });
  const original = core.blankReq();
  original.url = '/unsaved';
  const context = vm.createContext({
    EV_MAX: core.EV_MAX, uid: core.uid, build: (r) => core.buildRequest(r), Date,
    batch: null, ctrl: null, req: original, blankReq: core.blankReq, clone: core.clone,
    curSystem: () => ({ name: 'API', requests: [{ name: 'first', url: '/1', batchSelected: true }, { name: 'second', url: '/2', batchSelected: true }] }),
    curEnv: () => ({ name: 'test', vars: [] }), varsOf: core.varsOf, checkAsserts: core.checkAsserts,
    $: (id) => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
    h: (_tag, _attrs, ...children) => Object.assign(node(), { children }),
    tabs: [], showTab(group, tab) { context.tabs.push([group, tab]); },
    state: { evidence: [], batchInterval: 500 }, renderEvidence() {}, updateBatchControls() {}, syncUI() {}, persist() {}, toast() {},
    // 待ち時間はテスト用に短くする（500ms → 20ms）
    batchIntervalOf: core.batchIntervalOf, setTimeout: (fn, ms) => setTimeout(fn, ms / 25), clearTimeout,
  });
  context.send = () => send(context);
  vm.runInContext(batchSource, context);
  return { context, nodes, original };
}
test('一括実行: 保存順に待機して実行し、完了後に編集内容を戻す', async () => {
  const order = [];
  let active = 0;
  const { context, nodes, original } = setup(async (ctx) => {
    assert.equal(active++, 0);
    order.push(ctx.req.name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    return { ok: true, status: 200, ms: 5 };
  });
  await context.runBatch();
  assert.deepEqual(order, ['first', 'second']);
  assert.equal(context.state.evidence.length, 2);
  assert.equal(context.req, original);
  assert.equal(context.batch, null);
  assert.deepEqual(Array.from(context.tabs.at(-1)), ['res', 'batch']);
  assert.equal(nodes.get('#request').inert, false);
  assert.match(nodes.get('#batchResults').children[0].textContent, /完了（2 \/ 2 件）/);
});
test('一括実行: 中止後は次を送信せず、通信エラー時も編集内容を戻す', async () => {
  let calls = 0;
  const { context, nodes, original } = setup(async (ctx) => {
    calls++;
    await ctx.runBatch();
    return { ok: false, error: '中止', ms: 1 };
  });
  await context.runBatch();
  assert.equal(calls, 1);
  assert.equal(context.req, original);
  assert.match(nodes.get('#batchResults').children[0].textContent, /中止（1 \/ 2 件）/);
  const failed = setup(async () => { throw new Error('failure'); });
  await failed.context.runBatch();
  assert.equal(failed.context.req, failed.original);
  assert.equal(failed.nodes.get('#request').inert, false);
  assert.equal(failed.context.batch, null);
});

test('一括実行レポート: 送信時の内容を保持し、HTMLとExcelに出力できる', () => {
  const { context } = setup(async () => {});
  const request = Object.assign(core.blankReq(), { name: '<test>', url: '/users/${id}' });
  const result = {
    ok: true, status: 200, ms: 12, size: 3, at: Date.now(), text: 'ok',
    req: { method: 'GET', url: 'https://api.example.com/users/123', headers: [['Authorization', 'secret']] },
    headers: [['content-type', 'text/plain']],
  };
  const entry = context.batchEvidence(request, result, [{ pass: true, text: 'status' }], true, 'API', 'test', 'OK');
  result.req.url = 'https://changed.example.com';
  result.req.headers[0][1] = 'changed';
  assert.equal(entry.url, 'https://api.example.com/users/123');
  assert.equal(entry.reqHeaders[0][1], 'secret');
  const html = core.evidenceHtml([entry], true);
  assert.match(html, /https:\/\/api.example.com\/users\/123/);
  assert.match(html, /&lt;test&gt;/);
  assert.ok(!html.includes('secret'));
  assert.ok(core.evidenceSheets([entry], true).length > 0);
});

test('一括実行: チェックしたものだけ送信し、実行結果をすべてエビデンスに保存する', async () => {
  let calls = 0;
  const { context } = setup(async () => { calls++; return { ok: true, status: 200, ms: 1, headers: [], text: '' }; });
  context.state = { evidence: [] };
  context.renderEvidence = () => {};
  context.curSystem = () => ({ name: 'API', requests: [
    { name: 'selected', url: '/1', batchSelected: true },
    { name: 'unselected', url: '/2', batchSelected: false },
  ] });
  await context.runBatch();
  assert.equal(calls, 1);
  assert.equal(context.state.evidence.length, 1);
  assert.equal(context.state.evidence[0].title, 'selected');
});


test('一括実行: 未選択なら送信せず、エビデンスも作らない', async () => {
  let calls = 0;
  const { context, original } = setup(async () => { calls++; });
  context.curSystem = () => ({ name: 'API', requests: [{ url: '/1', batchSelected: false }] });
  await context.runBatch();
  assert.equal(calls, 0);
  assert.equal(context.state.evidence.length, 0);
  assert.equal(context.req, original);
});

test('一括実行: 1件終わってから、間隔をあけて次を送る', async () => {
  const times = [];
  const { context, nodes } = setup(async () => {
    times.push(['start', Date.now()]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    times.push(['end', Date.now()]);
    return { ok: true, status: 200, ms: 5 };
  });
  await context.runBatch();
  assert.equal(times.length, 4);
  assert.ok(times[2][1] - times[1][1] >= 15, `1件目の終了から2件目の開始まで待つ（実際: ${times[2][1] - times[1][1]}ms）`);
  assert.equal(nodes.get('#batchInterval').disabled, false, '終了後は間隔を変更できる');
});

test('一括実行: 待機中に中止すると、待ち時間を残さず終わり、次は送らない', async () => {
  let calls = 0;
  const { context, nodes } = setup(async () => { calls++; return { ok: true, status: 200, ms: 1 }; });
  context.setTimeout = setTimeout; // 待ち時間を短縮しない（500ms）
  const started = Date.now();
  const running = context.runBatch();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(nodes.get('#batchResults').children[0].textContent, /次の送信まで待機中（0.5秒間隔）/);
  await context.runBatch(); // 中止
  await running;
  assert.ok(Date.now() - started < 300, '500msの待ち時間を待たずに終わる');
  assert.equal(calls, 1);
  assert.match(nodes.get('#batchResults').children[0].textContent, /中止（1 \/ 2 件）/);
});

test('実行間隔: 選べる値以外は1秒にする（間隔なしにはできない）', () => {
  assert.equal(core.batchIntervalOf(2000), 2000);
  assert.equal(core.batchIntervalOf('500'), 500);
  for (const v of [0, -1, 100, undefined, null, 'x']) assert.equal(core.batchIntervalOf(v), 1000);
  assert.ok(Math.min(...core.BATCH_INTERVALS) >= 500);
});
