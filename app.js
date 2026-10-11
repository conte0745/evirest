'use strict';

/* ---------- ユーティリティ ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clone = (o) => JSON.parse(JSON.stringify(o));

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}

// ラベル付きの入力欄
const field = (label, el) => h('label', { class: 'field' }, h('span', {}, label), el);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

/* ---------- 保存領域 ---------- */
const KEY = 'restbench'; // 旧名のまま（変えると保存済みデータが読めなくなる）
const hasChrome = typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local;
const store = {
  async get() {
    if (hasChrome) return (await chrome.storage.local.get(KEY))[KEY];
    try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
  },
  async set(v) {
    if (hasChrome) return chrome.storage.local.set({ [KEY]: v });
    localStorage.setItem(KEY, JSON.stringify(v));
  },
};

function blankReq() {
  return {
    id: null, name: '', method: 'GET', url: '',
    params: [], headers: [],
    bodyType: 'none', body: '', form: [],
    auth: { type: 'none', user: '', pass: '', token: '' },
    asserts: [],
  };
}

// systems: [{ id, name, envs: [{ id, name, baseUrl, vars }], requests: [...] }]　リクエストは同じシステムの全環境で共有する
const state = { systems: [], activeSystem: '', activeEnv: '', history: [], draft: blankReq(), evidence: [], tester: '', maskEv: true };
let req = state.draft;      // 編集中のリクエスト
let last = null;            // 直近のレスポンス
let ctrl = null;            // 送信中の AbortController

let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 250);
}
function persistNow() {
  clearTimeout(saveTimer);
  return store.set(state).catch((e) => toast('保存に失敗: ' + e.message));
}
// タブを閉じる・切り替える直前の変更を取りこぼさない
document.addEventListener('visibilitychange', () => { if (document.hidden) persistNow(); });
window.addEventListener('pagehide', persistNow);

/* ---------- タブ切り替え ---------- */
function initTabs() {
  for (const nav of $$('nav.tabs')) {
    const group = nav.dataset.group;
    nav.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-tab]');
      if (!btn) return;
      showTab(group, btn.dataset.tab);
    });
  }
}
function showTab(group, tab) {
  const nav = $(`nav.tabs[data-group="${group}"]`);
  for (const b of $$('button', nav)) {
    const on = b.dataset.tab === tab;
    b.classList.toggle('on', on);
    $(`#${group}-${b.dataset.tab}`).hidden = !on;
  }
}

/* ---------- キー/値エディタ ---------- */
function kvEditor(box, rows, onChange, ph = ['名前', '値']) {
  const draw = (focusLast) => {
    const els = rows.map((row, i) => {
      const cb = h('input', { type: 'checkbox', title: '有効/無効' });
      cb.checked = row.on;
      cb.addEventListener('change', () => { row.on = cb.checked; cb.parentElement.classList.toggle('off', !row.on); onChange(); });
      const k = h('input', { type: 'text', placeholder: ph[0], spellcheck: 'false' });
      k.value = row.k;
      k.addEventListener('input', () => { row.k = k.value; onChange(); });
      const v = h('input', { type: 'text', placeholder: ph[1], spellcheck: 'false' });
      v.value = row.v;
      v.addEventListener('input', () => { row.v = v.value; onChange(); });
      const del = h('button', { class: 'icon', title: '削除', onclick: () => { rows.splice(i, 1); draw(); onChange(); } }, '×');
      return h('div', { class: 'kv' + (row.on ? '' : ' off') }, cb, k, v, del);
    });
    const head = els.length ? [h('div', { class: 'kv head' }, h('span'), h('span', {}, ph[0]), h('span', {}, ph[1]), h('span'))] : [];
    const add = h('button', { class: 'add', onclick: () => { rows.push({ on: true, k: '', v: '' }); draw(true); onChange(); } }, '＋ 追加');
    box.replaceChildren(...head, ...els, add);
    if (focusLast && els.length) $('input[type=text]', els[els.length - 1]).focus();
  };
  draw();
}

/* ---------- URL とクエリの同期 ---------- */
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
function paramsFromUrl() {
  const enabled = queryRows(req.url);
  const disabled = req.params.filter((p) => !p.on);
  req.params.splice(0, req.params.length, ...enabled, ...disabled);
  renderParams();
}
function urlFromParams() {
  const { base, hash } = splitUrl(req.url);
  const q = req.params.filter((p) => p.on && p.k)
    .map((p) => enc(p.k) + (p.v !== '' ? '=' + enc(p.v) : '')).join('&');
  req.url = base + (q ? '?' + q : '') + hash;
  $('#url').value = req.url;
}

