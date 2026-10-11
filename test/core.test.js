'use strict';

// core.js（画面に依存しない処理）のテスト。実行: pnpm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const core = require('../core.js');

const kv = (k, v, on = true) => ({ on, k, v });
const env = (baseUrl, port = '', vars = []) => ({ id: 'e', name: '検証', baseUrl, port, vars });
const reqOf = (over) => Object.assign(core.blankReq(), over);

/* ---------- URL とクエリ ---------- */
test('splitUrl: パス・クエリ・ハッシュに分ける', () => {
  assert.deepEqual(core.splitUrl('/users?a=1&b=2#top'), { base: '/users', query: 'a=1&b=2', hash: '#top' });
  assert.deepEqual(core.splitUrl('/users'), { base: '/users', query: '', hash: '' });
});

test('queryRows: クエリを表の行にする', () => {
  assert.deepEqual(core.queryRows('/users?page=2&q=a%20b&flag'), [kv('page', '2'), kv('q', 'a b'), kv('flag', '')]);
  assert.deepEqual(core.queryRows('/users'), []);
});

test('enc: ${変数} はエンコードせずに残す', () => {
  assert.equal(core.enc('a b&c'), 'a%20b%26c');
  assert.equal(core.enc('${token}'), '${token}');
  assert.equal(core.enc('x-${id}-y'), 'x-${id}-y');
});

/* ---------- 環境と送信先 ---------- */
test('varsOf: 有効な変数だけを取り出す', () => {
  assert.deepEqual(core.varsOf(env('', '', [kv('a', '1'), kv('b', '2', false), kv('', '3')])), { a: '1' });
  assert.deepEqual(core.varsOf(undefined), {});
});

test('sub: 定義済みの変数だけ置き換える', () => {
  assert.equal(core.sub('Bearer ${token} ${none}', { token: 'abc' }), 'Bearer abc ${none}');
  assert.equal(core.sub(undefined, {}), '');
});

test('envBase: ポート番号をホスト名の後ろに付ける', () => {
  assert.equal(core.envBase(env('http://localhost', '8080')), 'http://localhost:8080');
  assert.equal(core.envBase(env('http://localhost:3000', '8080')), 'http://localhost:8080', 'ベースURL側のポートは置き換える');
  assert.equal(core.envBase(env('https://a.example.com/v1', '8443')), 'https://a.example.com:8443/v1');
  assert.equal(core.envBase(env('http://[::1]', '8080')), 'http://[::1]:8080');
  assert.equal(core.envBase(env('https://a.example.com', '')), 'https://a.example.com');
  assert.equal(core.envBase(env('', '8080')), '');
});

/* ---------- リクエスト組み立て ---------- */
test('buildRequest: ベースURLとパスをつなぐ', () => {
  const url = (base, p, port) => core.buildRequest(reqOf({ url: p }), env(base, port)).url;
  assert.equal(url('https://stg.example.com', '/users?a=1'), 'https://stg.example.com/users?a=1');
  assert.equal(url('https://stg.example.com/', 'users'), 'https://stg.example.com/users');
  assert.equal(url('https://stg.example.com/v1/', '/users'), 'https://stg.example.com/v1/users');
  assert.equal(url('https://stg.example.com', ''), 'https://stg.example.com');
  assert.equal(url('http://localhost', '/users', '8080'), 'http://localhost:8080/users');
  assert.equal(url('localhost:8080', '/u'), 'http://localhost:8080/u', 'スキームがなければ http を補う');
});

test('buildRequest: URL欄が絶対URLならベースURLを使わない', () => {
  assert.equal(core.buildRequest(reqOf({ url: 'https://other.example.com/x' }), env('https://stg.example.com')).url, 'https://other.example.com/x');
});

test('buildRequest: 環境がないとき', () => {
  assert.equal(core.buildRequest(reqOf({ url: 'example.com/x' }), undefined).url, 'http://example.com/x');
  assert.equal(core.buildRequest(reqOf({ url: '/users' }), undefined).url, '/users', '送信先が決まらない（送信側で止める）');
  assert.equal(core.ABS.test('/users'), false);
});

