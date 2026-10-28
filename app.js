'use strict';

/* ---------- ユーティリティ ---------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
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
  toastTimer = setTimeout(() => { t.hidden = true; }, Math.max(2200, msg.length * 90)); // 長い文は長めに出す
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

// systems: [{ id, name, envs: [{ id, name, baseUrl, vars }], requests: [...] }]　リクエストは同じシステムの全環境で共有する
const state = { systems: [], activeSystem: '', activeEnv: '', history: [], draft: blankReq(), evidence: [], tester: '', maskEv: true };
let req = state.draft;      // 編集中のリクエスト
let last = null;            // 直近のレスポンス
let ctrl = null;            // 送信中の AbortController
let batch = null;

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
      const cb = h('input', { type: 'checkbox', title: 'この項目を使用する' });
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
function paramsFromUrl() {
  const rows = syncQueryRows(req.url, req.params);
  req.params.splice(0, req.params.length, ...rows);
  renderParams();
  renderPathParams();
}
function urlFromParams() {
  req.url = queryTemplateUrl(req.url, req.params);
  $('#url').value = req.url;
  renderRequestPreview();
}

/* ---------- 環境変数 ---------- */
const curSystem = () => state.systems.find((x) => x.id === state.activeSystem);
const curEnv = () => { const s = curSystem(); return s && s.envs.find((x) => x.id === state.activeEnv); };
const envVars = () => varsOf(curEnv());
const baseUrl = (vars) => envBaseUrl(curEnv(), vars);

/* ---------- リクエスト組み立て ---------- */
const build = (r) => buildRequest(r, curEnv());

/* ---------- 送信 ---------- */
async function send(fromBatch = false) {
  if (batch && fromBatch !== true) return;
  if (ctrl) { ctrl.abort(); return; }
  const b = build(req);
  if (!b.url) { toast('URLを入力してください'); return; }
  if (!ABS.test(b.url)) { toast('送信先の環境を選ぶか、https:// などから始まるURLを入力してください'); return; }
  const missingPath = pathParamNames(b.url);
  if (missingPath.length) { toast('パスパラメータの値を設定してください: ' + missingPath.join(', ')); return; }
  const unresolved = (b.url + JSON.stringify(b.headers) + (b.body || '')).match(/\$\{[^}]+\}/);

  const btn = $('#send');
  btn.textContent = '中止';
  setStatus('送信中…', '');
  showRequestUrl(b.url);
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
      headers: [...res.headers], ct, url: res.url, text: '', json: undefined, image: null, lines: null,
    };
    if (/^image\//i.test(ct)) {
      last.image = URL.createObjectURL(new Blob([buf], { type: ct }));
    } else {
      last.text = new TextDecoder().decode(buf);
      last.lines = fileLines(ct, res.headers.get('content-disposition'), last.text);
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
  if (unresolved) toast('値が設定されていない変数があります: ' + unresolved[0]);

  state.history.unshift({ id: uid(), at: Date.now(), status: last.status, ms: last.ms, sys: state.activeSystem, env: state.activeEnv, envName: last.env, req: clone(req) });
  state.history.length = Math.min(state.history.length, 100);
  renderHistory();
  persist();
  return last;
}