/* ---------- 環境変数 ---------- */
const curSystem = () => state.systems.find((x) => x.id === state.activeSystem);
const curEnv = () => { const s = curSystem(); return s && s.envs.find((x) => x.id === state.activeEnv); };
function envVars() {
  const e = curEnv();
  const m = {};
  if (e) for (const v of e.vars) if (v.on && v.k) m[v.k.trim()] = v.v;
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
function baseUrl(vars) {
  const e = curEnv();
  return e ? sub(envBase(e), vars).trim() : '';
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
function build(r) {
  const vars = envVars();
  let url = sub(r.url, vars).trim();
  const base = baseUrl(vars);
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

/* ---------- 送信 ---------- */
async function send() {
  if (ctrl) { ctrl.abort(); return; }
  const b = build(req);
  if (!b.url) { toast('URLを入力してください'); return; }
  if (!ABS.test(b.url)) { toast('送信先が決まりません。左の一覧で環境を選ぶか、URLを http:// から入力してください'); return; }
  const unresolved = (b.url + JSON.stringify(b.headers) + (b.body || '')).match(/\$\{[^}]+\}/);

  const btn = $('#send');
  btn.textContent = '中止';
  setStatus('送信中…', '');
  ctrl = new AbortController();
  const t0 = performance.now();
  try {
    const res = await fetch(b.url, {
      method: b.method, headers: b.headers, body: b.body,
      signal: ctrl.signal, cache: 'no-store', credentials: 'omit', redirect: 'follow',
    });
    const buf = await res.arrayBuffer();
    const ms = Math.round(performance.now() - t0);
    const ct = res.headers.get('content-type') || '';
    last = {
      ok: true, status: res.status, statusText: res.statusText, ms, size: buf.byteLength,
      headers: [...res.headers], ct, url: res.url, text: '', json: undefined, image: null,
    };
    if (/^image\//i.test(ct)) {
      last.image = URL.createObjectURL(new Blob([buf], { type: ct }));
    } else {
      last.text = new TextDecoder().decode(buf);
      try { last.json = JSON.parse(last.text); } catch { /* JSONではない */ }
    }
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const aborted = e.name === 'AbortError';
    last = {
      ok: false, status: 0, statusText: '', ms, size: 0, headers: [], ct: '', url: b.url, json: undefined, image: null,
      text: aborted ? 'リクエストを中止しました。'
        : `リクエストに失敗しました: ${e.message}\n\n考えられる原因: URLの誤り / サーバー未起動 / DNS・証明書エラー / 不正なヘッダー名`,
      error: aborted ? '中止' : 'エラー',
    };
  } finally {
    ctrl = null;
    btn.textContent = '送信';
  }
  last.req = b;
  last.at = Date.now();
  last.sys = (curSystem() || {}).name || '';
  last.env = (curEnv() || {}).name || '';
  renderResponse();
  if (unresolved) toast('未定義の変数があります: ' + unresolved[0]);

  state.history.unshift({ id: uid(), at: Date.now(), status: last.status, ms: last.ms, sys: state.activeSystem, env: state.activeEnv, envName: last.env, req: clone(req) });
  state.history.length = Math.min(state.history.length, 100);
  renderHistory();
  persist();
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
function evalAssert(a, res) {
  let actual;
  if (a.target === 'status') actual = res.status;
  else if (a.target === 'time') actual = res.ms;
  else if (a.target === 'body') actual = res.text;
  else if (a.target === 'header') {
    const hit = res.headers.find(([k]) => k.toLowerCase() === a.path.trim().toLowerCase());
    actual = hit ? hit[1] : undefined;
  } else if (a.target === 'json') actual = res.json === undefined ? undefined : jsonPath(res.json, a.path);

  const exp = sub(a.value, envVars());
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

function runAsserts(r) {
  return req.asserts.map((a) => {
    const { pass, actual } = evalAssert(a, r);
    const label = TARGETS[a.target] + (['header', 'json'].includes(a.target) ? ` [${a.path}]` : '');
    const cond = a.op === 'exists' ? OPS.exists : `「${a.value}」${a.op === 'eq' || a.op === 'ne' ? 'と' : a.op === 'contains' ? 'を' : ''}${OPS[a.op]}`;
    const shown = actual === undefined ? '(なし)' : actual.length > 120 ? actual.slice(0, 120) + '…' : actual;
    return { pass, text: `${label} が ${cond} — 実際: ${shown}` };
  });
}

function renderAsserts() {
  const box = $('#req-asserts');
  const rows = req.asserts.map((a, i) => {
    const target = h('select', {}, Object.entries(TARGETS).map(([v, t]) => h('option', { value: v }, t)));
    target.value = a.target;
    const path = h('input', { type: 'text', spellcheck: 'false' });
    path.value = a.path;
    const op = h('select', {}, Object.entries(OPS).map(([v, t]) => h('option', { value: v }, t)));
    op.value = a.op;
    const value = h('input', { type: 'text', spellcheck: 'false' });
    // 使わない欄は消さずに無効にして、行ごとに列がずれないようにする
    const sync = () => {
      const needPath = ['header', 'json'].includes(a.target);
      path.disabled = !needPath;
      path.value = needPath ? a.path : '';
      path.placeholder = a.target === 'header' ? '例: content-type' : a.target === 'json' ? '例: data.items[0].id' : '';
      value.disabled = a.op === 'exists';
      value.value = value.disabled ? '' : a.value;
      value.placeholder = value.disabled ? '' : '例: 200';
    };
    sync();
    target.addEventListener('change', () => { a.target = target.value; sync(); persist(); });
    op.addEventListener('change', () => { a.op = op.value; sync(); persist(); });
    path.addEventListener('input', () => { a.path = path.value; persist(); });
    value.addEventListener('input', () => { a.value = value.value; persist(); });
    const del = h('button', { class: 'icon', title: '削除', onclick: () => { req.asserts.splice(i, 1); renderAsserts(); persist(); } }, '×');
    return h('div', { class: 'as' }, target, path, op, value, del);
  });
  const add = h('button', {
    class: 'add',
    onclick: () => { req.asserts.push({ target: 'status', path: '', op: 'eq', value: '200' }); renderAsserts(); persist(); },
  }, '＋ アサーション追加');
  const head = rows.length
    ? [h('div', { class: 'as head' }, h('span', {}, '対象'), h('span', {}, 'ヘッダー名 / JSONパス'), h('span', {}, '条件'), h('span', {}, '期待値'), h('span'))]
    : [];
  box.replaceChildren(...head, ...rows, add);
}

/* ---------- レスポンス表示 ---------- */
function setStatus(text, cls) {
  const s = $('#resStatus');
  s.textContent = text;
  s.className = 'badge ' + cls;
}
function renderResponse() {
  const r = last;
  if (!r) return;
  if (r.ok) setStatus(`${r.status} ${r.statusText}`.trim(), 's' + String(r.status)[0]);
  else setStatus(r.error, 'err');
  $('#resMeta').textContent = r.ok ? `${r.ms} ms ・ ${fmtSize(r.size)}` : `${r.ms} ms`;

  const body = $('#res-body');
  if (r.image) {
    body.replaceChildren(h('img', { src: r.image, alt: 'レスポンス画像' }));
  } else {
    const text = r.json !== undefined ? JSON.stringify(r.json, null, 2) : r.text;
    body.replaceChildren(h('pre', { id: 'resBody' }, text || '（ボディなし）'));
  }

  $('#res-headers').replaceChildren(
    r.headers.length
      ? h('table', { class: 'hd' }, r.headers.map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))
      : h('div', { class: 'empty' }, 'ヘッダーはありません'),
  );

  const out = $('#res-asserts');
  if (!req.asserts.length) {
    out.replaceChildren(h('div', { class: 'empty' }, 'アサーションは未設定です（リクエスト側の「アサーション」タブで追加）'));
  } else if (!r.ok) {
    out.replaceChildren(h('div', { class: 'ar fail' }, '✗ レスポンスを取得できなかったため評価できません'));
  } else {
    const results = runAsserts(r);
    const passed = results.filter((x) => x.pass).length;
    out.replaceChildren(
      h('div', { class: 'ar ' + (passed === results.length ? 'pass' : 'fail') }, `${passed} / ${results.length} 件 成功`),
      ...results.map(({ pass, text }) => h('div', { class: 'ar ' + (pass ? 'pass' : 'fail') }, `${pass ? '✓' : '✗'} ${text}`)),
    );
    if (passed !== results.length) showTab('res', 'asserts');
  }
}

/* ---------- リクエスト編集UI ---------- */
function renderParams() {
  kvEditor($('#req-params'), req.params, () => { urlFromParams(); persist(); });
}
function renderBodyMode() {
  const t = req.bodyType;
  $('#bodyText').hidden = !(t === 'json' || t === 'text');
  $('#bodyForm').hidden = t !== 'form';
  $('#fmtJson').hidden = t !== 'json';
}
function renderAuthMode() {
  $('#authBasic').hidden = req.auth.type !== 'basic';
  $('#authBearer').hidden = req.auth.type !== 'bearer';
}
function renderBase() {
  const el = $('#base');
  const e = curEnv();
  const vars = envVars();
  const base = baseUrl(vars);
  const abs = ABS.test(sub(req.url, vars).trim());
  el.hidden = !base;
  el.replaceChildren(h('b', {}, e ? `${curSystem().name} / ${e.name}` : ''), ' ' + base);
  el.classList.toggle('off', abs);
  el.title = abs ? 'URL欄が http:// などから始まっているため、ベースURLは使われません' : 'この環境のベースURLに送信します（クリックで編集）';
  $('#url').placeholder = base
    ? '/users?id=1   （${変数名} で環境変数を使えます）'
    : 'https://api.example.com/users?id=1   （左の一覧で環境を選ぶと、パスだけで入力できます）';
}
function syncUI() {
  $('#reqName').textContent = req.name ? req.name : '（未保存のリクエスト）';
  $('#method').value = req.method;
  $('#url').value = req.url;
  renderBase();
  renderParams();
  kvEditor($('#req-headers'), req.headers, persist, ['ヘッダー名', '値']);
  for (const r of $$('input[name=bodyType]')) r.checked = r.value === req.bodyType;
  $('#bodyText').value = req.body;
  kvEditor($('#bodyForm'), req.form, persist);
  renderBodyMode();
  $('#authType').value = req.auth.type;
  $('#authUser').value = req.auth.user;
  $('#authPass').value = req.auth.pass;
  $('#authToken').value = req.auth.token;
  renderAuthMode();
  renderAsserts();
}
function loadReq(r) {
  state.draft = Object.assign(blankReq(), clone(r));
  state.draft.auth = Object.assign(blankReq().auth, state.draft.auth);
  req = state.draft;
  syncUI();
  persist();
}

/* ---------- サイドバー ---------- */
const openEnvs = new Set(); // ツリーで開いている環境のid
function selectEnv(sys, env) {
  state.activeSystem = sys.id;
  state.activeEnv = env ? env.id : '';
  if (env) openEnvs.add(env.id);
}
function renderSaved() {
  const box = $('#side-saved');
  const addSys = h('button', { class: 'add', onclick: () => systemDialog() }, '＋ システムを追加');
  if (!state.systems.length) {
    box.replaceChildren(
      h('div', { class: 'empty' }, 'システムはまだありません。システム（例: 顧客管理）を追加し、その中に環境（検証・本番など）とリクエストを保存します。'),
      addSys);
    return;
  }
  box.replaceChildren(...state.systems.flatMap((s) => [
    h('div', { class: 'sys-head' },
      h('span', { title: s.name }, s.name),
      h('button', { class: 'icon', title: '環境を追加・編集', onclick: () => envDialog(s) }, '環境'),
      h('button', { class: 'icon', title: 'システム名を変更', onclick: () => systemDialog(s) }, '名前'),
      h('button', {
        class: 'icon', title: 'システムを削除',
        onclick: () => {
          if (!confirm(`システム「${s.name}」と、中の環境 ${s.envs.length} 件・リクエスト ${s.requests.length} 件を削除しますか？`)) return;
          state.systems = state.systems.filter((x) => x !== s);
          if (state.activeSystem === s.id) { state.activeSystem = ''; state.activeEnv = ''; }
          renderSaved(); renderBase(); persist();
        },
      }, '×')),
    ...(s.envs.length ? [] : [h('div', { class: 'empty sub-empty' }, '環境がありません。「環境」から追加してください。')]),
    ...s.envs.flatMap((e) => {
      const on = s.id === state.activeSystem && e.id === state.activeEnv;
      const open = openEnvs.has(e.id);
      return [
        h('div', {
          class: 'env-head' + (on ? ' on' : ''), title: `${e.name}  ${envBase(e)}`,
          // 選択中の環境を押すと開閉、それ以外を押すとその環境に切り替える
          onclick: () => {
            if (on) { if (open) openEnvs.delete(e.id); else openEnvs.add(e.id); } else selectEnv(s, e);
            renderSaved(); renderBase(); persist();
          },
        },
          h('span', { class: 'tw' }, open ? '▾' : '▸'),
          h('span', { class: 'name' }, e.name),
          h('span', { class: 'sub' }, envBase(e).replace(/^https?:\/\//, ''))),
        ...(!open ? [] : !s.requests.length
          ? [h('div', { class: 'empty sub-empty req' }, 'リクエストはまだありません。「保存」で追加できます。')]
          : s.requests.map((r) => h('div', {
            class: 'item req' + (on && r.id === req.id ? ' on' : ''), title: r.url,
            onclick: () => { selectEnv(s, e); loadReq(r); renderSaved(); },
          },
            h('span', { class: 'm ' + r.method }, r.method),
            h('span', { class: 'label' }, r.name || r.url),
            h('button', {
              class: 'icon', title: '削除（このシステムの全環境から消えます）',
              onclick: (ev) => {
                ev.stopPropagation();
                if (!confirm(`リクエスト「${r.name || r.url}」を削除しますか？\nシステム「${s.name}」のすべての環境の一覧から消えます。`)) return;
                s.requests = s.requests.filter((x) => x !== r);
                renderSaved(); persist();
              },
            }, '×')))),
      ];
    }),
  ]), addSys);
}
function renderHistory() {
  const box = $('#side-history');
  if (!state.history.length) {
    box.replaceChildren(h('div', { class: 'empty' }, '履歴はまだありません'));
    return;
  }
  box.replaceChildren(
    h('button', { class: 'small', onclick: () => { state.history = []; renderHistory(); persist(); } }, '履歴をクリア'),
    ...state.history.map((x) => h('div', {
      class: 'item', title: x.req.url,
      // 送信したときのシステム・環境が残っていれば、そこに戻す
      onclick: () => {
        const sys = state.systems.find((v) => v.id === x.sys);
        const env = sys && sys.envs.find((v) => v.id === x.env);
        if (env) selectEnv(sys, env);
        loadReq(x.req); renderSaved();
      },
    },
      h('span', { class: 'm ' + x.req.method }, x.req.method),
      h('span', { class: 'label' }, x.req.url.replace(/^https?:\/\//, '')),
      h('span', { class: 'sub' }, `${x.envName ? x.envName + '・' : ''}${x.status || 'ERR'}・${new Date(x.at).toLocaleTimeString()}`))),
  );
}
/* ---------- ダイアログ ---------- */
// 共通の枠: 右上の×、下に「閉じる」と「保存」。onSave が false を返したら閉じない。中身を入れる要素を返す
function openDialog(title, onSave) {
  const dlg = $('#dlg');
  const body = h('div');
  dlg.replaceChildren(
    h('div', { class: 'dlg-head' },
      h('h3', {}, title),
      h('button', { class: 'icon', title: '閉じる', onclick: () => dlg.close() }, '×')),
    body,
    h('div', { class: 'actions' },
      h('button', { onclick: () => dlg.close() }, '閉じる'),
      h('button', { class: 'primary', onclick: () => { if (onSave() !== false) dlg.close(); } }, '保存')),
  );
  dlg.showModal();
  return body;
}
const newEnv = (name, baseUrl = '', port = '') => ({ id: uid(), name, baseUrl, port, vars: [] });
const portInput = () => h('input', { type: 'text', class: 'mono', placeholder: '例: 8080', inputmode: 'numeric', spellcheck: 'false' });

function systemDialog(sys) {
  const name = h('input', { type: 'text', placeholder: '例: 顧客管理システム' });
  name.value = sys ? sys.name : '';
  const envName = h('input', { type: 'text', placeholder: '例: 検証' });
  envName.value = 'ローカル';
  const base = h('input', { type: 'text', class: 'mono', placeholder: '例: https://stg.example.com', spellcheck: 'false' });
  base.value = 'http://localhost';
  const port = portInput();
  port.value = '8080';
  const body = openDialog(sys ? 'システム名を変更' : 'システムを追加', () => {
    if (!name.value.trim()) { name.focus(); return false; }
    if (sys) sys.name = name.value.trim();
    else {
      const s = { id: uid(), name: name.value.trim(), envs: [newEnv(envName.value.trim() || 'ローカル', base.value.trim(), port.value.trim())], requests: [] };
      state.systems.push(s);
      selectEnv(s, s.envs[0]);
    }
    persist();
  });
  body.append(
    h('div', { class: 'row' }, field('システム名', name)),
    ...(sys ? [] : [
      h('h4', {}, '最初の環境'),
      h('div', { class: 'row' }, field('環境名', envName)),
      h('div', { class: 'row' }, field('ベースURL（送信先のドメイン）', base), h('label', { class: 'field port' }, h('span', {}, 'ポート番号（任意）'), port)),
      h('div', { class: 'hint' }, '環境はあとから「環境」ボタンで追加できます（検証・本番など）。'),
    ]),
  );
  name.focus();
}

function saveDialog() {
  const name = h('input', { type: 'text', placeholder: '例: ユーザー一覧' });
  name.value = req.name || '';
  const NEW = '__new__';
  const sel = h('select', {}, ...state.systems.map((c) => h('option', { value: c.id }, c.name)), h('option', { value: NEW }, '＋ 新しいシステム'));
  const current = state.systems.find((c) => c.requests.some((r) => r.id === req.id));
  const initial = current || curSystem() || state.systems[0];
  sel.value = initial ? initial.id : NEW;
  const newName = h('input', { type: 'text', placeholder: '例: 顧客管理システム' });
  const newField = field('新しいシステム名', newName);
  const sync = () => { newField.hidden = sel.value !== NEW; };
  sync();
  sel.addEventListener('change', sync);

  const body = openDialog(current ? 'リクエストを上書き保存' : 'リクエストを保存', () => {
    if (!name.value.trim()) { name.focus(); return false; }
    let target = state.systems.find((c) => c.id === sel.value);
    if (!target) {
      target = { id: uid(), name: newName.value.trim() || 'マイシステム', envs: [newEnv('ローカル')], requests: [] };
      state.systems.push(target);
    }
    req.name = name.value.trim();
    if (!req.id) req.id = uid();
    for (const c of state.systems) c.requests = c.requests.filter((r) => r.id !== req.id);
    target.requests.push(clone(req));
    if (state.activeSystem !== target.id) selectEnv(target, target.envs[0]);
    else if (state.activeEnv) openEnvs.add(state.activeEnv);
    $('#reqName').textContent = req.name;
    persist();
    toast('保存しました');
  });
  body.append(
    h('div', { class: 'row' }, field('リクエスト名', name)),
    h('div', { class: 'row' }, field('保存先のシステム', sel), newField),
    h('div', { class: 'hint' }, '保存したリクエストは、そのシステムのすべての環境で使えます。'),
  );
  name.focus();
}

function envDialog(sys) {
  // 写しを編集し、「保存」を押したときだけ反映する
  const envs = clone(sys.envs);
  if (!envs.length) envs.push(newEnv('ローカル', 'http://localhost', '8080'));
  let cur = (sys.id === state.activeSystem && envs.find((e) => e.id === state.activeEnv)) || envs[0];
  const body = openDialog(`環境 — ${sys.name}`, () => {
    sys.envs = envs;
    if (sys.id === state.activeSystem && !envs.some((e) => e.id === state.activeEnv)) state.activeEnv = envs[0] ? envs[0].id : '';
    persist();
    toast('保存しました');
  });
  const draw = () => {
    const sel = h('select', {}, envs.map((e) => h('option', { value: e.id }, e.name || '（名前なし）')));
    const add = h('button', { onclick: () => { cur = newEnv('新しい環境'); envs.push(cur); draw(); } }, '＋ 環境を追加');
    if (!cur) {
      body.replaceChildren(h('div', { class: 'row' }, add), h('div', { class: 'hint' }, '環境がありません。このまま保存すると、このシステムの環境はすべて削除されます。'));
      return;
    }
    sel.value = cur.id;
    sel.addEventListener('change', () => { cur = envs.find((e) => e.id === sel.value); draw(); });
    const name = h('input', { type: 'text', placeholder: '例: 検証' });
    name.value = cur.name;
    name.addEventListener('input', () => { cur.name = name.value; sel.selectedOptions[0].textContent = name.value || '（名前なし）'; });
    const base = h('input', { type: 'text', class: 'mono', placeholder: '例: https://api.example.com', spellcheck: 'false' });
    base.value = cur.baseUrl || '';
    base.addEventListener('input', () => { cur.baseUrl = base.value; });
    const port = portInput();
    port.value = cur.port || '';
    port.addEventListener('input', () => { cur.port = port.value; });
    const vars = h('div');
    kvEditor(vars, cur.vars, () => {}, ['変数名', '値']);
    body.replaceChildren(
      h('div', { class: 'row' }, field('編集する環境', sel), add,
        h('button', { onclick: () => { envs.splice(envs.indexOf(cur), 1); cur = envs[0]; draw(); } }, 'この環境を削除')),
      h('div', { class: 'row' }, field('環境名', name)),
      h('div', { class: 'row' }, field('ベースURL（送信先のドメイン）', base), h('label', { class: 'field port' }, h('span', {}, 'ポート番号（任意）'), port)),
      h('div', { class: 'hint' }, 'ベースURLを設定すると、URL欄にはパス（/users など）だけを入力します。送信先はこの環境のベースURL（＋ポート番号）になります。'),
      h('h4', {}, '変数'),
      vars,
      h('div', { class: 'hint' }, 'URL・ヘッダー・ボディ・認証・期待値の中で ${変数名} と書くと、選択中の環境の値に置き換わります。'),
    );
  };
  draw();
}

/* ---------- cURL / インポート・エクスポート ---------- */
function toCurl() {
  const b = build(req);
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  const parts = ['curl', '-X', b.method, q(b.url)];
  for (const [k, v] of b.headers) parts.push('-H', q(`${k}: ${v}`));
  if (b.body) parts.push('--data-raw', q(b.body));
  return parts.join(' ');
}
function exportAll() {
  const data = { app: 'evirest', version: 2, systems: state.systems };
  saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), 'evirest-export.json');
}
// 手書きやAIが作ったファイルでも読めるよう、省略された項目を補う
const normRows = (a) => (Array.isArray(a) ? a : []).map((x) => ({ on: x.on !== false, k: String(x.k ?? ''), v: String(x.v ?? '') }));
function normEnv(e) {
  return { id: uid(), name: String(e.name || '環境'), baseUrl: String(e.baseUrl ?? ''), port: String(e.port ?? ''), vars: normRows(e.vars) };
}
function normReq(r) {
  const q = Object.assign(blankReq(), r, { id: uid() });
  q.url = String(q.url ?? '');
  q.headers = normRows(q.headers);
  q.form = normRows(q.form);
  q.params = [...queryRows(q.url), ...normRows(q.params).filter((x) => !x.on)];
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
async function importFile(file) {
  try {
    const data = JSON.parse(await file.text());
    // 'restbench' は旧名で書き出したファイル
    if (!['evirest', 'restbench'].includes(data.app)) throw new Error('EviRESTのエクスポートファイルではありません');
    const list = Array.isArray(data.systems) ? data.systems
      : Array.isArray(data.collections) ? systemsFromV1(data.collections, data.envs) : null;
    if (!list) throw new Error('systems がありません');
    for (const s of list) {
      state.systems.push({
        id: uid(), name: String(s.name || 'インポート'),
        envs: (s.envs || []).map(normEnv), requests: (s.requests || []).map(normReq),
      });
    }
    renderSaved(); persist();
    toast('インポートしました');
  } catch (e) {
    toast('インポート失敗: ' + e.message);
  }
}

/* ---------- テストエビデンス ---------- */
const EV_MAX = 500000; // 1件あたりのボディ保存上限（文字数）
const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie)$|token|secret|api[-_]?key|password/i;
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = (t) => new Date(t).toLocaleString('ja-JP', { hour12: false });

function addEvidenceDialog() {
  if (!last || !last.req) { toast('先にリクエストを送信してください'); return; }
  const caseId = h('input', { type: 'text', placeholder: '例: IT-USER-001', spellcheck: 'false' });
  const title = h('input', { type: 'text', placeholder: '例: ユーザー登録が201で成功すること' });
  title.value = req.name || '';
  const tester = h('input', { type: 'text' });
  tester.value = state.tester;
  const memo = h('textarea');
  const body = openDialog('エビデンスに追加', () => {
    const r = last;
    const asserts = r.ok ? runAsserts(r) : [];
    const cut = (t) => (t.length > EV_MAX ? { text: t.slice(0, EV_MAX), full: t.length } : { text: t, full: 0 });
    const resBody = r.image ? { text: `（画像データ: ${r.ct}）`, full: 0 } : cut(r.text || '');
    const reqBody = cut(r.req.body || '');
    state.tester = tester.value.trim();
    state.evidence.push({
      id: uid(), caseId: caseId.value.trim(), title: title.value.trim(), tester: state.tester, memo: memo.value.trim(),
      at: r.at, system: r.sys, env: r.env, method: r.req.method, url: r.req.url,
      reqHeaders: r.req.headers, reqBody: reqBody.text, reqBodyFull: reqBody.full,
      ok: r.ok, status: r.status, statusText: r.statusText, ms: r.ms, size: r.size,
      resHeaders: r.headers, resBody: resBody.text, resBodyFull: resBody.full,
      asserts, verdict: !r.ok ? 'NG' : !asserts.length ? '-' : asserts.every((x) => x.pass) ? 'OK' : 'NG',
    });
    renderEvidence(); persistNow();
    showTab('side', 'evidence');
    toast('エビデンスに追加しました');
  });
  body.append(
    h('div', { class: 'row' }, field('テストケースID', caseId), field('実施者', tester)),
    h('div', { class: 'row' }, field('確認内容', title)),
    h('div', { class: 'row' }, field('備考（任意）', memo)),
    h('div', { class: 'hint' }, `対象: ${last.req.method} ${last.req.url} → ${last.ok ? last.status : '送信失敗'}（${fmtTime(last.at)}）`),
  );
  caseId.focus();
}

function renderEvidence() {
  const box = $('#side-evidence');
  if (!state.evidence.length) {
    box.replaceChildren(h('div', { class: 'empty' }, 'エビデンスはまだありません。送信後に「エビデンスに追加」で記録できます。'));
    return;
  }
  const mask = h('input', { type: 'checkbox' });
  mask.checked = state.maskEv;
  mask.addEventListener('change', () => { state.maskEv = mask.checked; persist(); });
  box.replaceChildren(
    h('div', { class: 'ev-tools' },
      h('button', { class: 'small', onclick: exportEvidence }, 'HTMLレポート出力'),
      h('button', { class: 'small', onclick: exportEvidenceXlsx }, 'Excel出力'),
      h('button', {
        class: 'small',
        onclick: () => {
          if (!confirm(`エビデンス ${state.evidence.length} 件をすべて削除しますか？`)) return;
          state.evidence = []; renderEvidence(); persist();
        },
      }, '全削除'),
      h('label', { title: 'Authorization・Cookie・トークン類のヘッダー値を伏せ字にして出力します' }, mask, ' 認証情報を伏せる')),
    ...state.evidence.map((e, i) => h('div', { class: 'item', title: `${e.method} ${e.url}\n${fmtTime(e.at)}` },
      h('span', { class: 'v ' + e.verdict }, e.verdict),
      h('span', { class: 'label' }, `${i + 1}. ${e.caseId || e.title || e.url.replace(/^https?:\/\//, '')}`),
      h('span', { class: 'sub' }, e.ok ? String(e.status) : 'ERR'),
      h('button', {
        class: 'icon', title: '削除',
        onclick: () => { state.evidence = state.evidence.filter((x) => x !== e); renderEvidence(); persist(); },
      }, '×'))),
  );
}

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

function saveBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
}
function evidenceFileName(ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `api-evidence-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}
function exportEvidence() {
  saveBlob(new Blob([evidenceHtml(state.evidence, state.maskEv)], { type: 'text/html' }), evidenceFileName('html'));
}

/* ---------- テストエビデンス（Excel） ---------- */
const XL_LINE = 1000;   // ボディ1行あたりの上限（超えたら次の行に送る）
const XL_CELL = 32000;  // Excelの1セル上限（32,767文字）より少なめ
// XMLに入れられない制御文字を除く
const xlText = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '').replace(/\r\n?/g, '\n');
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

async function exportEvidenceXlsx() {
  if (typeof writeXlsxFile !== 'function') { toast('Excel出力のライブラリがありません（pnpm install を実行してください）'); return; }
  try {
    const blob = await writeXlsxFile(evidenceSheets(state.evidence, state.maskEv)).toBlob();
    saveBlob(blob, evidenceFileName('xlsx'));
  } catch (e) {
    toast('Excel出力に失敗: ' + e.message);
  }
}

/* ---------- イベント登録・起動 ---------- */
function bind() {
  $('#method').addEventListener('change', (e) => { req.method = e.target.value; persist(); });
  $('#url').addEventListener('input', (e) => { req.url = e.target.value; paramsFromUrl(); renderBase(); persist(); });
  $('#url').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  $('#send').addEventListener('click', send);
  $('#save').addEventListener('click', saveDialog);
  $('#newReq').addEventListener('click', () => { loadReq(blankReq()); renderSaved(); $('#url').focus(); });
  $('#curl').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(toCurl()); toast('cURLコマンドをコピーしました'); } catch { toast('コピーに失敗しました'); }
  });
  document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') send(); });

  for (const r of $$('input[name=bodyType]')) {
    r.addEventListener('change', () => { req.bodyType = r.value; renderBodyMode(); persist(); });
  }
  $('#bodyText').addEventListener('input', (e) => { req.body = e.target.value; persist(); });
  $('#fmtJson').addEventListener('click', () => {
    try {
      req.body = JSON.stringify(JSON.parse(req.body), null, 2);
      $('#bodyText').value = req.body;
      persist();
    } catch (e) { toast('JSONとして解釈できません: ' + e.message); }
  });

  $('#authType').addEventListener('change', (e) => { req.auth.type = e.target.value; renderAuthMode(); persist(); });
  $('#authUser').addEventListener('input', (e) => { req.auth.user = e.target.value; persist(); });
  $('#authPass').addEventListener('input', (e) => { req.auth.pass = e.target.value; persist(); });
  $('#authToken').addEventListener('input', (e) => { req.auth.token = e.target.value; persist(); });

  $('#base').addEventListener('click', () => { if (curSystem()) envDialog(curSystem()); });
  $('#dlg').addEventListener('close', () => { renderSaved(); renderBase(); });

  $('#copyBody').addEventListener('click', async () => {
    if (!last || last.image) return;
    const text = last.json !== undefined ? JSON.stringify(last.json, null, 2) : last.text;
    try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch { toast('コピーに失敗しました'); }
  });
  $('#addEv').addEventListener('click', addEvidenceDialog);
  $('#exportBtn').addEventListener('click', exportAll);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
    e.target.value = '';
  });
}

(async function init() {
  const saved = await store.get().catch(() => null);
  if (saved) {
    state.history = saved.history || [];
    if (saved.systems) {
      state.systems = saved.systems;
      state.activeSystem = saved.activeSystem || '';
      state.activeEnv = saved.activeEnv || '';
    } else {
      // 旧形式の保存データ。環境は各システムに複製する
      state.systems = systemsFromV1(saved.collections, saved.envs).map((x) => ({
        id: uid(), name: x.name, requests: x.requests, envs: x.envs.map((e) => ({ ...clone(e), id: uid(), baseUrl: e.baseUrl || '' })),
      }));
      const i = (saved.envs || []).findIndex((e) => e.id === saved.activeEnv);
      if (state.systems.length && i >= 0) { state.activeSystem = state.systems[0].id; state.activeEnv = state.systems[0].envs[i].id; }
    }
    if (state.activeEnv) openEnvs.add(state.activeEnv);
    state.evidence = saved.evidence || [];
    state.tester = saved.tester || '';
    state.maskEv = saved.maskEv !== false;
    state.draft = Object.assign(blankReq(), saved.draft || {});
    state.draft.auth = Object.assign(blankReq().auth, state.draft.auth);
  }
  req = state.draft;
  initTabs();
  bind();
  syncUI();
  renderSaved();
  renderHistory();
  renderEvidence();
})();