test('buildRequest: 変数をURL・ヘッダー・ボディに展開する', () => {
  const e = env('https://${host}', '', [kv('host', 'h.example'), kv('id', '7'), kv('token', 'T')]);
  const b = core.buildRequest(reqOf({
    method: 'POST', url: '/users/${id}', headers: [kv('X-Trace', '${id}'), kv('X-Off', '1', false)],
    bodyType: 'json', body: '{"id": ${id}}', auth: { type: 'bearer', token: '${token}' },
  }), e);
  assert.equal(b.url, 'https://h.example/users/7');
  assert.deepEqual(b.headers, [['X-Trace', '7'], ['Authorization', 'Bearer T'], ['Content-Type', 'application/json']]);
  assert.equal(b.body, '{"id": 7}');
});

test('buildRequest: 認証とContent-Typeは、ヘッダーに書いてあればそちらを優先する', () => {
  const b = core.buildRequest(reqOf({
    method: 'POST', url: 'http://a/', headers: [kv('authorization', 'X'), kv('content-type', 'application/vnd.api+json')],
    bodyType: 'json', body: '{}', auth: { type: 'basic', user: 'u', pass: 'p' },
  }));
  assert.deepEqual(b.headers, [['authorization', 'X'], ['content-type', 'application/vnd.api+json']]);
});

test('buildRequest: Basic認証は日本語も扱える', () => {
  const b = core.buildRequest(reqOf({ url: 'http://a/', auth: { type: 'basic', user: '山田', pass: 'p' } }));
  assert.equal(Buffer.from(b.headers[0][1].replace('Basic ', ''), 'base64').toString('utf8'), '山田:p');
});

test('buildRequest: フォームのボディ、GETではボディを送らない', () => {
  const form = [kv('name', 'a b'), kv('x', '1', false)];
  assert.equal(core.buildRequest(reqOf({ method: 'POST', url: 'http://a/', bodyType: 'form', form })).body, 'name=a+b');
  assert.equal(core.buildRequest(reqOf({ method: 'GET', url: 'http://a/', bodyType: 'json', body: '{}' })).body, undefined);
});

/* ---------- アサーション ---------- */
const res = {
  status: 200, ms: 120, text: '{"data":{"items":[{"id":5,"tags":["a"]}],"n":null}}',
  headers: [['content-type', 'application/json; charset=utf-8']],
  json: { data: { items: [{ id: 5, tags: ['a'] }], n: null } },
};
const passOf = (a) => core.evalAssert(Object.assign({ path: '', value: '' }, a), res, { want: '200' }).pass;

test('jsonPath: ドットと添字でたどる', () => {
  assert.equal(core.jsonPath(res.json, 'data.items[0].id'), 5);
  assert.equal(core.jsonPath(res.json, '$.data.items[0].tags[0]'), 'a');
  assert.equal(core.jsonPath(res.json, 'data.none.x'), undefined);
});

test('evalAssert: 対象と条件ごとの判定', () => {
  assert.equal(passOf({ target: 'status', op: 'eq', value: '200' }), true);
  assert.equal(passOf({ target: 'status', op: 'eq', value: '${want}' }), true, '期待値に変数が使える');
  assert.equal(passOf({ target: 'status', op: 'ne', value: '200' }), false);
  assert.equal(passOf({ target: 'time', op: 'lt', value: '500' }), true);
  assert.equal(passOf({ target: 'time', op: 'gt', value: '500' }), false);
  assert.equal(passOf({ target: 'body', op: 'contains', value: '"items"' }), true);
  assert.equal(passOf({ target: 'header', path: 'Content-Type', op: 'contains', value: 'json' }), true, 'ヘッダー名は大文字小文字を区別しない');
  assert.equal(passOf({ target: 'header', path: 'x-none', op: 'exists' }), false);
  assert.equal(passOf({ target: 'json', path: 'data.items[0].id', op: 'eq', value: '5' }), true);
  assert.equal(passOf({ target: 'json', path: 'data.items[0].tags', op: 'eq', value: '["a"]' }), true);
  assert.equal(passOf({ target: 'json', path: 'data.n', op: 'exists' }), true, 'null は「存在する」');
  assert.equal(passOf({ target: 'json', path: 'data.none', op: 'exists' }), false);
  assert.equal(passOf({ target: 'json', path: 'data.none', op: 'ne', value: 'x' }), false, '値がなければ「等しくない」も失敗');
});