// 次の送信までの待ち時間。中止されたらすぐに終わる
function batchWait(run, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    run.cancelWait = () => { clearTimeout(timer); resolve(); };
  });
}
async function runBatch() {
  if (batch) { batch.stopped = true; batch.cancelWait?.(); ctrl?.abort(); return; }
  if (ctrl) { toast('現在の送信が終わってから一括実行してください'); return; }
  const system = curSystem();
  const environment = curEnv();
  if (!system || !environment) { toast('実行する環境を選んでください'); return; }
  const requests = clone(system.requests.filter((r) => r.batchSelected === true));
  if (!requests.length) { toast('一括実行するリクエストにチェックを入れてください'); return; }
  const original = req;
  const run = batch = { stopped: false };
  const button = $('#batchRun');
  const box = $('#batchResults');
  const progress = h('p');
  const report = [];
  const htmlButton = h('button', { class: 'small', onclick: () => openHtmlReport(evidenceHtml(report, true)) }, 'HTMLで開く');
  const excelButton = h('button', { class: 'small', onclick: () => exportXlsxReport(report, true) }, 'Excel出力');
  htmlButton.disabled = excelButton.disabled = true;
  box.replaceChildren(progress, h('div', { class: 'ev-tools' }, htmlButton, excelButton));
  box.hidden = false;
  showTab('res', 'batch');
  button.textContent = '実行を中止';
  const interval = batchIntervalOf(state.batchInterval);
  $('#batchInterval').disabled = true;
  $('#side').inert = true;
  $('#request').inert = true;
  $('#addEv').disabled = true;
  let completed = 0;
  try {
    for (const request of requests) {
      if (run.stopped) break;
      if (completed > 0) {
        progress.textContent = `${system.name} / ${environment.name} — ${completed} / ${requests.length} 件 完了。次の送信まで待機中（${interval / 1000}秒間隔）`;
        await batchWait(run, interval);
        if (run.stopped) break;
      }
      progress.textContent = `${system.name} / ${environment.name} — ${completed + 1} / ${requests.length} 件 実行中`;
      req = Object.assign(blankReq(), request);
      req.auth = Object.assign(blankReq().auth, req.auth);
      syncUI();
      const result = await send(true);
      showTab('res', 'batch');
      const assertions = result?.ok ? checkAsserts(req.asserts, result, varsOf(environment)) : [];
      const passed = result?.ok && result.status < 400 && assertions.every((a) => a.pass);
      const status = !result ? '未実行（URL・パラメータを確認）'
        : result.error === '中止' ? '中止'
        : `${passed ? 'OK' : 'NG'} · ${result.ok ? result.status : '通信エラー'} · ${result.ms} ms`
          + (assertions.length ? ` · 検証 ${assertions.filter((a) => a.pass).length}/${assertions.length}` : '');
      const entry = batchEvidence(req, result, assertions, passed, system.name, environment.name, status);
      report.push(entry);
      state.evidence.push(clone(entry));
      renderEvidence();
      box.append(h('div', { class: 'batch-row' }, h('span', {}, `${req.method} ${req.name || req.url}`), h('span', {}, status)));
      completed++;
    }
    progress.textContent = `${system.name} / ${environment.name} — ${run.stopped ? '中止' : '完了'}（${completed} / ${requests.length} 件）`;
  } catch (e) {
    progress.textContent = `一括実行に失敗しました: ${e.message}（${completed} / ${requests.length} 件）`;
  } finally {
    req = original;
    batch = null;
    updateBatchControls();
    $('#batchInterval').disabled = false;
    $('#side').inert = false;
    $('#request').inert = false;
    $('#addEv').disabled = false;
    htmlButton.disabled = excelButton.disabled = !report.length;
    syncUI();
    showTab('res', 'batch');
    persist();
  }
}

function batchEvidence(request, result, asserts, passed, system, env, status) {
  const r = result;
  const built = r?.req || build(request);
  const cut = (text) => ({ text: text.slice(0, EV_MAX), full: text.length > EV_MAX ? text.length : 0 });
  const requestBody = cut(built.body || '');
  const responseBody = cut(r?.image ? `（画像データ: ${r.ct}）` : r?.text || '');
  return {
    id: uid(), caseId: '', title: request.name || request.url, tester: '', memo: status,
    at: r?.at || Date.now(), system, env, method: built.method, url: built.url,
    reqHeaders: clone(built.headers), reqBody: requestBody.text, reqBodyFull: requestBody.full,
    ok: r?.ok || false, status: r?.status || 0, statusText: r?.statusText || '', ms: r?.ms || 0, size: r?.size || 0,
    resHeaders: clone(r?.headers || []), resBody: responseBody.text, resBodyFull: responseBody.full,
    asserts: clone(asserts), verdict: passed ? 'OK' : 'NG',
  };
}

