// public/assets/sync.js
// 同步码云同步（单人使用、无账号、不加密）。自包含：自动注入样式 + 创建 UI。
//
// 依赖 app.js 暴露的全局函数：loadState() / saveState(silent) / setStateChangeHook(fn)。
// 接口用相对路径 api/sync/...，天然跟随 BASE_PATH 子路径。
//
// 用法（由 shelfPage 调用）：
//   QJSync.mount({ onSynced: () => renderShelf({ keepOld: true }) });
//   QJSync.syncNow({ timeout: 5000, onSynced: false });
//
// 数据格式 = 本地统一状态对象 qingjian_userdata，服务端不解析内容，零格式转换。
(function (global) {
  'use strict';

  var CODE_KEY = 'qingjian_sync_code';
  var REV_KEY = 'qingjian_sync_rev';
  var TIME_KEY = 'qingjian_sync_time';
  var CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;
  var STYLE_ID = 'qjs-style';
  var CSS = [
    '.qjs-bar { display:flex; align-items:center; gap:8px; margin:10px 0 4px; padding:8px 10px;',
    '  background:var(--card,#fff); border:1px solid var(--border,#ececec); border-radius:8px;',
    '  font-size:12px; color:var(--muted,#888); }',
    '.qjs-dot { width:7px; height:7px; border-radius:50%; background:#ccc; flex:none; }',
    '.qjs-dot.on { background:#2fb344; } .qjs-dot.busy { background:#f0a020; animation:qjs-pulse 1s infinite; }',
    '.qjs-dot.err { background:#e03131; }',
    '@keyframes qjs-pulse { 50% { opacity:.35; } }',
    '.qjs-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }',
    '.qjs-bar button, .qjs-sheet button { font:inherit; cursor:pointer; border:1px solid var(--border,#ececec);',
    '  background:#fff; color:var(--text,#222); border-radius:6px; padding:5px 10px; }',
    '.qjs-bar button { flex:none; padding:4px 10px; }',
    '.qjs-bar button:hover, .qjs-sheet button:hover { border-color:var(--primary,#3b5bdb); color:var(--primary,#3b5bdb); }',
    '.qjs-primary { background:var(--primary,#3b5bdb) !important; color:#fff !important;',
    '  border-color:var(--primary,#3b5bdb) !important; width:100%; padding:9px !important; font-size:14px !important; }',
    '.qjs-primary:hover { opacity:.9; color:#fff !important; }',
    '.qjs-overlay { position:fixed; inset:0; z-index:70; background:rgba(0,0,0,.45);',
    '  display:flex; align-items:center; justify-content:center; padding:16px; }',
    '.qjs-overlay[hidden] { display:none; }',
    '.qjs-sheet { width:100%; max-width:360px; background:#fff; border-radius:12px; padding:16px;',
    '  box-shadow:0 10px 40px rgba(0,0,0,.2); max-height:85vh; overflow:auto; }',
    '.qjs-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; font-size:16px; }',
    '.qjs-head button { border:0; background:transparent; font-size:22px; line-height:1; padding:0 4px; }',
    '.qjs-tip { font-size:12px; color:var(--muted,#888); line-height:1.6; margin:8px 0 14px; }',
    '.qjs-warn { font-size:12px; color:#b35309; background:#fff4e6; border:1px solid #ffd8a8;',
    '  border-radius:6px; padding:8px 10px; margin:14px 0 0; line-height:1.5; }',
    '.qjs-or { text-align:center; font-size:12px; color:var(--muted,#888); margin:14px 0; }',
    '.qjs-row { display:flex; gap:8px; flex-wrap:wrap; }',
    '.qjs-row input { flex:1; min-width:150px; border:1px solid var(--border,#ececec); border-radius:6px;',
    '  padding:8px; font:inherit; letter-spacing:1px; text-transform:uppercase; }',
    '.qjs-code { font-size:20px; font-weight:700; letter-spacing:2px; text-align:center;',
    '  padding:14px; background:#f4f6ff; border:1px dashed var(--primary,#3b5bdb);',
    '  border-radius:8px; color:var(--primary,#3b5bdb); margin:6px 0 12px; user-select:all; }',
    '.qjs-status { font-size:12px; color:var(--muted,#888); margin:14px 0; text-align:center; }',
    '.qjs-actions { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:10px; }',
    '.qjs-actions button { width:100%; }',
    '.qjs-danger { color:#e03131 !important; }'
  ].join('\n');

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function nowStr() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function getCode() { try { return localStorage.getItem(CODE_KEY) || ''; } catch (e) { return ''; } }
  function setCode(c) {
    try {
      if (c) localStorage.setItem(CODE_KEY, c);
      else { localStorage.removeItem(CODE_KEY); localStorage.removeItem(REV_KEY); }
    } catch (e) {}
  }

  // ---------- 合并：按 src:id 取 ts 大者，同 ts 本地优先；墓碑也靠 ts 裁决 ----------
  function mergeMap(a, b) {
    var out = {}, keys = {};
    Object.keys(a || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(b || {}).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      var x = a && a[k], y = b && b[k];
      if (!x) { if (y) out[k] = y; return; }
      if (!y) { out[k] = x; return; }
      out[k] = ((y.ts || 0) > (x.ts || 0)) ? y : x;
    });
    return out;
  }
  function mergeHistory(a, b) {
    var m = {};
    [].concat(b || [], a || []).forEach(function (h) {
      if (!h || !h.id) return;
      var k = (h.src || '') + ':' + String(h.id);
      var old = m[k];
      if (!old || (h.ts || 0) > (old.ts || 0)) m[k] = h;
    });
    return Object.keys(m).map(function (k) { return m[k]; })
      .sort(function (x, y) { return (y.ts || 0) - (x.ts || 0); }).slice(0, 80);
  }
  function mergeState(local, remote) {
    if (!remote || typeof remote !== 'object') return local;
    return {
      v: 2,
      updatedAt: Math.max(local.updatedAt || 0, remote.updatedAt || 0, Date.now()),
      books: mergeMap(local.books, remote.books),
      progress: mergeMap(local.progress, remote.progress),
      seen: mergeMap(local.seen, remote.seen),
      history: mergeHistory(local.history, remote.history),
      // 阅读器设置也同步：按 ts 取「最后修改的设备」为准。
      // 老数据没有 ts（视为 0）→ 本地优先，升级时不会被远端旧设置突袭。
      reader: (function () {
        var lr = local.reader || { fs: 19, lh: 1.8, theme: 'day' };
        var rr = remote.reader;
        if (!rr) return lr;
        return ((rr.ts || 0) > (lr.ts || 0)) ? rr : lr;
      })()
    };
  }

  // 把合并结果写回本地：原地改 loadState() 返回的引用，再静默持久化
  function applyLocal(merged) {
    var s = global.loadState();
    Object.keys(merged).forEach(function (k) { s[k] = merged[k]; });
    global.saveState(true);
  }

  // ---------- 网络 ----------
  function url(code) { return 'api/sync/' + encodeURIComponent(code); }

  async function doSync(code, signal, attempt, onSynced) {
    var local = clone(global.loadState());
    var r = await fetch(url(code), { signal: signal });
    var remote = null, rev = 0;
    if (r.status === 404) {
      // 云端还没数据：直接把本地全量推上去（首次配对）
    } else if (r.ok) {
      var j = await r.json();
      remote = j.data; rev = j.rev || 0;
    } else {
      throw new Error('GET ' + r.status);
    }

    var merged = mergeState(local, remote);
    applyLocal(merged); // 合并而非覆盖：另一台设备上已有的本地数据不会丢

    var p = await fetch(url(code), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseRev: rev, data: merged }),
      signal: signal
    });
    if (p.status === 409) {
      // 有人抢先写了一版：用服务端最新数据再合并一次后重试
      if (attempt >= 3) throw new Error('conflict');
      var c = await p.json();
      applyLocal(mergeState(clone(global.loadState()), c.data));
      return doSync(code, signal, attempt + 1, onSynced);
    }
    if (!p.ok) throw new Error('PUT ' + p.status);
    var pr = await p.json();
    try {
      localStorage.setItem(REV_KEY, String(pr.rev));
      localStorage.setItem(TIME_KEY, String(Date.now()));
    } catch (e) {}
    if (onSynced) { try { onSynced(); } catch (e) {} }
    return { ok: true, rev: pr.rev };
  }

  var defaultOnSynced = null;
  var syncing = false;
  var debounceTimer = null;

  async function syncNow(opts) {
    opts = opts || {};
    var code = getCode();
    if (!code || syncing) return { ok: false, reason: code ? 'busy' : 'unconfigured' };
    syncing = true;
    setBusy(true);
    var ctrl = new AbortController();
    var timer = global.setTimeout(function () { ctrl.abort(); }, opts.timeout || 8000);
    var onSynced = opts.onSynced === false ? null : (opts.onSynced || defaultOnSynced);
    try {
      var r = await doSync(code, ctrl.signal, 0, onSynced);
      setStatus('ok');
      return r;
    } catch (e) {
      setStatus('err');
      return { ok: false, reason: e && e.message ? e.message : 'failed' };
    } finally {
      global.clearTimeout(timer);
      syncing = false;
      setBusy(false);
    }
  }

  function scheduleSync() {
    if (!getCode()) return;
    global.clearTimeout(debounceTimer);
    debounceTimer = global.setTimeout(function () { syncNow({ timeout: 8000 }); }, 2000);
  }

  // ---------- UI ----------
  var bar, dot, text, btn, overlay, body;
  function setBusy(busy) {
    if (dot) dot.className = 'qjs-dot' + (busy ? ' busy' : (getCode() ? ' on' : ''));
  }
  function setStatus(kind) {
    if (!dot || !text) return;
    var t = '';
    try { t = localStorage.getItem(TIME_KEY) || ''; } catch (e) {}
    var when = t ? new Date(Number(t)) : null;
    var w = when ? ('上次 ' + ('0' + when.getHours()).slice(-2) + ':' + ('0' + when.getMinutes()).slice(-2)) : '尚未同步';
    if (kind === 'busy') { dot.className = 'qjs-dot busy'; text.textContent = '云同步：同步中…'; return; }
    if (!getCode()) { dot.className = 'qjs-dot'; text.textContent = '云同步：未开启'; return; }
    if (kind === 'err') { dot.className = 'qjs-dot err'; text.textContent = '云同步：同步失败，稍后重试（' + w + '）'; return; }
    dot.className = 'qjs-dot on';
    text.textContent = '云同步：已开启 · ' + w;
  }

  function buildUI() {
    bar = document.createElement('div');
    bar.className = 'qjs-bar';
    bar.innerHTML = '<span class="qjs-dot"></span><span class="qjs-text"></span>' +
      '<button type="button" class="qjs-open">设置</button>';
    // 插在 tabs 之后、书架内容之前
    var tabs = document.getElementById('shelfTabs');
    if (tabs && tabs.parentNode) tabs.parentNode.insertBefore(bar, tabs.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);
    dot = bar.querySelector('.qjs-dot');
    text = bar.querySelector('.qjs-text');
    btn = bar.querySelector('.qjs-open');

    overlay = document.createElement('div');
    overlay.className = 'qjs-overlay';
    overlay.hidden = true;
    overlay.innerHTML = '<div class="qjs-sheet"><div class="qjs-head"><b>云同步</b>' +
      '<button type="button" class="qjs-close" aria-label="关闭">×</button></div>' +
      '<div class="qjs-body"></div></div>';
    document.body.appendChild(overlay);
    body = overlay.querySelector('.qjs-body');

    btn.addEventListener('click', open);
    overlay.querySelector('.qjs-close').addEventListener('click', close);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    setStatus('ok');
  }

  function renderBody() {
    var code = getCode();
    if (!code) {
      body.innerHTML =
        '<p class="qjs-tip">用一个同步码把书架、阅读进度和「更新」记录同步到你的其他设备。数据保存在你自己的服务器上，不加密。</p>' +
        '<button type="button" class="qjs-primary qjs-gen">生成新同步码</button>' +
        '<div class="qjs-or">或，已有同步码</div>' +
        '<div class="qjs-row"><input class="qjs-input" placeholder="XXXX-XXXX-XXXX" maxlength="14" autocomplete="off">' +
        '<button type="button" class="qjs-use">使用</button></div>' +
        '<p class="qjs-warn">同步码即凭证：拿到码的人可以读写你的书架与阅读记录，请勿公开。请只在自己的设备间使用。</p>';
      body.querySelector('.qjs-gen').addEventListener('click', genCode);
      body.querySelector('.qjs-use').addEventListener('click', useCode);
      body.querySelector('.qjs-input').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') useCode();
      });
      return;
    }
    body.innerHTML =
      '<p class="qjs-tip">在另一台设备打开书架页 → 云同步 → 输入下面的码，即可自动同步。</p>' +
      '<div class="qjs-code"></div>' +
      '<button type="button" class="qjs-primary qjs-copy">复制同步码</button>' +
      '<div class="qjs-status"></div>' +
      '<div class="qjs-actions">' +
      '<button type="button" class="qjs-now">立即同步</button>' +
      '<button type="button" class="qjs-change">更换同步码</button>' +
      '<button type="button" class="qjs-off qjs-danger">关闭同步</button>' +
      '</div>' +
      '<p class="qjs-tip" style="margin-top:14px">同步码明文保存在服务器文件中；更换或关闭不会删除本地书架数据。</p>';
    body.querySelector('.qjs-code').textContent = code;
    var st = '尚未同步';
    try {
      var t = localStorage.getItem(TIME_KEY);
      if (t) st = '上次同步：' + new Date(Number(t)).toLocaleString();
    } catch (e) {}
    body.querySelector('.qjs-status').textContent = st;
    body.querySelector('.qjs-copy').addEventListener('click', function () {
      var b = this;
      var done = function () { b.textContent = '已复制 ✓'; global.setTimeout(function () { b.textContent = '复制同步码'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(done, function () { b.textContent = '请长按上方码手动复制'; });
      } else { b.textContent = '请长按上方码手动复制'; }
    });
    body.querySelector('.qjs-now').addEventListener('click', function () {
      var b = this; b.disabled = true; b.textContent = '同步中…';
      syncNow({ timeout: 8000 }).then(function (r) {
        b.disabled = false; b.textContent = '立即同步';
        renderBody(); setStatus(r.ok ? 'ok' : 'err');
      });
    });
    body.querySelector('.qjs-change').addEventListener('click', function () {
      if (!confirm('更换同步码后，本机将停止与旧码同步（本地数据保留）。确定？')) return;
      setCode(''); renderBody(); setStatus('ok');
    });
    body.querySelector('.qjs-off').addEventListener('click', function () {
      if (!confirm('关闭云同步？本地书架与进度都会保留。')) return;
      setCode(''); renderBody(); setStatus('ok');
    });
  }

  function open() { renderBody(); overlay.hidden = false; }
  function close() { overlay.hidden = true; }

  function normalizeCode(s) {
    s = String(s || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
    if (s.length !== 12) return '';
    return s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
  }
  async function genCode() {
    var b = body.querySelector('.qjs-gen');
    b.disabled = true; b.textContent = '生成中…';
    try {
      var r = await fetch('api/sync/new', { method: 'POST' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      var j = await r.json();
      setCode(j.code);
      renderBody(); setStatus('ok');
      await syncNow({ timeout: 8000 }); // 首次配对：立刻把本地全量推上去
      renderBody(); setStatus('ok');
    } catch (e) {
      b.disabled = false; b.textContent = '生成新同步码';
      alert('生成失败，请检查服务是否可用');
    }
  }
  function useCode() {
    var c = normalizeCode(body.querySelector('.qjs-input').value);
    if (!CODE_RE.test(c)) { alert('同步码格式不对，应为 12 位字符（如 X7KD-3M9P-Q2RT）'); return; }
    setCode(c);
    renderBody(); setStatus('busy');
    syncNow({ timeout: 8000 }).then(function (r) { renderBody(); setStatus(r.ok ? 'ok' : 'err'); });
  }

  function mount(opts) {
    opts = opts || {};
    defaultOnSynced = opts.onSynced || null;
    injectStyle();
    buildUI();
    // 所有本地数据变更都经 saveState()，这里统一挂一个防抖推送
    if (typeof global.setStateChangeHook === 'function') global.setStateChangeHook(scheduleSync);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) scheduleSync();
    });
    if (getCode()) syncNow({ timeout: 8000 }); // 启动后台同步，不阻塞渲染
    return { syncNow: syncNow, scheduleSync: scheduleSync, destroy: function () {
      if (typeof global.setStateChangeHook === 'function') global.setStateChangeHook(null);
    } };
  }

  global.QJSync = { mount: mount, syncNow: syncNow, scheduleSync: scheduleSync,
    mergeState: mergeState }; // mergeState 暴露给单测
})(window);