test('checkAsserts: 結果の文言', () => {
  const out = core.checkAsserts([{ target: 'status', path: '', op: 'eq', value: '201' }, { target: 'json', path: 'data.none', op: 'exists', value: '' }], res, {});
  assert.deepEqual(out.map((x) => x.pass), [false, false]);
  assert.match(out[0].text, /ステータスコード が 「201」と等しい — 実際: 200/);
  assert.match(out[1].text, /JSONパス \[data\.none\] が 存在する — 実際: \(なし\)/);
});

/* ---------- インポート ---------- */
// テキストを読んで systems に取り込む（画面の importText と同じ流れ）
function imp(text, systems = []) {
  const { list, error } = core.parseImport(typeof text === 'string' ? text : JSON.stringify(text));
  if (error) return { error };
  return { systems, result: core.mergeImport(systems, list) };
}
const sample = () => fs.readFileSync(path.join(__dirname, '../docs/import-sample.json'), 'utf8');

test('インポート: 同梱の見本を読める', () => {
  const { systems, error, result } = imp(sample());
  assert.equal(error, undefined);
  assert.deepEqual([result.sys, result.env, result.req], [[1, 0], [2, 0], [3, 0]]);
  assert.equal(systems[0].id, 'crm');
  assert.deepEqual(systems[0].envs.map((e) => [e.id, e.name, e.baseUrl, e.port]), [['local', 'ローカル', 'http://localhost', '8080'], ['stg', '検証', 'https://stg.example.com', '']]);
  const [list] = systems[0].requests;
  assert.equal(list.id, 'users-list');
  assert.deepEqual(list.params, [kv('page', '2'), kv('limit', '20')], 'URLのクエリが表に展開される');
  assert.equal(list.auth.type, 'bearer');
  assert.equal(list.asserts.length, 3);
});

test('インポート: AI用プロンプトに載せた見本を読める', () => {
  const { systems, error } = imp(core.AI_PROMPT);
  assert.equal(error, undefined);
  assert.deepEqual([systems[0].id, systems[0].envs.map((e) => e.id), systems[0].requests.map((r) => r.id)], ['crm', ['local', 'stg'], ['users-list', 'users-create']]);
  assert.equal(systems[0].requests[1].body, '{\n  "name": "山田太郎"\n}');
});

test('インポート: 説明文つきのコードブロックから取り出す', () => {
  const { systems } = imp('回答です。\n```json\n{"app":"evirest","systems":[{"name":"S"}]}\n```\n以上です。');
  assert.equal(systems[0].name, 'S');
  assert.deepEqual(systems[0].envs, []);
});

test('インポート: 省略された項目を補い、不正な値を直す', () => {
  const { systems } = imp({
    app: 'evirest', systems: [{ requests: [{ url: '/a', headers: [{ k: 'X', v: 1 }], auth: { type: 'bearer' }, asserts: [{ target: 'bogus', op: 'bogus', value: 200 }] }, null, 'x'] }],
  });
  const r = systems[0].requests[0];
  assert.equal(systems[0].requests.length, 1, 'オブジェクトでない要素は無視する');
  assert.equal(systems[0].name, 'インポート');
  assert.equal(r.method, 'GET');
  assert.deepEqual(r.headers, [kv('X', '1')]);
  assert.deepEqual(r.auth, { type: 'bearer', user: '', pass: '', token: '' });
  assert.deepEqual(r.asserts, [{ target: 'status', path: '', op: 'eq', value: '200' }]);
  assert.ok(systems[0].id && r.id, 'id がなければ採番する');
});

test('インポート: 旧形式（コレクション＋共通の環境）を変換する', () => {
  const { systems } = imp({
    app: 'restbench', version: 1, collections: [{ name: 'C1', requests: [{ url: 'http://a/b?x=1' }] }, { name: 'C2' }], envs: [{ name: 'E', vars: [{ k: 'a', v: 'b' }] }],
  });
  assert.deepEqual(systems.map((s) => [s.name, s.envs.map((e) => e.name), s.requests.length]), [['C1', ['E'], 1], ['C2', ['E'], 0]]);
  assert.notEqual(systems[0].envs[0].id, systems[1].envs[0].id, '環境はシステムごとに別のものになる');
});

test('インポート: 読めない入力はエラーを返す', () => {
  assert.match(imp('').error, /貼り付けてください/);
  assert.match(imp('{"app":"evirest"').error, /JSONとして読めません/);
  assert.match(imp('{"app":"other","systems":[]}').error, /インポート用JSONではありません/);
  assert.match(imp('{"app":"evirest"}').error, /"systems" がありません/);
  assert.match(imp('null').error, /インポート用JSONではありません/);
});