/* ---------- アサーション ---------- */
const runAsserts = (r) => checkAsserts(req.asserts, r, envVars());

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
function showRequestUrl(url) {
  $('#resRequestUrl').textContent = url;
  $('#resRequest').hidden = false;
}
function renderResponse() {
  const r = last;
  if (!r) return;
  showRequestUrl(r.req.url);
  if (r.ok) setStatus(`${r.status} ${r.statusText}`.trim(), 's' + String(r.status)[0]);
  else setStatus(r.error, 'err');
  $('#resMeta').textContent = r.ok
    ? `${r.ms} ms ・ ${fmtSize(r.size)}` + (r.lines != null ? ` ・ ${r.lines.toLocaleString()} 行` : '')
    : `${r.ms} ms`;

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
    out.replaceChildren(h('div', { class: 'empty' }, '検証条件がありません。「アサーション」タブで追加してください。'));
  } else if (!r.ok) {
    out.replaceChildren(h('div', { class: 'ar fail' }, '✗ 応答がなかったため、結果を検証できません'));
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
function renderPathParams() {
  for (const name of pathParamNames(req.url)) {
    if (!req.pathParams.some((p) => p.k === name)) req.pathParams.push({ on: true, k: name, v: '' });
  }
  kvEditor($('#pathParams'), req.pathParams, () => { renderRequestPreview(); persist(); }, ['パラメータ名', '値']);
  renderRequestPreview();
}
function renderRequestPreview() {
  const url = build(req).url;
  $('#requestPreviewUrl').textContent = url;
  $('#requestPreview').hidden = !req.url.trim();
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
function colorDot(env) {
  const dot = h('span', { class: 'env-color', 'aria-hidden': 'true' });
  dot.style.backgroundColor = envColor(env.color) || 'var(--accent)';
  return dot;
}
function applyEnvColor(el, color) {
  const valid = envColor(color);
  el.style.setProperty('--env-color', valid || 'var(--accent)');
  if (!valid) { el.style.removeProperty('--env-text'); return; }
  const channels = [1, 3, 5].map((i) => {
    const c = parseInt(valid.slice(i, i + 2), 16) / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  el.style.setProperty('--env-text', luminance > .179 ? '#000000' : '#ffffff');
}
function renderBase() {
  updateBatchControls();
  const el = $('#base');
  const e = curEnv();
  const vars = envVars();
  const base = baseUrl(vars);
  const abs = ABS.test(sub(req.url, vars).trim());
  el.hidden = !base;
  el.replaceChildren(h('b', {}, e ? `${curSystem().name} / ${e.name}` : ''), ' ' + base);
  el.classList.toggle('off', abs);
  applyEnvColor(el, e?.color);
  applyEnvColor($('#send'), e?.color);
  applyEnvColor($('#batchRun'), e?.color);
  // ヘッダーにも現在の送信先を出す
  $('#topEnv').replaceChildren(...(e
    ? [colorDot(e), h('b', {}, `${curSystem().name} / ${e.name}`), h('code', {}, base || '（送信先URLを設定してください）')]
    : ['環境を選ぶか、送信先のURLを直接入力してください']));
  el.title = abs ? 'URL欄に入力した送信先を使います' : 'このこの環境に送信します（クリックで送信先を編集）';
  $('#url').placeholder = base
    ? '/users?id=1   （${id} などの変数も使えます）'
    : 'https://api.example.com/users?id=1   （環境を選ぶと /users などのパスだけで入力できます）';
  renderRequestPreview();
}
function syncUI() {
  $('#reqName').textContent = req.name ? req.name : '（未保存のリクエスト）';
  $('#method').value = req.method;
  req.params = syncQueryRows(req.url, req.params);
  urlFromParams();
  $('#url').value = req.url;
  renderBase();
  renderParams();
  renderPathParams();
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
// ツリーで開いている環境。環境のidはシステムの中でしか一意でないので、システムのidと組にする
const openEnvs = new Set();
const envKey = (sysId, envId) => sysId + '/' + envId;
function selectEnv(sys, env) {
  state.activeSystem = sys.id;
  state.activeEnv = env ? env.id : '';
  if (env) openEnvs.add(envKey(sys.id, env.id));
}
function renderSaved() {
  updateBatchControls();
  const box = $('#side-saved');
  const addSys = h('button', { class: 'add', onclick: () => systemDialog() }, '＋ システムを追加');
  if (!state.systems.length) {
    box.replaceChildren(
      h('div', { class: 'empty' }, 'まずシステムを作成してください。APIの用途ごとに、送信先とリクエストをまとめられます。'),
      addSys);
    return;
  }
  box.replaceChildren(addSys, ...state.systems.flatMap((s) => [
    h('div', { class: 'sys-head' },
      h('span', { title: s.name }, s.name),
      h('button', { class: 'small', onclick: () => createEnvDialog(s) }, '＋ 環境を作成'),
      h('button', { class: 'small', onclick: () => systemDialog(s) }, 'システムを編集'),
      h('button', {
        class: 'small delete-action', title: 'システムを削除',
        onclick: async () => {
          if (!await confirmDelete(`システム「${s.name}」を削除しますか？\n中の環境 ${s.envs.length} 件と、リクエスト ${s.requests.length} 件も削除されます。`)) return;
          state.systems = state.systems.filter((x) => x !== s);
          if (state.activeSystem === s.id) { state.activeSystem = ''; state.activeEnv = ''; }
          renderSaved(); renderBase(); persist();
        },
      }, 'システムを削除')),
    ...(s.envs.length ? [] : [h('div', { class: 'empty sub-empty' }, '環境がありません。「＋ 環境を作成」から追加してください。')]),
    ...s.envs.flatMap((e) => {
      const on = s.id === state.activeSystem && e.id === state.activeEnv;
      const key = envKey(s.id, e.id);
      const open = openEnvs.has(key);
      return [
        h('div', {
          class: 'env-head' + (on ? ' on' : ''), title: `${e.name}  ${envBase(e)}`,
          // 選択中の環境を押すと開閉、それ以外を押すとその環境に切り替える
          onclick: () => {
            if (on) { if (open) openEnvs.delete(key); else openEnvs.add(key); } else selectEnv(s, e);
            renderSaved(); renderBase(); persist();
          },
        },
          h('span', { class: 'tw' + (open ? ' open' : ''), 'aria-hidden': 'true' }),
          colorDot(e),
          h('span', { class: 'name' }, e.name),
          h('span', { class: 'sub' }, envBase(e).replace(/^https?:\/\//, '')),
          h('button', { class: 'small env-edit', 'aria-label': e.name + 'を編集', onclick: (event) => { event.stopPropagation(); editEnvDialog(s, e); } }, '編集')),
        ...(!open ? [] : !s.requests.length
          ? [h('div', { class: 'empty sub-empty req' }, 'リクエストがありません。「＋ リクエストを作成」から入力し、保存してください。')]
          : [batchSelectAll(s, e), ...groupRequests(s.requests).flatMap((group) => [
            h('div', { class: 'package-heading' }, group.name || '未分類'),
            ...group.subgroups.flatMap((subgroup) => [
              ...(subgroup.name ? [h('div', { class: 'subpackage-heading' }, subgroup.name)] : []),
              ...subgroup.requests.map((r) => h('div', {
            class: 'item req' + (on && r.id === req.id ? ' on' : ''), title: r.url,
            onclick: () => { selectEnv(s, e); loadReq(r); renderSaved(); },
          },
            batchCheckbox(r, e),
            h('span', { class: 'm ' + r.method }, r.method),
            h('span', { class: 'label' }, r.name || r.url),
            h('button', {
              class: 'icon', title: '削除（このシステムの全環境から消えます）',
              onclick: async (ev) => {
                ev.stopPropagation();
                if (!await confirmDelete(`リクエスト「${r.name || r.url}」を削除しますか？\nシステム「${s.name}」のすべての環境の一覧から消えます。`)) return;
                s.requests = s.requests.filter((x) => x !== r);
                renderSaved(); persist();
              },
            }, '×'))),
            ]),
          ])]),
      ];
    }),
  ]));
}
function updateBatchControls() {
  if (batch) return;
  const system = curSystem();
  const env = curEnv();
  const count = system?.requests.length || 0;
  const selected = system?.requests.filter((r) => r.batchSelected === true).length || 0;
  $('#batchTarget').textContent = env ? `一括実行：${system.name} / ${env.name}` : '環境を選ぶと一括実行できます';
  $('#batchHint').textContent = env
    ? `一覧で選んだ${selected}件を、${batchIntervalOf(state.batchInterval) / 1000}秒の間隔をあけて順番に送信します。結果はすべてエビデンスに保存します。`
    : 'サイドメニューで実行する環境を選んでください。';
  $('#batchRun').textContent = `選択した${selected}件を実行`;
  $('#batchRun').disabled = !env || !selected;
}
function batchSelectAll(system, environment) {
  const input = h('input', { type: 'checkbox', class: 'evidence-check', 'aria-label': system.name + 'の一括実行対象をすべて選択' });
  input.style.accentColor = envColor(environment.color) || 'var(--accent)';
  const count = system.requests.filter((r) => r.batchSelected === true).length;
  input.checked = count === system.requests.length;
  input.indeterminate = count > 0 && count < system.requests.length;
  input.addEventListener('change', () => {
    for (const request of system.requests) request.batchSelected = input.checked;
    if (curSystem()?.id === system.id && system.requests.some((r) => r.id === req.id)) req.batchSelected = input.checked;
    renderSaved();
    persist();
  });
  return h('label', { class: 'evidence-select-hint' }, input, `一括実行の対象をすべて選択（${count}/${system.requests.length}）`);
}
function batchCheckbox(request, environment) {
  const input = h('input', {
    type: 'checkbox', class: 'evidence-check',
    title: '一括実行の対象にする',
    'aria-label': `${request.name || request.url}を一括実行の対象にする`,
    onclick: (event) => event.stopPropagation(),
  });
  input.checked = request.batchSelected === true;
  input.style.accentColor = envColor(environment.color) || 'var(--accent)';
  input.addEventListener('change', () => {
    request.batchSelected = input.checked;
    if (req.id === request.id && curSystem()?.requests.includes(request)) req.batchSelected = input.checked;
    renderSaved();
    persist();
  });
  return input;
}
function renderHistory() {
  const box = $('#side-history');
  if (!state.history.length) {
    box.replaceChildren(h('div', { class: 'empty' }, '履歴はまだありません'));
    return;
  }
  box.replaceChildren(
    h('button', {
      class: 'small', onclick: async () => {
        if (!await confirmDelete(`履歴 ${state.history.length} 件をすべて削除しますか？\n保存済みリクエストとエビデンスは残ります。`)) return;
        state.history = [];
        renderHistory();
        persist();
      },
    }, '履歴をクリア'),
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
function openDialog(title, onSave, opt = {}) {
  const dlg = $(opt.id || '#dlg');
  const body = h('div');
  dlg.replaceChildren(
    h('div', { class: 'dlg-head' },
      h('h3', {}, title),
      h('button', { class: 'icon', title: '閉じる', onclick: () => dlg.close() }, '×')),
    body,
    h('div', { class: 'actions' },
      h('button', { onclick: () => dlg.close() }, '閉じる'),
      h('button', { class: 'primary' + (opt.danger ? ' danger' : ''), onclick: () => { if (onSave() !== false) dlg.close(); } }, opt.saveLabel || '保存')),
  );
  dlg.showModal();
  return body;
}
// 削除の確認。ブラウザ標準の confirm() の代わりに使う。「削除」を押したら true
function confirmDelete(message) {
  return new Promise((resolve) => {
    const body = openDialog('削除の確認', () => resolve(true), { id: '#confirmDlg', saveLabel: '削除', danger: true });
    body.append(...message.split('\n').map((t) => h('p', {}, t)));
    // 「閉じる」・×・Escで閉じた場合（「削除」のあとに呼ばれても、すでに確定しているので何も起きない）
    $('#confirmDlg').addEventListener('close', () => resolve(false), { once: true });
  });
}
const newEnv = (name, baseUrl = '', port = '') => ({ id: uid(), name, baseUrl, port, color: '', vars: [] });
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
  const body = openDialog(sys ? 'システムを編集' : 'システムを追加', () => {
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
      h('div', { class: 'row' }, field('送信先URL', base), h('label', { class: 'field port' }, h('span', {}, 'ポート番号（任意）'), port)),
      h('div', { class: 'hint' }, '検証用・本番用の送信先は、あとから「＋ 環境を作成」で追加できます。'),
    ]),
  );
  name.focus();
}

function saveDialog() {
  const name = h('input', { type: 'text', placeholder: '例: ユーザー一覧' });
  name.value = req.name || '';
  const packageInput = h('input', { type: 'text', placeholder: '例: イベント' });
  packageInput.value = req.package || '';
  const subpackageInput = h('input', { type: 'text', placeholder: '例: 参加者' });
  subpackageInput.value = req.subpackage || '';
  const NEW = '__new__';
  const sel = h('select', {}, ...state.systems.map((c) => h('option', { value: c.id }, c.name)), h('option', { value: NEW }, '＋ 新しいシステム'));
  // リクエストのidはシステムの中でしか一意でないので、選択中のシステムを先に探す
  const has = (c) => c.requests.some((r) => r.id === req.id);
  const current = req.id ? (curSystem() && has(curSystem()) ? curSystem() : state.systems.find(has)) : undefined;
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
    req.package = packageInput.value.trim();
    req.subpackage = subpackageInput.value.trim();
    if (!req.id) req.id = uid();
    // 別のシステムに保存し直したら、元のシステムからは外す。同じシステムなら、並び順を変えずに置き換える
    if (current && current !== target) current.requests = current.requests.filter((r) => r.id !== req.id);
    const at = target.requests.findIndex((r) => r.id === req.id);
    if (at >= 0) target.requests[at] = clone(req); else target.requests.push(clone(req));
    if (state.activeSystem !== target.id) selectEnv(target, target.envs[0]);
    else if (state.activeEnv) openEnvs.add(envKey(target.id, state.activeEnv));
    $('#reqName').textContent = req.name;
    persist();
    toast('保存しました');
  });
  body.append(
    h('div', { class: 'row' }, field('リクエスト名', name)),
    h('div', { class: 'row' }, field('パッケージ（任意）', packageInput), field('サブパッケージ（任意）', subpackageInput)),
    h('div', { class: 'row' }, field('保存先のシステム', sel), newField),
    h('div', { class: 'hint' }, '保存したリクエストは、そのシステムのすべての環境で使えます。'),
  );
  name.focus();
}

function createEnvDialog(sys) {
  const draft = newEnv('');
  environmentForm('環境を作成 — ' + sys.name, draft, () => {
    sys.envs.push(draft);
    if (sys.id === state.activeSystem && !curEnv()) selectEnv(sys, draft);
    persist();
    toast('環境を作成しました');
  }, { saveLabel: '環境を作成' });
}
function editEnvDialog(sys, selected) {
  if (!selected) return;
  const draft = clone(selected);
  environmentForm('環境を編集 — ' + selected.name, draft, () => {
    const index = sys.envs.findIndex((e) => e.id === selected.id);
    if (index < 0) return false;
    sys.envs[index] = draft;
    persist();
    toast('環境を更新しました');
  }, { saveLabel: '変更を保存', onDelete: async () => {
    if (!await confirmDelete(`環境「${selected.name}」を削除しますか？\nシステムのリクエストは残ります。`)) return;
    sys.envs = sys.envs.filter((e) => e.id !== selected.id);
    if (sys.id === state.activeSystem && state.activeEnv === selected.id) selectEnv(sys, sys.envs[0]);
    $('#dlg').close();
    renderSaved(); renderBase(); persist();
    toast('環境を削除しました');
  } });
}
function environmentForm(title, cur, save, options) {
  const error = h('div', { class: 'dlg-err', role: 'alert' });
  const body = openDialog(title, () => {
    if (!cur.name.trim()) { error.textContent = '環境名を入力してください'; return false; }
    cur.name = cur.name.trim();
    return save();
  }, { saveLabel: options.saveLabel });
  const saveButton = $('#dlg .actions button.primary');
  saveButton.classList.add('env-colored');
  const draw = () => {
    applyEnvColor(saveButton, cur.color);
    const name = h('input', { type: 'text', placeholder: '例: 検証' });
    name.value = cur.name;
    name.addEventListener('input', () => { cur.name = name.value; error.textContent = ''; });
    const base = h('input', { type: 'text', class: 'mono', placeholder: '例: https://api.example.com', spellcheck: 'false' });
    base.value = cur.baseUrl || '';
    base.addEventListener('input', () => { cur.baseUrl = base.value; });
    const port = portInput();
    port.value = cur.port || '';
    port.addEventListener('input', () => { cur.port = port.value; });
    const presets = [
      ['#0f766e', 'ティール'], ['#2563eb', 'ブルー'],
      ['#16a34a', 'グリーン'], ['#d97706', 'オレンジ'],
      ['#dc2626', 'レッド'], ['#9333ea', 'パープル'],
      ['#db2777', 'ピンク'], ['#64748b', 'グレー'],
    ];
    const currentColor = envColor(cur.color);
    const color = h('select', { 'aria-label': '環境の色' },
      h('option', { value: '' }, '標準色'),
      ...presets.map(([value, label]) => h('option', { value }, label)),
      ...(currentColor && !presets.some(([value]) => value === currentColor.toLowerCase())
        ? [h('option', { value: currentColor }, `現在の色（${currentColor}）`)] : []));
    color.value = currentColor.toLowerCase();
    if (color.selectedIndex < 0) color.value = currentColor;
    const swatch = colorDot(cur);
    color.addEventListener('change', () => {
      cur.color = color.value;
      swatch.style.backgroundColor = color.value || 'var(--accent)';
      applyEnvColor(saveButton, cur.color);
    });
    const resetColor = h('button', { onclick: () => { cur.color = ''; draw(); } }, '標準色に戻す');
    const vars = h('div', { class: 'env-vars' });
    kvEditor(vars, cur.vars, () => {}, ['変数名', '値']);
    body.replaceChildren(
      h('div', { class: 'row' }, field('環境名', name)),
      error,
      h('div', { class: 'row' },
        field('環境の色', h('div', { class: 'env-color-control' }, color, swatch)), resetColor),
      h('div', { class: 'row' }, field('送信先URL', base), h('label', { class: 'field port' }, h('span', {}, 'ポート番号（任意）'), port)),
      h('div', { class: 'hint' }, '例：https://api.example.com を設定すると、リクエストには /users などのパスだけを入力できます。'),
      h('h4', {}, '変数'),
      vars,
      h('div', { class: 'hint' }, 'リクエストに ${token} などと書くと、この環境に設定した値を使います。環境ごとに異なるトークンや値を登録できます。'),
      ...(options.onDelete ? [h('div', { class: 'row' }, h('button', { class: 'delete-action', onclick: options.onDelete }, '環境を削除'))] : []),
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
// { error } か { message }（取り込んだ件数）を返す
function importText(text) {
  const { list, error } = parseImport(text);
  if (error) return { error };
  const r = mergeImport(state.systems, list);
  // 編集中のリクエストが更新されたら、画面にも反映する
  const sys = curSystem();
  const cur = sys && req.id && sys.requests.find((x) => x.id === req.id);
  if (cur && r.updatedReqs.includes(cur)) loadReq(cur);
  renderSaved(); renderBase(); persist();
  const n = ([add, upd]) => `追加 ${add}・更新 ${upd}`;
  return { message: `インポートしました（システム: ${n(r.sys)} ／ 環境: ${n(r.env)} ／ リクエスト: ${n(r.req)}）` };
}
function importDialog() {
  const text = h('textarea', { class: 'import-text', placeholder: '{ "app": "evirest", "version": 2, "systems": [ ... ] }', spellcheck: 'false' });
  const file = h('input', { type: 'file', accept: '.json,application/json', hidden: true });
  const fileName = h('span', { class: 'file-name' }, '選択されていません');
  const err = h('div', { class: 'dlg-err', hidden: true });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    text.value = await f.text();
    fileName.textContent = f.name;
    err.hidden = true;
  });
  const body = openDialog('インポート', () => {
    const { error, message } = importText(text.value);
    if (error) { err.textContent = error; err.hidden = false; return false; }
    toast(message);
  }, { saveLabel: '取り込む' });
  body.append(
    h('h4', {}, '方法1: ファイルを選ぶ'),
    h('div', { class: 'row' }, h('button', { onclick: () => file.click() }, 'ファイルを選ぶ…'), fileName, file),
    h('h4', {}, '方法2: JSONを貼り付ける'),
    h('div', { class: 'row' }, field('取り込むJSON（AIの回答も貼り付けられます）', text)),
    h('div', { class: 'hint' }, 'ファイルを選ぶか、JSONを貼り付けて「取り込む」を押してください。エクスポートしたデータを編集して取り込むと、既存の設定を更新できます。取り込みだけで既存のデータが削除されることはありません。'),
    err,
  );
}

/* ---------- AI用プロンプト ---------- */
// 編集した内容はコピーにだけ使い、保存しない（開くたびに元の文面に戻る）
function promptDialog() {
  const text = h('textarea', { class: 'prompt-text', spellcheck: 'false' });
  text.value = AI_PROMPT;
  const note = h('div', { class: 'dlg-note', hidden: true });
  const say = (msg, bad) => { note.textContent = msg; note.classList.toggle('bad', !!bad); note.hidden = false; };
  const body = openDialog('AI用プロンプト', () => {
    navigator.clipboard.writeText(text.value).then(() => say('コピーしました。AIに貼り付けてください。'), () => say('コピーに失敗しました。', true));
    return false;
  }, { saveLabel: 'コピー' });
  body.append(
    h('div', { class: 'hint' }, '最後の「# 依頼」に作りたいAPIテストを書き、コピーしてAIに渡してください。返ってきたJSONは「インポート」で登録できます。この依頼文の編集内容は保存されません。'),
    text,
    note,
  );
}

/* ---------- テストエビデンス ---------- */
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
      h('button', { class: 'small', onclick: exportEvidence }, 'HTMLで開く'),
      h('button', { class: 'small', onclick: exportEvidenceXlsx }, 'Excel出力'),
      h('button', {
        class: 'small',
        onclick: async () => {
          if (!await confirmDelete(`エビデンス ${state.evidence.length} 件をすべて削除しますか？`)) return;
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
  openHtmlReport(evidenceHtml(state.evidence, state.maskEv));
}
function openHtmlReport(html) {
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const link = h('a', { href: url, target: '_blank', rel: 'noopener' });
  document.body.append(link);
  link.click();
  link.remove();
  // タブの読み込み後に解放する。HTMLはブラウザの保存・印刷で出力できる。
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

/* ---------- テストエビデンス（Excel） ---------- */
async function exportEvidenceXlsx() {
  return exportXlsxReport(state.evidence, state.maskEv);
}
async function exportXlsxReport(list, masked) {
  if (typeof writeXlsxFile !== 'function') { toast('Excel出力に必要なファイルが見つかりません。拡張機能を更新するか、再インストールしてください。'); return; }
  try {
    const blob = await writeXlsxFile(evidenceSheets(list, masked)).toBlob();
    saveBlob(blob, evidenceFileName('xlsx'));
  } catch (e) {
    toast('Excel出力に失敗: ' + e.message);
  }
}

/* ---------- イベント登録・起動 ---------- */
// サイドメニュー下部（AI用プロンプト・エクスポート・インポート）の折りたたみ
function initSideFoot() {
  const toggle = $('#footToggle');
  const apply = () => {
    const open = !state.footCollapsed;
    $('#footBody').hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    $('.tw', toggle).classList.toggle('open', open);
  };
  toggle.addEventListener('click', () => { state.footCollapsed = !state.footCollapsed; apply(); persist(); });
  apply();
}
function initBatchInterval() {
  const select = $('#batchInterval');
  select.replaceChildren(...BATCH_INTERVALS.map((ms) => h('option', { value: ms }, `${ms / 1000}秒`)));
  select.value = batchIntervalOf(state.batchInterval);
  select.addEventListener('change', () => { state.batchInterval = batchIntervalOf(select.value); updateBatchControls(); persist(); });
}
function initSideResize() {
  const handle = $('#sideResize');
  const side = $('#side');
  let drag = null;
  const maxWidth = () => Math.max(240, Math.min(720, $('#app').clientWidth - 368));
  function applyWidth(width) {
    const value = Math.round(Math.max(240, Math.min(maxWidth(), width)));
    side.style.width = value + 'px';
    handle.setAttribute('aria-valuemax', maxWidth());
    handle.setAttribute('aria-valuenow', value);
    handle.setAttribute('aria-valuetext', value + 'ピクセル');
    return value;
  }
  function saveWidth(width) {
    state.sidebarWidth = applyWidth(width);
    persist();
  }
  applyWidth(state.sidebarWidth || 280);
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    e.preventDefault();
    handle.focus();
    drag = { id: e.pointerId, x: e.clientX, width: side.getBoundingClientRect().width };
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-side');
  });
  handle.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) applyWidth(drag.width + e.clientX - drag.x);
  });
  function finish(e) {
    if (!drag || e.pointerId !== drag.id) return;
    drag = null;
    document.body.classList.remove('resizing-side');
    saveWidth(side.getBoundingClientRect().width);
    if (handle.hasPointerCapture(e.pointerId)) handle.releasePointerCapture(e.pointerId);
  }
  for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(event, finish);
  handle.addEventListener('keydown', (e) => {
    const width = side.getBoundingClientRect().width;
    const step = e.shiftKey ? 50 : 10;
    const next = { ArrowLeft: width - step, ArrowRight: width + step, Home: 240, End: maxWidth() }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    saveWidth(next);
  });
  handle.addEventListener('dblclick', () => saveWidth(280));
  window.addEventListener('resize', () => applyWidth(state.sidebarWidth || 280));
}
function bind() {
  $('#batchRun').addEventListener('click', runBatch);
  // 動的に追加されるボタンと Enter / Space によるクリックも共通で扱う。
  const buttonFeedback = new WeakMap();
  document.addEventListener('click', (e) => {
    const button = e.target.closest('button');
    if (!button || button.disabled || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    buttonFeedback.get(button)?.cancel();
    buttonFeedback.set(button, button.animate([
      { boxShadow: 'inset 0 0 0 2px currentColor' },
      { boxShadow: 'inset 0 0 0 2px transparent' },
    ], { duration: 240, easing: 'ease-out' }));
  }, { capture: true });
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

  $('#base').addEventListener('click', () => { if (curSystem() && curEnv()) editEnvDialog(curSystem(), curEnv()); });
  $('#dlg').addEventListener('close', () => { renderSaved(); renderBase(); });

  $('#copyBody').addEventListener('click', async () => {
    if (!last || last.image) return;
    const text = last.json !== undefined ? JSON.stringify(last.json, null, 2) : last.text;
    try { await navigator.clipboard.writeText(text); toast('コピーしました'); } catch { toast('コピーに失敗しました'); }
  });
  $('#addEv').addEventListener('click', addEvidenceDialog);
  $('#copyPrompt').addEventListener('click', promptDialog);
  $('#exportBtn').addEventListener('click', exportAll);
  $('#importBtn').addEventListener('click', importDialog);
}

(async function init() {
  const saved = await store.get().catch(() => null);
  if (saved) {
    state.sidebarWidth = Number.isFinite(saved.sidebarWidth) ? saved.sidebarWidth : 280;
    state.batchInterval = batchIntervalOf(saved.batchInterval);
    state.footCollapsed = saved.footCollapsed === true;
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
    if (state.activeEnv) openEnvs.add(envKey(state.activeSystem, state.activeEnv));
    state.evidence = saved.evidence || [];
    state.tester = saved.tester || '';
    state.maskEv = saved.maskEv !== false;
    state.draft = Object.assign(blankReq(), saved.draft || {});
    state.draft.auth = Object.assign(blankReq().auth, state.draft.auth);
  }
  // 旧エビデンス用チェックを実行対象の選択として引き継ぐ。
  for (const system of state.systems) for (const request of system.requests) {
    request.batchSelected = batchSelectedOf(request);
    delete request.recordEvidence;
  }
  state.draft.batchSelected = batchSelectedOf(saved?.draft || state.draft);
  delete state.draft.recordEvidence;
  req = state.draft;
  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) $('#appVer').textContent = 'v' + chrome.runtime.getManifest().version;
  initTabs();
  initSideResize();
  initSideFoot();
  initBatchInterval();
  bind();
  syncUI();
  renderSaved();
  renderHistory();
  renderEvidence();
})();
