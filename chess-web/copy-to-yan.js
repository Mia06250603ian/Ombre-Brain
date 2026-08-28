// 「复制给晏」补丁 —— 注入进 flight-chess-popup.html 的一段脚本。
//
// 它做的事只有一件：掷完骰子之后，把这一格该告诉晏的话准备好，一点就复制，
// 你切到 Telegram 粘贴给他即可。**这一层不联网、不发消息、不碰任何服务。**
//
// 为什么不做成「自动发给他」：那要走 dwell-bridge → shim，
// 需要先把 SHIM_KEY 搬过去、还要改 dwell 前端（手册叫「第 3 档」）。
// 这颗按钮是第 2 档：省掉选字，粘贴还是你自己按。
//
// ⚠️ 本文件**不改游戏本身的任何逻辑**，只包一层：
//    包住 window.aiRoll / window.playerRoll，掷完之后读一次 lastEvent。
//    游戏的算分、走格、存档全都原样跑。
(function () {
  'use strict';

  var W = window;

  // ── 取事件 ──────────────────────────────────────────────
  // 用 flightChessGetLastEvent()：它返回的是一份拷贝，不动游戏里的状态。
  // （README 说「每取一次 roundsLeft-1」，但源码里并没有减，以源码为准。）
  function lastEvent() {
    try {
      return typeof W.flightChessGetLastEvent === 'function'
        ? W.flightChessGetLastEvent() : null;
    } catch (e) { return null; }
  }

  // 小机停的那格 → 用游戏自带的那段注入词（README 里的 injectPrompt，原样不改）。
  function textForAiLanding(ev) {
    try {
      if (typeof W.flightChessBuildInjectPrompt === 'function') {
        var t = W.flightChessBuildInjectPrompt(ev);
        if (t) return t;
      }
    } catch (e) {}
    return fallbackText(ev, 'ai');
  }

  // 你停的那格 → 游戏自带那段的措辞是写给「小机停下」用的（开头写死「小机停在第 N 格」），
  // 套到你身上会自相矛盾。所以这里另写一句，**只复述事件里已有的字段，不新编规则**。
  function textForPlayerLanding(ev) { return fallbackText(ev, 'player'); }

  function fallbackText(ev, who) {
    if (!ev) return '';
    var mine = who === 'player';
    var recv = ev.receiver === 'player' ? '我' : '你';
    return [
      '【飞行棋】' + (mine ? '我' : '你') + '停在第 ' + ev.pos + ' 格。',
      '本格由' + recv + '接受。',
      '格子内容：' + ev.text
    ].join('\n');
  }

  // ── 复制 ────────────────────────────────────────────────
  // 三条路依次试：Clipboard API → execCommand → 都不行就让她自己长按选。
  function copyText(str, done) {
    var ok = function () { done(true); };
    var no = function () { done(false); };
    try {
      if (navigator.clipboard && W.isSecureContext) {
        navigator.clipboard.writeText(str).then(ok, function () { legacy(); });
        return;
      }
    } catch (e) {}
    legacy();
    function legacy() {
      try {
        var ta = document.createElement('textarea');
        ta.value = str;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;';
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, str.length);   // iOS 要这一句，select() 单独不够
        var good = document.execCommand('copy');
        document.body.removeChild(ta);
        good ? ok() : no();
      } catch (e) { no(); }
    }
  }

  // ── 面板 ────────────────────────────────────────────────
  var panel, pre, tip, btnCopy;

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'yanCopyPanel';
    panel.style.cssText = [
      'position:fixed', 'left:0', 'right:0', 'bottom:0', 'z-index:99999',
      'background:#1b1b1a', 'color:#ebebe4', 'display:none',
      'padding:14px 14px calc(14px + env(safe-area-inset-bottom))',
      'box-shadow:0 -8px 28px rgba(0,0,0,.38)',
      'border-radius:16px 16px 0 0',
      'font-family:system-ui,-apple-system,"PingFang SC",sans-serif'
    ].join(';');

    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px';
    var h = document.createElement('strong');
    h.textContent = '这段发给晏';
    h.style.cssText = 'font-size:14px;flex:1';
    var x = document.createElement('button');
    x.type = 'button';
    x.textContent = '×';
    x.setAttribute('aria-label', '关闭');
    x.style.cssText = 'border:0;background:transparent;color:#9c9a92;font-size:22px;line-height:1;padding:0 4px';
    x.onclick = hide;
    head.appendChild(h); head.appendChild(x);

    // 用 <pre> + textContent：格子内容原样显示，绝不当 HTML 解析
    pre = document.createElement('pre');
    pre.style.cssText = [
      'margin:0 0 10px', 'max-height:34vh', 'overflow:auto',
      'white-space:pre-wrap', 'word-break:break-word',
      'font-size:13px', 'line-height:1.5',
      'background:#131312', 'border:1px solid #3d3d3a', 'border-radius:10px',
      'padding:10px', 'font-family:inherit',
      '-webkit-user-select:text', 'user-select:text'
    ].join(';');

    btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.textContent = '复制';
    btnCopy.style.cssText = [
      'width:100%', 'padding:13px', 'border:0', 'border-radius:10px',
      'background:#e1734f', 'color:#fff', 'font-weight:600', 'font-size:15px'
    ].join(';');
    btnCopy.onclick = doCopy;

    tip = document.createElement('p');
    tip.style.cssText = 'margin:8px 0 0;font-size:12px;line-height:1.5;color:#9c9a92;text-align:center;min-height:17px';

    panel.appendChild(head);
    panel.appendChild(pre);
    panel.appendChild(btnCopy);
    panel.appendChild(tip);
    document.body.appendChild(panel);
    return panel;
  }

  var hideTimer = null;

  function doCopy() {
    var str = pre.textContent || '';
    if (!str) return;
    copyText(str, function (good) {
      tip.textContent = good
        ? '已复制 —— 切到 Telegram 粘贴给他就行'
        : '这个浏览器不让自动复制：长按上面那段自己选中复制';
      tip.style.color = good ? '#7aa06a' : '#c0392b';
      // 面板是从底下升上来的，会压住「我投掷 / 到你了」两颗按钮。
      // 复制成功 = 这一步办完了，稍等一下自己收起，好让她接着掷。
      // 失败时**不收**——那种情况她还要长按选字。
      // 想再复制一次：右下角那颗「发给晏」随时能把它叫回来。
      if (good) {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(hide, 1500);
      }
    });
  }

  function show(str) {
    if (!str) return;
    ensurePanel();
    clearTimeout(hideTimer);
    pre.textContent = str;
    tip.textContent = '';
    panel.style.display = 'block';
  }
  function hide() { clearTimeout(hideTimer); if (panel) panel.style.display = 'none'; }

  // ── 挂到掷骰上 ──────────────────────────────────────────
  // 只包一层：先让游戏自己跑完，再看它记下的 lastEvent。
  // 起点格（游戏自己也不弹事件）和已经结束的局跳过。
  function wrap(name, build) {
    var orig = W[name];
    if (typeof orig !== 'function') return false;
    W[name] = function () {
      var before = lastEvent();
      var ret = orig.apply(this, arguments);
      try {
        var ev = lastEvent();
        if (ev && ev.text && !(before && before.pos === ev.pos && before.lander === ev.lander)) {
          show(build(ev));
        }
      } catch (e) { /* 复制面板出问题绝不能拖累游戏 */ }
      return ret;
    };
    return true;
  }

  function boot() {
    var a = wrap('aiRoll', textForAiLanding);
    var p = wrap('playerRoll', textForPlayerLanding);
    if (!a && !p) {
      console.warn('[copy-to-yan] 没找到 aiRoll / playerRoll，按钮不会出现');
      return;
    }
    // 补一颗常驻的小按钮：想把上一格再复制一次时用
    var again = document.createElement('button');
    again.type = 'button';
    again.textContent = '发给晏';
    again.style.cssText = [
      'position:fixed', 'right:10px', 'bottom:calc(10px + env(safe-area-inset-bottom))',
      'z-index:99998', 'border:0', 'border-radius:999px', 'padding:8px 14px',
      'background:#e1734f', 'color:#fff', 'font-size:12px', 'font-weight:600',
      'box-shadow:0 2px 10px rgba(0,0,0,.3)',
      'font-family:system-ui,-apple-system,"PingFang SC",sans-serif'
    ].join(';');
    again.onclick = function () {
      var ev = lastEvent();
      if (!ev || !ev.text) { return; }
      show(ev.lander === 'ai' ? textForAiLanding(ev) : textForPlayerLanding(ev));
    };
    document.body.appendChild(again);
    W.__yanCopyReady = true;
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else { boot(); }
})();