test('インポート: 同じ id は更新、ない id は追加、書かれていないものは残す', () => {
  const { systems } = imp(sample());
  systems[0].envs[1].vars[0].v = 'MY-TOKEN'; // 画面で入れたトークン
  const { result } = imp({
    app: 'evirest', systems: [{
      id: 'crm', name: '顧客管理（改）',
      envs: [{ id: 'stg', baseUrl: 'https://stg2.example.com', vars: [{ k: 'token', v: '' }, { k: 'tenant', v: 't1' }] }, { id: 'prod', name: '本番', baseUrl: 'https://api.example.com' }],
      requests: [{ id: 'users-list', name: '一覧（改）', url: '/v2/users' }, { id: 'users-delete', method: 'DELETE', url: '/users/1' }],
    }],
  }, systems);
  assert.deepEqual([result.sys, result.env, result.req], [[0, 1], [1, 1], [1, 1]]);
  assert.equal(systems.length, 1);
  assert.equal(systems[0].name, '顧客管理（改）');
  assert.deepEqual(systems[0].envs.map((e) => e.id), ['local', 'stg', 'prod'], '書かれていない環境は残り、新しい環境は追加される');
  const stg = systems[0].envs[1];
  assert.deepEqual([stg.name, stg.baseUrl], ['検証', 'https://stg2.example.com'], '書かれた項目だけ上書きする');
  assert.deepEqual(stg.vars.map((v) => [v.k, v.v]), [['token', 'MY-TOKEN'], ['password', ''], ['tenant', 't1']], '空の値では既存の値を消さない');
  assert.deepEqual(systems[0].requests.map((r) => r.id), ['users-list', 'users-create', 'login', 'users-delete'], '並び順を保つ');
  const list = systems[0].requests[0];
  assert.deepEqual([list.name, list.url, list.asserts.length, list.auth.type], ['一覧（改）', '/v2/users', 0, 'none'], 'リクエストは丸ごと置き換える');
  assert.deepEqual(result.updatedReqs, [list]);
});

test('インポート: 同じファイルを2回取り込んでも増えない（id あり）／増える（id なし）', () => {
  const withId = imp(sample());
  const again = imp(sample(), withId.systems);
  assert.deepEqual([again.result.sys, again.result.env, again.result.req], [[0, 1], [0, 2], [0, 3]]);
  assert.deepEqual([again.systems.length, again.systems[0].envs.length, again.systems[0].requests.length], [1, 2, 3]);
  const noId = { app: 'evirest', systems: [{ name: 'S', requests: [{ url: '/a' }] }] };
  assert.equal(imp(noId, imp(noId).systems).systems.length, 2);
});

test('インポート: 環境とリクエストの id は、システムが違えば別物として扱う', () => {
  const two = { app: 'evirest', systems: [
    { id: 'a', envs: [{ id: 'stg', baseUrl: 'https://a.example.com' }], requests: [{ id: 'list', url: '/a' }] },
    { id: 'b', envs: [{ id: 'stg', baseUrl: 'https://b.example.com' }], requests: [{ id: 'list', url: '/b' }] },
  ] };
  const { systems } = imp(two);
  imp({ app: 'evirest', systems: [{ id: 'b', requests: [{ id: 'list', url: '/b2' }] }] }, systems);
  assert.deepEqual(systems.map((s) => [s.envs[0].baseUrl, s.requests[0].url]), [['https://a.example.com', '/a'], ['https://b.example.com', '/b2']]);
});

/* ---------- テストエビデンス ---------- */
const evidence = (over) => Object.assign({
  id: 'x', caseId: 'IT-001', title: '登録できること', tester: '竹内', memo: '', at: Date.UTC(2026, 9, 12), system: '顧客管理', env: '検証',
  method: 'POST', url: 'https://stg.example.com/users?a=<b>', reqHeaders: [['Authorization', 'Bearer SECRET'], ['Content-Type', 'application/json']],
  reqBody: '{"name":"a"}', reqBodyFull: 0, ok: true, status: 201, statusText: 'Created', ms: 12, size: 34,
  resHeaders: [['x-api-key', 'KEY123']], resBody: '{"id":1}', resBodyFull: 0, asserts: [{ pass: true, text: 'ok' }], verdict: 'OK',
}, over);

