// public/assets/pull-refresh.js
// 通用 iOS 风格下拉刷新（零依赖、自包含：自动注入样式 + 自动创建指示器 DOM）。
//
// 用法：
//   const ptr = PullToRefresh.mount({
//     content: document.querySelector('.wrap'),   // 必填：被下推的内容容器
//     anchor:  document.querySelector('.topbar'),// 可选：指示器贴在该元素底部（通常是顶栏）
//     onRefresh: async () => { /* 拉数据、重渲染 */ }, // 必填：返回 Promise
//     canRefresh: () => true,                    // 可选：本次手势是否允许生效
//     threshold: 64, maxPull: 112,              // 可选：触发阈值 / 阻尼上限
//     labels: { pull, release, refreshing, done } // 可选：文案
//   });
//   ptr.refresh();  // 可选：程序化触发一次刷新（带完整动画）
//   ptr.destroy();  // 移除 DOM / 样式类 / 事件监听
//
// 约束：只在页面已滚到顶部时生效；刷新期间重复手势会被忽略。
// 刷新回调里请自行保证「不写本地已读基线」等语义，本模块只负责手势与视觉。
(function (global) {
  'use strict';

  var STYLE_ID = 'ptr-style';
  var CSS = [
    '.ptr { position: fixed; left: 0; right: 0; top: 0; z-index: 15; height: 0; overflow: hidden;',
    '  display: flex; align-items: center; justify-content: center; pointer-events: none; will-change: height; }',
    '.ptr.settling { transition: height .3s cubic-bezier(.22,.61,.36,1); }',
    '.ptr-inner { flex: 1; height: 100%; min-height: 0; display: flex;',
    '  align-items: center; justify-content: center; gap: 8px;',
    '  color: var(--muted, #888); font-size: 13px; opacity: 0; transform: scale(.82);',
    '  transition: opacity .12s linear, transform .12s linear; }',
    '.ptr-icon { display: inline-flex; width: 20px; height: 20px; transition: transform .2s ease; }',
    '.ptr.ready .ptr-icon { transform: rotate(180deg); }',
    '.ptr-spinner { width: 18px; height: 18px; border: 2px solid var(--border, #ececec);',
    '  border-top-color: var(--primary, #3b5bdb); border-radius: 50%; animation: ptr-spin .7s linear infinite; }',
    '.ptr-check { width: 20px; height: 20px; display: inline-flex; align-items: center;',
    '  justify-content: center; color: var(--primary, #3b5bdb); font-size: 16px; font-weight: 700; }',
    '.ptr [hidden] { display: none !important; }',
    '.ptr-content.settling { transition: transform .3s cubic-bezier(.22,.61,.36,1); }',
    'body[data-ptr-enabled] { overscroll-behavior-y: contain; }',
    '@keyframes ptr-spin { to { transform: rotate(360deg); } }'
  ].join('\n');

  var ARROW = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" ' +
    'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<line x1="12" y1="4" x2="12" y2="19"></line><polyline points="6 13 12 19 18 13"></polyline></svg>';

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function createIndicator() {
    // 同一页面只保留一个指示器（避免多处 mount 时叠两层）
    var old = document.querySelector('.ptr');
    if (old) old.remove();
    var el = document.createElement('div');
    el.className = 'ptr';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML =
      '<div class="ptr-inner">' +
        '<span class="ptr-icon">' + ARROW + '</span>' +
        '<span class="ptr-spinner" hidden></span>' +
        '<span class="ptr-check" hidden>✓</span>' +
        '<span class="ptr-text"></span>' +
      '</div>';
    document.body.appendChild(el);
    return {
      root: el,
      inner: el.querySelector('.ptr-inner'),
      icon: el.querySelector('.ptr-icon'),
      spinner: el.querySelector('.ptr-spinner'),
      check: el.querySelector('.ptr-check'),
      text: el.querySelector('.ptr-text')
    };
  }

  var active = null;

  function mount(options) {
    var opts = options || {};
    var content = opts.content;
    var anchor = opts.anchor || null;
    var onRefresh = opts.onRefresh;
    if (!content || typeof onRefresh !== 'function') {
      throw new Error('PullToRefresh.mount 需要 content 与 onRefresh');
    }
    if (active) active.destroy();

    injectStyle();
    var ui = createIndicator();
    content.classList.add('ptr-content');
    document.body.setAttribute('data-ptr-enabled', '');

    var THRESHOLD = Math.max(1, Number(opts.threshold) || 64);
    var MAX_PULL = Math.max(THRESHOLD, Number(opts.maxPull) || 112);
    var L = Object.assign({
      pull: '下拉刷新', release: '释放立即刷新',
      refreshing: '正在刷新…', done: '刷新完成'
    }, opts.labels || {});

    var startY = 0, pull = 0;
    var tracking = false, pulling = false, refreshing = false, moved = false, destroyed = false;

    var scrollTop = function () {
      return global.scrollY ||
        (document.documentElement && document.documentElement.scrollTop) ||
        (document.body && document.body.scrollTop) || 0;
    };
    var atTop = function () { return scrollTop() <= 0; };
    var allowed = function () { return !opts.canRefresh || opts.canRefresh(); };

    function render(px) {
      pull = Math.max(0, Math.min(MAX_PULL, px));
      ui.root.style.height = pull + 'px';
      content.style.transform = pull ? 'translateY(' + pull + 'px)' : '';
      var p = Math.min(1, pull / THRESHOLD);
      ui.inner.style.opacity = String(p);
      ui.inner.style.transform = 'scale(' + (0.82 + 0.18 * p).toFixed(3) + ')';
      // 标签/箭头随位移实时更新（含「拉过阈值又滑回去」的回退）；刷新中由 doRefresh 接管文案
      if (!refreshing) {
        var ready = pull >= THRESHOLD;
        ui.root.classList.toggle('ready', ready);
        ui.text.textContent = ready ? L.release : L.pull;
      }
    }

    // 阻尼：线性跟手，过阈值后阻力骤增，模拟 iOS 橡皮筋
    function damped(delta) {
      if (delta <= 0) return 0;
      var linear = delta * 0.55;
      var rubber = linear > THRESHOLD ? THRESHOLD + (linear - THRESHOLD) * 0.35 : linear;
      return Math.min(MAX_PULL, rubber);
    }

    function begin(y) {
      if (destroyed || refreshing || !atTop() || !allowed()) return;
      tracking = true; pulling = false; moved = false; startY = y;
      ui.root.style.top = (anchor ? anchor.getBoundingClientRect().bottom : 0) + 'px';
      ui.root.classList.remove('settling');
      content.classList.remove('settling');
    }

    function move(y, ev) {
      if (!tracking || refreshing) return;
      var delta = y - startY;
      if (delta <= 0) {
        if (pulling) { render(0); pulling = false; }
        return;
      }
      if (!atTop()) { cancel(); return; }           // 期间被惯性滚动带离顶部则放弃
      if (ev && ev.cancelable) ev.preventDefault(); // 阻止 iOS 原生回弹 / 桌面选中文字
      pulling = true; moved = true;
      render(damped(delta));
    }

    function cancel() {
      if (pulling) settle(0);
      tracking = false; pulling = false;
    }

    function settle(target) {
      ui.root.classList.add('settling');
      content.classList.add('settling');
      render(target);
      global.setTimeout(function () {
        ui.root.classList.remove('settling');
        content.classList.remove('settling');
      }, 320);
    }

    function reset() {
      ui.root.classList.remove('ready', 'refreshing');
      ui.icon.hidden = false; ui.spinner.hidden = true; ui.check.hidden = true;
      ui.text.textContent = L.pull;
      render(0);
    }

    function doRefresh() {
      if (refreshing) return Promise.resolve();
      refreshing = true;
      ui.root.classList.remove('ready');
      ui.root.classList.add('refreshing', 'settling');
      content.classList.add('settling');
      render(THRESHOLD);                 // 停在阈值高度，和 iOS 一样
      ui.icon.hidden = true; ui.spinner.hidden = false; ui.check.hidden = true;
      ui.text.textContent = L.refreshing;
      return Promise.resolve()
        .then(onRefresh)
        .catch(function () { /* 失败也照常收起，不卡住手势 */ })
        .then(function () {
          ui.spinner.hidden = true; ui.check.hidden = false;
          ui.text.textContent = L.done;
          return new Promise(function (r) { global.setTimeout(r, 420); });
        })
        .then(function () {
          settle(0);
          return new Promise(function (r) { global.setTimeout(r, 320); });
        })
        .then(function () {
          if (destroyed) return;
          reset();
          refreshing = false;
        });
    }

    function end() {
      if (!tracking || refreshing) return;
      tracking = false;
      if (pulling && pull >= THRESHOLD) doRefresh();
      else if (pulling) settle(0);
      pulling = false;
    }

    // —— 触摸（iOS / Android）——
    function onTouchStart(e) {
      moved = false;
      if (e.touches.length !== 1) return;
      begin(e.touches[0].clientY);
    }
    function onTouchMove(e) { if (tracking) move(e.touches[0].clientY, e); }
    function onTouchEnd() { end(); }
    function onTouchCancel() { cancel(); }

    // —— 鼠标（桌面）；下拉后抑制误触点击 ——
    function onMouseDown(e) {
      moved = false;
      if (e.button !== 0) return;
      begin(e.clientY);
    }
    function onMouseMove(e) { if (tracking) move(e.clientY, e); }
    function onMouseUp() { end(); }
    function onClickCapture(e) {
      if (moved) { e.preventDefault(); e.stopPropagation(); moved = false; }
    }

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
    document.addEventListener('touchcancel', onTouchCancel, { passive: true });
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('click', onClickCapture, true);

    var instance = {
      // 程序化触发：先展开到阈值，再走完整刷新动画
      refresh: function () {
        if (destroyed) return Promise.resolve();
        ui.root.style.top = (anchor ? anchor.getBoundingClientRect().bottom : 0) + 'px';
        return doRefresh();
      },
      destroy: function () {
        if (destroyed) return;
        destroyed = true;
        document.removeEventListener('touchstart', onTouchStart);
        document.removeEventListener('touchmove', onTouchMove);
        document.removeEventListener('touchend', onTouchEnd);
        document.removeEventListener('touchcancel', onTouchCancel);
        document.removeEventListener('mousedown', onMouseDown);
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        document.removeEventListener('click', onClickCapture, true);
        ui.root.remove();
        content.classList.remove('ptr-content', 'settling');
        content.style.transform = '';
        document.body.removeAttribute('data-ptr-enabled');
        if (active === instance) active = null;
      }
    };
    active = instance;
    return instance;
  }

  global.PullToRefresh = { mount: mount };
})(window);
