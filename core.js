'use strict';

// 画面に依存しない処理（URLの組み立て、アサーション、インポート、レポート生成）。
// app.html では app.js より先に読み込む。Node.js のテスト（test/）からも読み込む。

/* ---------- ユーティリティ ---------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o));

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

function blankReq() {
  return {
    id: null, name: '', package: '', subpackage: '', method: 'GET', url: '',
    params: [], pathParams: [], headers: [], batchSelected: false,
    bodyType: 'none', body: '', form: [],
    auth: { type: 'none', user: '', pass: '', token: '' },
    asserts: [],
  };
}

function groupRequests(requests) {
  const packages = new Map();
  for (const request of requests) {
    const name = String(request.package || '').trim();
    const subname = String(request.subpackage || '').trim();
    if (!packages.has(name)) packages.set(name, new Map());
    const subs = packages.get(name);
    if (!subs.has(subname)) subs.set(subname, []);
    subs.get(subname).push(request);
  }
  return [...packages].map(([name, subs]) => ({ name, subgroups: [...subs].map(([name, requests]) => ({ name, requests })) }));
}

/* ---------- URL とクエリ ---------- */
function splitUrl(url) {
  const hi = url.indexOf('#');
  const hash = hi >= 0 ? url.slice(hi) : '';
  const rest = hi >= 0 ? url.slice(0, hi) : url;
  const qi = rest.indexOf('?');
  return { base: qi >= 0 ? rest.slice(0, qi) : rest, query: qi >= 0 ? rest.slice(qi + 1) : '', hash };
}
function dec(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } }
// ${変数} はエンコードせずに残す
function enc(s) {
  return encodeURIComponent(s).replace(/%24%7B(.*?)%7D/g, (m, inner) => '${' + dec(inner) + '}');
}
function queryRows(url) {
  const { query } = splitUrl(url);
  return query ? query.split('&').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return { on: true, k: dec(i >= 0 ? p.slice(0, i) : p), v: dec(i >= 0 ? p.slice(i + 1) : '') };
  }) : [];
}

// URL内のクエリはテンプレート、具体的な入力値は params に保持する。
function queryTemplateUrl(url, rows) {
  const { base, hash } = splitUrl(url);
  const query = rows.filter((p) => p.on && p.k).map((p) =>
    enc(p.k) + (p.v !== '' ? '=${' + p.k + '}' : '')).join('&');
  return base + (query ? '?' + query : '') + hash;
}
function syncQueryRows(url, rows = []) {
  const available = rows.filter((p) => p.on).slice();
  const enabled = queryRows(url).map((p) => {
    const i = available.findIndex((x) => x.k === p.k);
    const old = i >= 0 ? available.splice(i, 1)[0] : null;
    return p.v === '${' + p.k + '}' && old ? { ...p, v: old.v } : p;
  });
  return [...enabled, ...rows.filter((p) => !p.on)];
}

// パスでは {名前} と ${名前} の両方を扱う。
function pathTemplate(url, replace) {
  const { base, query, hash } = splitUrl(url);
  const authority = base.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i)?.[0] || '';
  const path = base.slice(authority.length).replace(/\$?\{([^{}\/]+)\}/g, replace);
  return authority + path + (query ? '?' + query : '') + hash;
}
function pathParamNames(url) {
  const names = new Set();
  pathTemplate(url, (match, name) => { names.add(name); return match; });
  return [...names];
}