test('evidenceHtml: 伏せ字とエスケープ', () => {
  const masked = core.evidenceHtml([evidence()], true);
  assert.ok(!masked.includes('SECRET') && !masked.includes('KEY123'), '認証系ヘッダーの値は出さない');
  assert.ok(masked.includes('application/json'), '認証系でないヘッダーは出す');
  assert.ok(masked.includes('users?a=&lt;b&gt;') && !masked.includes('a=<b>'), 'HTMLをエスケープする');
  assert.ok(masked.includes('顧客管理 / 検証'));
  assert.ok(core.evidenceHtml([evidence()], false).includes('Bearer SECRET'), '伏せ字なしならそのまま出す');
});

test('evidenceHtml: 件数の集計と打ち切りの注記', () => {
  const html = core.evidenceHtml([evidence(), evidence({ verdict: 'NG' }), evidence({ verdict: '-', asserts: [] }), evidence({ resBody: 'x', resBodyFull: 600000 })], true);
  assert.ok(html.includes('全 4 件（OK 2・NG 1・判定なし 1）'));
  assert.ok(html.includes('全 600,000 文字のうち先頭 500,000 文字のみ記録しています'));
});

test('xlBodyRows: JSONを整形し、長い行と制御文字を処理する', () => {
  const text = (rows) => rows.map((r) => r[1].value);
  assert.deepEqual(text(core.xlBodyRows('{"a":1}', 0)), ['※ JSONを整形して表示しています', '{', '  "a": 1', '}']);
  assert.deepEqual(text(core.xlBodyRows('', 0)), ['なし']);
  const long = text(core.xlBodyRows('x'.repeat(2500) + '\u0001\r\n\r\n=SUM(A1)', 0));
  assert.deepEqual(long.map((t) => t.length), [1000, 1000, 500, 0, 8], '1行1000文字で分け、制御文字を除き、空行を保つ');
  assert.ok(core.xlBodyRows('=SUM(A1)', 0).every((r) => r[1].type === String), '数式として扱わせない');
});

test('evidenceSheets: 一覧と、1件1シート', () => {
  const sheets = core.evidenceSheets([
    evidence(), evidence({ caseId: 'A/B:[とても長いケースIDでシート名の上限の31文字を超えるもの]' }), evidence({ caseId: '' }),
  ], true);
  assert.deepEqual(sheets.map((s) => s.sheet).slice(0, 2), ['一覧', '1_IT-001']);
  assert.equal(sheets[3].sheet, 'No.3');
  assert.ok(sheets.every((s) => s.sheet.length <= 31 && !/[[\]:*?/\\']/.test(s.sheet)), 'シート名の制約を守る');
  assert.equal(new Set(sheets.map((s) => s.sheet)).size, sheets.length, 'シート名が重複しない');
  const cells = JSON.stringify(sheets);
  assert.ok(!cells.includes('SECRET') && !cells.includes('KEY123'));
  assert.equal(sheets[0].data.length, 4 + 3, '見出し4行＋エビデンス3件');
});

test('evidenceSheets: 同梱ライブラリでExcelファイルにできる', async (t) => {
  const lib = path.join(__dirname, '../vendor/write-excel-file.min.js');
  if (!fs.existsSync(lib)) return t.skip('vendor/ がありません（pnpm install を実行してください）');
  const blob = await require(lib)(core.evidenceSheets([evidence(), evidence({ verdict: 'NG' })], true)).toBlob();
  const head = Buffer.from(await blob.arrayBuffer()).subarray(0, 2).toString('latin1');
  assert.equal(head, 'PK', 'xlsx（ZIP）として出力される');
});

/* ---------- その他 ---------- */
test('fmtSize', () => {
  assert.equal(core.fmtSize(512), '512 B');
  assert.equal(core.fmtSize(2048), '2.0 KB');
  assert.equal(core.fmtSize(3 * 1024 * 1024), '3.00 MB');
});

test('画面のファイルが core.js を app.js より先に読み込む', () => {
  const html = fs.readFileSync(path.join(__dirname, '../app.html'), 'utf8');
  assert.ok(html.indexOf('src="core.js"') > 0 && html.indexOf('src="core.js"') < html.indexOf('src="app.js"'));
});