/* ---------- 環境と送信先 ---------- */
function varsOf(env) {
  const m = {};
  if (env) for (const v of env.vars) if (v.on && v.k) m[v.k.trim()] = v.v;
  return m;
}
function sub(s, vars) {
  return String(s ?? '').replace(/\$\{([^}]+)\}/g, (m, k) => (Object.hasOwn(vars, k.trim()) ? vars[k.trim()] : m));
}
// 送信先 = 環境のベースURL + URL欄のパス。URL欄が http:// などから始まる場合はベースURLを使わない
const ABS = /^[a-z][a-z0-9+.-]*:\/\//i;
// ポート番号は環境に別で持ち、ベースURLのホスト名の後ろに付ける（ベースURL側に書いてあるポートは置き換える）
function envBase(e) {
  const base = (e.baseUrl || '').trim();
  const port = String(e.port || '').trim();
  if (!base || !port) return base;
  const m = base.match(/^([a-z][a-z0-9+.-]*:\/\/)?([^/?#]*)(.*)$/i);
  return (m[1] || '') + m[2].replace(/:\d*$/, '') + ':' + port + m[3];
}
function envBaseUrl(env, vars) {
  return env ? sub(envBase(env), vars).trim() : '';
}
function joinUrl(base, path) {
  return base.replace(/\/+$/, '') + (!path || /^[/?#]/.test(path) ? '' : '/') + path;
}
function b64(s) {
  let bin = '';
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
}

/* ---------- リクエスト組み立て ---------- */
// env は送信先の環境（なければ undefined）
function buildRequest(r, env) {
  const vars = varsOf(env);
  const pathValues = new Map((r.pathParams || []).filter((x) => x.on && x.k.trim() && x.v !== '').map((x) => [x.k.trim(), x.v]));
  let url = pathTemplate(r.url.trim(), (match, name) => {
    if (!pathValues.has(name.trim())) return match;
    const value = sub(pathValues.get(name.trim()), vars);
    // 未定義の環境変数をエンコードで隠さず、送信前の検出に残す。
    return /\$\{[^}]+\}/.test(value) ? value : encodeURIComponent(value);
  });
  const parts = splitUrl(url);
  const queryValues = (r.params || []).filter((p) => p.on && p.k);
  const query = parts.query.split('&').map((part) => {
    const i = part.indexOf('=');
    if (i < 0) return part;
    const key = dec(part.slice(0, i));
    const rowIndex = queryValues.findIndex((p) => p.k === key);
    const row = rowIndex >= 0 ? queryValues.splice(rowIndex, 1)[0] : null;
    if (!row || dec(part.slice(i + 1)) !== '${' + key + '}') return part;
    return part.slice(0, i + 1) + enc(sub(row.v, vars));
  }).join('&');
  url = sub(parts.base + (query ? '?' + query : '') + parts.hash, vars);
  const base = envBaseUrl(env, vars);
  if (base && !ABS.test(url)) url = joinUrl(base, url);
  if (url && !ABS.test(url) && !url.startsWith('/')) url = 'http://' + url;

  const headers = [];
  for (const x of r.headers) if (x.on && x.k.trim()) headers.push([sub(x.k, vars).trim(), sub(x.v, vars)]);
  const has = (n) => headers.some(([k]) => k.toLowerCase() === n);

  if (r.auth.type === 'basic' && !has('authorization')) {
    headers.push(['Authorization', 'Basic ' + b64(sub(r.auth.user, vars) + ':' + sub(r.auth.pass, vars))]);
  } else if (r.auth.type === 'bearer' && !has('authorization')) {
    headers.push(['Authorization', 'Bearer ' + sub(r.auth.token, vars).trim()]);
  }

  let body;
  if (!['GET', 'HEAD'].includes(r.method)) {
    if (r.bodyType === 'json') {
      body = sub(r.body, vars);
      if (!has('content-type')) headers.push(['Content-Type', 'application/json']);
    } else if (r.bodyType === 'text') {
      body = sub(r.body, vars);
      if (!has('content-type')) headers.push(['Content-Type', 'text/plain;charset=UTF-8']);
    } else if (r.bodyType === 'form') {
      const p = new URLSearchParams();
      for (const x of r.form) if (x.on && x.k) p.append(sub(x.k, vars), sub(x.v, vars));
      body = p.toString();
      if (!has('content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8']);
    }
  }
  return { method: r.method, url, headers, body };
}

/* ---------- アサーション ---------- */
const TARGETS = { status: 'ステータスコード', header: 'ヘッダー', body: 'ボディ(テキスト)', json: 'JSONパス', time: '応答時間(ms)' };
const OPS = { eq: '等しい', ne: '等しくない', contains: '含む', exists: '存在する', lt: 'より小さい', gt: 'より大きい' };

function jsonPath(obj, path) {
  const tokens = String(path).replace(/^\$\.?/, '').match(/[^.[\]]+/g) || [];
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    cur = cur[t];
  }
  return cur;
}
function evalAssert(a, res, vars) {
  let actual;
  if (a.target === 'status') actual = res.status;
  else if (a.target === 'time') actual = res.ms;
  else if (a.target === 'body') actual = res.text;
  else if (a.target === 'header') {
    const hit = res.headers.find(([k]) => k.toLowerCase() === a.path.trim().toLowerCase());
    actual = hit ? hit[1] : undefined;
  } else if (a.target === 'json') actual = res.json === undefined ? undefined : jsonPath(res.json, a.path);

  const exp = sub(a.value, vars);
  const str = actual === undefined ? undefined : (typeof actual === 'object' && actual !== null ? JSON.stringify(actual) : String(actual));
  let pass = false;
  if (a.op === 'exists') pass = actual !== undefined;
  else if (str === undefined) pass = false;
  else if (a.op === 'eq') pass = str === exp;
  else if (a.op === 'ne') pass = str !== exp;
  else if (a.op === 'contains') pass = str.includes(exp);
  else if (a.op === 'lt') pass = Number(str) < Number(exp);
  else if (a.op === 'gt') pass = Number(str) > Number(exp);
  return { pass, actual: str };
}

function checkAsserts(asserts, res, vars) {
  return asserts.map((a) => {
    const { pass, actual } = evalAssert(a, res, vars);
    const label = TARGETS[a.target] + (['header', 'json'].includes(a.target) ? ` [${a.path}]` : '');
    const cond = a.op === 'exists' ? OPS.exists : `「${a.value}」${a.op === 'eq' || a.op === 'ne' ? 'と' : a.op === 'contains' ? 'を' : ''}${OPS[a.op]}`;
    const shown = actual === undefined ? '(なし)' : actual.length > 120 ? actual.slice(0, 120) + '…' : actual;
    return { pass, text: `${label} が ${cond} — 実際: ${shown}` };
  });
}

/* ---------- インポート ---------- */
// 手書きやAIが作ったファイルでも読めるよう、省略された項目を補う
const normRows = (a) => (Array.isArray(a) ? a : []).map((x) => ({ on: x.on !== false, k: String(x.k ?? ''), v: String(x.v ?? '') }));
const envColor = (color) => /^#[0-9a-f]{6}$/i.test(color || '') ? color : '';
function normEnv(e) {
  return { id: uid(), name: String(e.name || '環境'), baseUrl: String(e.baseUrl ?? ''), port: String(e.port ?? ''), color: envColor(e.color), vars: normRows(e.vars) };
}
const batchSelectedOf = (r) => typeof r.batchSelected === 'boolean' ? r.batchSelected : r.recordEvidence === true;
function normReq(r) {
  const q = Object.assign(blankReq(), r, { id: uid() });
  q.url = String(q.url ?? '');
  q.package = String(q.package ?? '').trim();
  q.subpackage = String(q.subpackage ?? '').trim();
  q.batchSelected = batchSelectedOf(r);
  delete q.recordEvidence;
  q.headers = normRows(q.headers);
  q.pathParams = normRows(q.pathParams);
  q.form = normRows(q.form);
  q.params = syncQueryRows(q.url, normRows(q.params));
  q.auth = Object.assign(blankReq().auth, q.auth);
  q.asserts = (Array.isArray(q.asserts) ? q.asserts : []).map((a) => ({
    target: a.target in TARGETS ? a.target : 'status', path: String(a.path ?? ''),
    op: a.op in OPS ? a.op : 'eq', value: String(a.value ?? ''),
  }));
  return q;
}
// 旧形式（コレクション + 全体共通の環境）を、システムごとに環境を持つ形に直す
function systemsFromV1(collections, envs) {
  const cols = collections && collections.length ? collections : envs && envs.length ? [{ name: 'マイシステム', requests: [] }] : [];
  return cols.map((c) => ({ name: c.name, envs: envs || [], requests: c.requests || [] }));
}
// インポート用のテキストを読み、{ list }（システムの配列。未整形）か { error } を返す
function parseImport(text) {
  try {
    // AIの回答をそのまま貼った場合に備えて、コードブロックの中身だけを取り出す
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const src = (fence ? fence[1] : text).trim();
    if (!src) return { error: 'ファイルを選ぶか、JSONを貼り付けてください。' };
    let data;
    try { data = JSON.parse(src); } catch (e) { return { error: 'JSONとして読めません: ' + e.message }; }
    // 'restbench' は旧名で書き出したファイル
    if (!data || !['evirest', 'restbench'].includes(data.app)) return { error: 'EviRESTのインポート用JSONではありません（"app": "evirest" がありません）。' };
    const list = Array.isArray(data.systems) ? data.systems
      : Array.isArray(data.collections) ? systemsFromV1(data.collections, data.envs) : null;
    if (!list) return { error: '"systems" がありません。' };
    return { list: list.filter((x) => x && typeof x === 'object') };
  } catch (e) {
    return { error: 'インポートに失敗しました: ' + e.message };
  }
}
// list を systems に取り込む。同じ id があれば更新、なければ追加する（削除はしない）。
// 環境とリクエストの id は、同じシステムの中で突き合わせる。
// 戻り値: 件数（[追加, 更新]）と、更新したリクエスト
function mergeImport(systems, list) {
  const result = { sys: [0, 0], env: [0, 0], req: [0, 0], updatedReqs: [] };
  const idOf = (x) => (x.id != null && x.id !== '' ? String(x.id) : '');
  const items = (a) => (Array.isArray(a) ? a : []).filter((x) => x && typeof x === 'object');
  for (const raw of list) {
    let sys = idOf(raw) && systems.find((x) => x.id === idOf(raw));
    if (sys) {
      if (raw.name != null) sys.name = String(raw.name);
      result.sys[1]++;
    } else {
      sys = { id: idOf(raw) || uid(), name: String(raw.name || 'インポート'), envs: [], requests: [] };
      systems.push(sys);
      result.sys[0]++;
    }
    for (const e of items(raw.envs)) {
      const next = normEnv(e);
      const cur = idOf(e) && sys.envs.find((x) => x.id === idOf(e));
      if (!cur) { sys.envs.push({ ...next, id: idOf(e) || uid() }); result.env[0]++; continue; }
      // 書かれている項目だけ上書きする
      if (e.name != null) cur.name = next.name;
      if (e.baseUrl != null) cur.baseUrl = next.baseUrl;
      if (e.port != null) cur.port = next.port;
      if (e.color != null) cur.color = next.color;
      // 変数は名前で突き合わせる。値が空のものは、手元で入れた値（トークンなど）を消さないよう既存の値を残す
      for (const v of next.vars) {
        const old = cur.vars.find((x) => x.k === v.k);
        if (!old) cur.vars.push(v);
        else if (v.v !== '') old.v = v.v;
      }
      result.env[1]++;
    }
    for (const r of items(raw.requests)) {
      const next = { ...normReq(r), id: idOf(r) || uid() };
      const i = idOf(r) ? sys.requests.findIndex((x) => x.id === idOf(r)) : -1;
      if (i < 0) { sys.requests.push(next); result.req[0]++; continue; }
      sys.requests[i] = next; // リクエストは丸ごと置き換える
      result.req[1]++;
      result.updatedReqs.push(next);
    }
  }
  return result;
}

/* ---------- AI用プロンプト ---------- */
// インポートファイルをAIに作らせるための依頼文。書式を変えたら docs/import-format.md とここの両方を直す
const AI_PROMPT = [
  'あなたは、APIテストツール「EviREST」のインポートファイルを作る担当です。',
  '最後の「# 依頼」の内容をもとに、「# 書式」に従ったJSONを1つだけ出力してください。',
  '',
  '# 出力のルール',
  '- 出力はJSONだけにする。説明文は書かず、コードブロック1つにまとめる。',
  '- 書式にない項目は足さない。',
  '- 画面の階層は「システム ＞ 環境 ＞ パッケージ ＞ サブパッケージ ＞ リクエスト」。JSONでは分類名をリクエストの package・subpackage に書く。リクエストはシステムに1回だけ書く（同じシステムの全環境で共有される）。',
  '- システム・環境・リクエストには、それぞれ id を付ける（半角英数字とハイフン。例: crm / stg / users-list）。システムの id は全体で、環境とリクエストの id はシステムの中で重複させない。',
  '- 取り込み時に、同じ id のものは更新され、ない id のものは追加される。修正版を出すときは、前回と同じ id を使う。依頼に既存の id が書かれていれば、それをそのまま使う。',
  '- リクエストの url はドメインを含めず、パスだけを書く（例: /users?page=2）。ドメインは環境の baseUrl に、ポート番号は port に書く。',
  '- クエリは url に ?page=${page}&limit=${limit} のように書き、params に名前と値を入れる。従来の ?page=2&limit=20 も取り込める。',
  '- パスは /users/${id} と書き、pathParams に { "k": "id", "v": "値" } を入れる。{id} の記法も使える。',
  '- package・subpackage は分類名の文字列。未指定なら空文字。requests は入れ子にしない。',
  '- 環境の color は #0f766e のような6桁の色、または標準色を使う空文字。',
  '- batchSelected は一括実行の対象かを表す真偽値。依頼がなければ false。選択したリクエストだけを実行し、その結果はすべてエビデンスに保存する。',
  '- トークンやパスワードなどの秘密の値は書かない。${token} のような変数にして、各環境の vars に値が空の変数として入れる。',
  '- body と、asserts の value、port は、必ず文字列で書く（数値やオブジェクトにしない）。',
  '- 各リクエストに、ステータスコードのアサーションを少なくとも1つ付ける。',
  '- 依頼に書かれていない値は推測で埋めず、空にするか省略する。',
  '',
  '# 書式',
  "```json",
  "{",
  "  \"app\": \"evirest\",",
  "  \"version\": 2,",
  "  \"systems\": [",
  "    {",
  "      \"id\": \"crm\",",
  "      \"name\": \"システム名\",",
  "      \"envs\": [",
  "        {",
  "          \"id\": \"local\",",
  "          \"name\": \"ローカル\",",
  "          \"baseUrl\": \"http://localhost\",",
  "          \"port\": \"8080\",",
  "          \"vars\": [",
  "            {",
  "              \"k\": \"token\",",
  "              \"v\": \"\"",
  "            }",
  "          ],",
  "          \"color\": \"#0f766e\"",
  "        },",
  "        {",
  "          \"id\": \"stg\",",
  "          \"name\": \"検証\",",
  "          \"baseUrl\": \"https://stg.example.com\",",
  "          \"vars\": [",
  "            {",
  "              \"k\": \"token\",",
  "              \"v\": \"\"",
  "            }",
  "          ],",
  "          \"color\": \"#2563eb\"",
  "        }",
  "      ],",
  "      \"requests\": [",
  "        {",
  "          \"id\": \"users-list\",",
  "          \"name\": \"ユーザー一覧\",",
  "          \"method\": \"GET\",",
  "          \"url\": \"/tenants/${tenantId}/users?page=${page}&limit=${limit}\",",
  "          \"headers\": [",
  "            {",
  "              \"k\": \"Accept\",",
  "              \"v\": \"application/json\"",
  "            }",
  "          ],",
  "          \"auth\": {",
  "            \"type\": \"bearer\",",
  "            \"token\": \"${token}\"",
  "          },",
  "          \"asserts\": [",
  "            {",
  "              \"target\": \"status\",",
  "              \"op\": \"eq\",",
  "              \"value\": \"200\"",
  "            },",
  "            {",
  "              \"target\": \"json\",",
  "              \"path\": \"items[0].id\",",
  "              \"op\": \"exists\"",
  "            }",
  "          ],",
  "          \"package\": \"ユーザー\",",
  "          \"subpackage\": \"一覧\",",
  "          \"batchSelected\": true,",
  "          \"pathParams\": [",
  "            {",
  "              \"k\": \"tenantId\",",
  "              \"v\": \"demo-tenant\"",
  "            }",
  "          ],",
  "          \"params\": [",
  "            {",
  "              \"k\": \"page\",",
  "              \"v\": \"2\"",
  "            },",
  "            {",
  "              \"k\": \"limit\",",
  "              \"v\": \"20\"",
  "            }",
  "          ]",
  "        },",
  "        {",
  "          \"id\": \"users-create\",",
  "          \"name\": \"ユーザー登録\",",
  "          \"method\": \"POST\",",
  "          \"url\": \"/users\",",
  "          \"bodyType\": \"json\",",
  "          \"body\": \"{\\n  \\\"name\\\": \\\"山田太郎\\\"\\n}\",",
  "          \"asserts\": [",
  "            {",
  "              \"target\": \"status\",",
  "              \"op\": \"eq\",",
  "              \"value\": \"201\"",
  "            }",
  "          ],",
  "          \"package\": \"ユーザー\",",
  "          \"subpackage\": \"登録\",",
  "          \"batchSelected\": false",
  "        }",
  "      ]",
  "    }",
  "  ]",
  "}",
  "```",
  '',
  '# 各項目に書ける値',
  '- method: GET / POST / PUT / PATCH / DELETE / HEAD / OPTIONS / QUERY',
  '- params・pathParams・headers: { "k": 名前, "v": 値 } の配列',
  '- params・pathParams・headers・form・vars の行は on を省略すると有効。on: false で無効。値 v は文字列で書く。',
  '- ${id} はパス欄の値を優先し、空欄・無効なら環境変数 id を使う。{id} はパス欄の値が必要。',
  '- bodyType: none / json / text / form（省略時は none）',
  '  - json・text のときは body に本文を文字列で書く',
  '  - form のときは form に { "k": 名前, "v": 値 } の配列を書く',
  '- auth: { "type": "none" } / { "type": "bearer", "token": "..." } / { "type": "basic", "user": "...", "pass": "..." }',
  '  - それ以外の認証（APIキーなど）は headers に書く',
  '- asserts の target: status（ステータスコード） / header（レスポンスヘッダー） / body（ボディ全体） / json（JSONの中の値） / time（応答時間ミリ秒）',
  '  - header のときは path にヘッダー名、json のときは path に a.b[0].c の形のパスを書く（ワイルドカードは使えない）',
  '- asserts の op: eq（等しい） / ne（等しくない） / contains（含む） / exists（存在する。value は不要） / lt（より小さい） / gt（より大きい）',
  '- ${変数名} は、url・headers・body・form・auth・asserts の value で使える',
  '',
  '# 依頼',
  '（ここを書き換える。システム名、環境ごとのベースURLとポート番号、作ってほしいAPIの一覧や仕様を書く。OpenAPIの定義やcURLコマンドを貼ってもよい。既存のものを直したいときは、エクスポートしたJSONを貼って、直したい内容を書く）',
].join('\n');

/* ---------- テストエビデンス（HTML） ---------- */
const EV_MAX = 500000; // 1件あたりのボディ保存上限（文字数）
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api[-_]?key|password/i;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => new Date(t).toLocaleString('ja-JP', { hour12: false });

function evidenceHtml(list, masked) {
  const hdr = (rows) => (rows.length
    ? '<table class="kv">' + rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${masked && SENSITIVE.test(k) ? '＊＊＊（伏せ字）' : esc(v)}</td></tr>`).join('') + '</table>'
    : '<p class="none">なし</p>');
  const body = (text, full) => {
    if (!text) return '<p class="none">なし</p>';
    let shown = text; let note = '';
    if (!full) { try { shown = JSON.stringify(JSON.parse(text), null, 2); note = '<p class="note">※ JSONを整形して表示しています</p>'; } catch { /* そのまま */ } }
    else note = `<p class="note warn">※ 全 ${full.toLocaleString()} 文字のうち先頭 ${EV_MAX.toLocaleString()} 文字のみ記録しています</p>`;
    return note + `<pre>${esc(shown)}</pre>`;
  };
  const count = (v) => list.filter((e) => e.verdict === v).length;
  const summary = list.map((e, i) => `<tr><td>${i + 1}</td><td>${esc(e.caseId)}</td><td>${esc(e.title)}</td><td>${esc(e.method)}</td><td class="url">${esc(e.url)}</td>`
    + `<td>${e.ok ? e.status : '送信失敗'}</td><td class="v${esc(e.verdict)}">${e.verdict === '-' ? '判定なし' : e.verdict}</td><td>${esc(fmtTime(e.at))}</td><td>${esc(e.tester)}</td></tr>`).join('');
  const details = list.map((e, i) => `<section>
<h2>No.${i + 1}　${esc(e.caseId)}　${esc(e.title)}</h2>
<table class="kv">
<tr><th>判定</th><td class="v${esc(e.verdict)}">${e.verdict === '-' ? '判定なし（アサーション未設定）' : e.verdict}</td></tr>
<tr><th>実施日時</th><td>${esc(fmtTime(e.at))}</td></tr>
<tr><th>実施者</th><td>${esc(e.tester)}</td></tr>
<tr><th>システム / 環境</th><td>${esc([e.system, e.env].filter(Boolean).join(' / ') || 'なし')}</td></tr>
<tr><th>リクエスト</th><td>${esc(e.method)} ${esc(e.url)}</td></tr>
<tr><th>レスポンス</th><td>${e.ok ? `${e.status} ${esc(e.statusText)}　/　${e.ms} ms　/　${fmtSize(e.size)}` : '送信失敗'}</td></tr>
${e.memo ? `<tr><th>備考</th><td>${esc(e.memo).replace(/\n/g, '<br>')}</td></tr>` : ''}
</table>
<h3>検証結果</h3>
${e.asserts.length ? '<ul>' + e.asserts.map((a) => `<li class="${a.pass ? 'vOK' : 'vNG'}">${a.pass ? '✓' : '✗'} ${esc(a.text)}</li>`).join('') + '</ul>' : '<p class="none">アサーション未設定</p>'}
<h3>リクエストヘッダー</h3>${hdr(e.reqHeaders)}
<h3>リクエストボディ</h3>${body(e.reqBody, e.reqBodyFull)}
<h3>レスポンスヘッダー</h3>${hdr(e.resHeaders)}
<h3>レスポンスボディ</h3>${body(e.resBody, e.resBodyFull)}
</section>`).join('\n');
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>APIテストエビデンス</title><style>
body{font:13px/1.6 system-ui,"Hiragino Sans","Yu Gothic UI",sans-serif;color:#1d232b;margin:24px;max-width:1100px}
h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:32px 0 8px;padding:6px 10px;background:#eef1f4;border-left:4px solid #0f766e}
h3{font-size:13px;margin:14px 0 4px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #c9ced6;padding:4px 8px;text-align:left;vertical-align:top;word-break:break-all}
th{background:#f6f7f9;white-space:nowrap}table.kv th{width:1%}pre{margin:0;padding:8px;border:1px solid #c9ced6;background:#fafbfc;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;word-break:break-all}
.url{font-family:ui-monospace,Consolas,monospace;font-size:12px}.vOK{color:#15803d;font-weight:700}.vNG{color:#b91c1c;font-weight:700}ul{margin:0;padding-left:0;list-style:none}
.none,.note{color:#6b7480;margin:0 0 4px}.warn{color:#b45309}.meta{color:#6b7480;margin:0 0 16px}
@media print{body{margin:0}h2,h3{break-after:avoid}section{break-before:page}}
</style></head><body>
<h1>APIテストエビデンス</h1>
<p class="meta">出力日時: ${esc(fmtTime(Date.now()))}　/　全 ${list.length} 件（OK ${count('OK')}・NG ${count('NG')}・判定なし ${count('-')}）　/　認証情報ヘッダー: ${masked ? '伏せ字' : 'そのまま出力'}</p>
<table><tr><th>No</th><th>ケースID</th><th>確認内容</th><th>メソッド</th><th>URL</th><th>ステータス</th><th>判定</th><th>実施日時</th><th>実施者</th></tr>${summary}</table>
${details}
</body></html>`;
}

/* ---------- テストエビデンス（Excel） ---------- */
const XL_LINE = 1000;   // ボディ1行あたりの上限（超えたら次の行に送る）
const XL_CELL = 32000;  // Excelの1セル上限（32,767文字）より少なめ
// XMLに入れられない制御文字を除く
const xlText = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').replace(/\r\n?/g, '\n');
const XL_BORDER = { borderStyle: 'thin', borderColor: '#C9CED6' };
const XL_VERDICT = { OK: '#15803D', NG: '#B91C1C' };
const xlCell = (v, opt) => ({ value: xlText(v).slice(0, XL_CELL), type: String, alignVertical: 'top', wrap: true, ...XL_BORDER, ...opt });
const xlHead = (v, opt) => xlCell(v, { fontWeight: 'bold', backgroundColor: '#F6F7F9', wrap: false, ...opt });
const xlVerdict = (e, long) => xlCell(e.verdict === '-' ? (long ? '判定なし（アサーション未設定）' : '判定なし') : e.verdict,
  XL_VERDICT[e.verdict] ? { textColor: XL_VERDICT[e.verdict], fontWeight: 'bold' } : {});

function xlBodyRows(text, full) {
  if (!text) return [[null, { value: 'なし', type: String, textColor: '#6B7480' }]];
  const rows = [];
  let shown = text;
  if (full) {
    rows.push([null, { value: `※ 全 ${full.toLocaleString()} 文字のうち先頭 ${EV_MAX.toLocaleString()} 文字のみ記録しています`, type: String, textColor: '#B45309' }]);
  } else {
    try { shown = JSON.stringify(JSON.parse(text), null, 2); rows.push([null, { value: '※ JSONを整形して表示しています', type: String, textColor: '#6B7480' }]); } catch { /* そのまま */ }
  }
  for (const line of xlText(shown).split('\n')) {
    for (let i = 0; i === 0 || i < line.length; i += XL_LINE) {
      rows.push([null, { value: line.slice(i, i + XL_LINE), type: String, alignVertical: 'top', wrap: true }]);
    }
  }
  return rows;
}

function evidenceSheets(list, masked) {
  const count = (v) => list.filter((e) => e.verdict === v).length;
  const summary = {
    sheet: '一覧',
    stickyRowsCount: 4,
    columns: [{ width: 5 }, { width: 18 }, { width: 40 }, { width: 9 }, { width: 60 }, { width: 11 }, { width: 10 }, { width: 20 }, { width: 14 }],
    data: [
      [{ value: 'APIテストエビデンス', type: String, fontWeight: 'bold', fontSize: 14 }],
      [{ value: `出力日時: ${fmtTime(Date.now())}　/　全 ${list.length} 件（OK ${count('OK')}・NG ${count('NG')}・判定なし ${count('-')}）　/　認証情報ヘッダー: ${masked ? '伏せ字' : 'そのまま出力'}`, type: String, textColor: '#6B7480' }],
      [],
      ['No', 'ケースID', '確認内容', 'メソッド', 'URL', 'ステータス', '判定', '実施日時', '実施者'].map((t) => xlHead(t)),
      ...list.map((e, i) => [
        { value: i + 1, type: Number, alignVertical: 'top', ...XL_BORDER },
        xlCell(e.caseId), xlCell(e.title), xlCell(e.method), xlCell(e.url),
        xlCell(e.ok ? e.status : '送信失敗'), xlVerdict(e), xlCell(fmtTime(e.at)), xlCell(e.tester),
      ]),
    ],
  };

  const section = (t) => [{ value: t, type: String, fontWeight: 'bold', backgroundColor: '#EEF1F4', columnSpan: 2 }, null];
  const none = (t) => [[null, { value: t, type: String, textColor: '#6B7480' }]];
  const hdr = (rows) => (rows.length
    ? rows.map(([k, v]) => [xlHead(k, { wrap: true }), xlCell(masked && SENSITIVE.test(k) ? '＊＊＊（伏せ字）' : v)])
    : none('なし'));
  const details = list.map((e, i) => ({
    // シート名は31文字まで、一部の記号は使えない
    sheet: (e.caseId ? `${i + 1}_${e.caseId}` : `No.${i + 1}`).replace(/[[\]:*?/\\']/g, '_').slice(0, 31),
    columns: [{ width: 24 }, { width: 110 }],
    data: [
      [{ value: `No.${i + 1}　${e.caseId}　${e.title}`.trim(), type: String, fontWeight: 'bold', fontSize: 13, columnSpan: 2 }, null],
      [],
      [xlHead('判定'), xlVerdict(e, true)],
      [xlHead('実施日時'), xlCell(fmtTime(e.at))],
      [xlHead('実施者'), xlCell(e.tester)],
      [xlHead('システム / 環境'), xlCell([e.system, e.env].filter(Boolean).join(' / ') || 'なし')],
      [xlHead('リクエスト'), xlCell(`${e.method} ${e.url}`)],
      [xlHead('レスポンス'), xlCell(e.ok ? `${e.status} ${e.statusText}　/　${e.ms} ms　/　${fmtSize(e.size)}` : '送信失敗')],
      ...(e.memo ? [[xlHead('備考'), xlCell(e.memo)]] : []),
      [],
      section('検証結果'),
      ...(e.asserts.length
        ? e.asserts.map((a) => [xlCell(a.pass ? '✓ OK' : '✗ NG', { textColor: XL_VERDICT[a.pass ? 'OK' : 'NG'], fontWeight: 'bold' }), xlCell(a.text)])
        : none('アサーション未設定')),
      [],
      section('リクエストヘッダー'), ...hdr(e.reqHeaders),
      [],
      section('リクエストボディ'), ...xlBodyRows(e.reqBody, e.reqBodyFull),
      [],
      section('レスポンスヘッダー'), ...hdr(e.resHeaders),
      [],
      section('レスポンスボディ'), ...xlBodyRows(e.resBody, e.resBodyFull),
    ],
  }));
  return [summary, ...details];
}

// Node.js のテスト用
if (typeof module === 'object') {
  module.exports = {
    uid, clone, fmtSize, blankReq, groupRequests, splitUrl, dec, enc, queryRows, queryTemplateUrl, syncQueryRows, pathParamNames, varsOf, sub, ABS, envBase, envBaseUrl, joinUrl, b64, buildRequest, TARGETS, OPS, jsonPath, evalAssert, checkAsserts, normRows, batchSelectedOf, envColor, normEnv, normReq, systemsFromV1, parseImport, mergeImport, AI_PROMPT, EV_MAX, SENSITIVE, esc, fmtTime, evidenceHtml, XL_LINE, XL_CELL, xlText, xlBodyRows, evidenceSheets,
  };
}
