/*!
 * lucky-wheel.20261025_001.js — 幸運轉盤元件（元氣早午餐）
 * 顏色跟著 daily-theme.js 的每日主題（--day-theme-*），沒載入主題時用原本的橘色。
 *
 * 設計重點
 * - 結果一律由伺服器決定。畫面只負責「演出」：按下送出就開始轉，
 *   伺服器建單回應後呼叫 stopAt(格子) 減速停在那一格。
 * - 無相依套件、ES5 語法、SVG 繪製；不用 aspect-ratio / gap / inset / conic-gradient，
 *   舊版 Android WebView（Chrome 49+）也能正常顯示。
 * - 轉盤內不放 emoji（舊平板 emoji 字型會缺字）。
 *
 * 基本用法
 *   var wheel = LuckyWheel.create({
 *     title: '幸運轉盤',
 *     segments: [ { label: '95折', sub: '省 5%' }, { label: '9折', sub: '省 10%' }, ... ]
 *   });
 *   wheel.open();                                   // 在按鈕 click 當下呼叫（音效需要使用者手勢）
 *   submitOrder().then(function (res) {
 *     if (!res.luckyWheel) {
 *       return wheel.abort({ title: '本次未參加轉盤', text: '訂單已送出，以原價計算。' });
 *     }
 *     return wheel.stopAt(res.luckyWheel.segmentIndex).then(function () {
 *       return wheel.showResult({ badge: '9 折', title: '恭喜！本單享 9 折', rows: [...], primary: '完成' });
 *     });
 *   }).then(function () { return wheel.close(); });
 *
 * API
 *   LuckyWheel.create(options) → wheel
 *     options.segments   [{ label, sub?, color?, textColor?, size? }]  size 為相對弧度，預設 1（等分）
 *     options.title      標題文字
 *     options.status     轉動中的說明文字
 *     options.hubText    中心文字（預設「元氣」）
 *     options.sound      是否播放音效（預設 true，可被使用者在面板上關閉）
 *     options.speed      巡航轉速，度/毫秒（預設 0.84 ≈ 每秒 2.3 圈）
 *     options.minSpinMs  最短轉動時間，避免伺服器太快時演出太短（預設 1300）
 *     options.stopMs     減速段的參考時間（預設 2600，實際 2.6–3.9 秒）
 *   wheel.open()                 顯示並開始轉
 *   wheel.stopAt(index) → Promise   停在第 index 格（格內位置隨機，不會停在線上）
 *   wheel.abort(msg)    → Promise   沒有獎項時：慢慢停下並顯示訊息，按鈕按下後 resolve
 *   wheel.showResult(r) → Promise   顯示結果面板，resolve('primary' | 'secondary')
 *   wheel.skip()                 跳過減速，直接停到結果
 *   wheel.close()       → Promise   淡出並移除
 *   LuckyWheel.notice(o) → Promise   一般提示視窗（例：還差 $XX 就可參加），resolve primary|secondary|cancel
 */
(function (root) {
  'use strict';

  var VERSION = '20261025';
  var STYLE_ID = 'lw-style-' + VERSION;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  var DEFAULT_COLORS = [
    { fill: '#FFEDD5', text: '#9A3412' },
    { fill: '#F97316', text: '#FFFFFF' },
    { fill: '#FED7AA', text: '#7C2D12' },
    { fill: '#EA580C', text: '#FFFFFF' }
  ];

  var CSS = [
    '.lw-overlay{position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;display:-webkit-box;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;-webkit-justify-content:center;justify-content:center;',
    'background:rgba(28,16,6,.64);opacity:0;-webkit-transition:opacity .22s ease;transition:opacity .22s ease;-webkit-tap-highlight-color:transparent;',
    'font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif;padding:16px;',
    'padding-top:calc(16px + env(safe-area-inset-top, 0px));padding-bottom:calc(16px + env(safe-area-inset-bottom, 0px));box-sizing:border-box;}',
    '.lw-overlay.lw-in{opacity:1}',
    // 捲軸一律隱藏：轉盤會依視窗高度縮放，正常不會超出；極小視窗仍可用手指捲動
    '.lw-dialog{position:relative;width:100%;max-width:360px;max-height:100%;overflow-x:hidden;overflow-y:auto;-webkit-overflow-scrolling:touch;',
    'scrollbar-width:none;-ms-overflow-style:none;background:#FFFBF5;color:#431407;border-radius:24px;',
    'padding:22px 18px 18px;box-sizing:border-box;text-align:center;box-shadow:0 24px 60px rgba(0,0,0,.35);',
    '-webkit-transform:translateY(14px) scale(.97);transform:translateY(14px) scale(.97);',
    '-webkit-transition:-webkit-transform .3s cubic-bezier(.2,.9,.3,1.15);transition:transform .3s cubic-bezier(.2,.9,.3,1.15)}',
    '.lw-in .lw-dialog{-webkit-transform:none;transform:none}',
    '.lw-dialog::-webkit-scrollbar{display:none;width:0;height:0}',
    '.lw-title{margin:0;font-size:20px;line-height:1.3;font-weight:900;color:#7C2D12;color:var(--day-theme-t700,#7C2D12);letter-spacing:.06em}',
    '.lw-status{margin:4px 0 0;font-size:13px;line-height:1.5;color:#9A6B4F;min-height:20px}',
    '.lw-stage{position:relative;margin:16px auto 0;-webkit-transition:width .3s ease,height .3s ease;transition:width .3s ease,height .3s ease}',
    // 旋轉中的方形會把外框撐大而跑出捲軸，用圓形裁切把它關在轉盤範圍內
    '.lw-clip{position:absolute;top:0;left:0;width:100%;height:100%;overflow:hidden;border-radius:50%;-webkit-mask-image:-webkit-radial-gradient(white,black)}',
    '.lw-rotor{position:absolute;top:0;left:0;width:100%;height:100%;will-change:transform;-webkit-transform:rotate(0deg);transform:rotate(0deg)}',
    '.lw-rotor svg,.lw-pointer svg{display:block;width:100%;height:100%;overflow:visible}',
    '.lw-pointer{position:absolute;left:50%;top:-8px;width:36px;height:46px;margin-left:-18px;z-index:3;-webkit-transform-origin:50% 28%;transform-origin:50% 28%}',
    '.lw-hub{position:absolute;left:50%;top:50%;width:24%;height:24%;margin:-12% 0 0 -12%;border-radius:50%;background:#7C2D12;background:var(--day-theme-t700,#7C2D12);color:#FFF7ED;',
    'display:-webkit-box;display:-webkit-flex;display:flex;-webkit-align-items:center;align-items:center;-webkit-justify-content:center;justify-content:center;',
    'font-weight:900;font-size:15px;letter-spacing:.08em;box-shadow:0 0 0 4px #FFFBF5,0 4px 12px rgba(0,0,0,.28);z-index:2}',
    '.lw-bulb{fill:#FFE9A8}',
    '.lw-spinning .lw-bulb-a{-webkit-animation:lw-blink .44s steps(1,end) infinite;animation:lw-blink .44s steps(1,end) infinite}',
    '.lw-spinning .lw-bulb-b{-webkit-animation:lw-blink .44s steps(1,end) .22s infinite;animation:lw-blink .44s steps(1,end) .22s infinite}',
    '@-webkit-keyframes lw-blink{0%{fill:#FFF8D6}50%{fill:#B45309}}@keyframes lw-blink{0%{fill:#FFF8D6}50%{fill:#B45309}}',
    '.lw-glow{fill:#FFFFFF;opacity:0}',
    '.lw-glow.lw-on{-webkit-animation:lw-glow .55s ease-in-out 3;animation:lw-glow .55s ease-in-out 3}',
    '@-webkit-keyframes lw-glow{0%,100%{opacity:0}50%{opacity:.5}}@keyframes lw-glow{0%,100%{opacity:0}50%{opacity:.5}}',
    '.lw-foot{margin-top:14px;min-height:24px}',
    '.lw-wait{font-size:13px;color:#9A6B4F}',
    '.lw-badge{display:inline-block;font-size:38px;line-height:1.1;font-weight:900;color:#C2410C;color:var(--day-theme-t600,#C2410C);letter-spacing:.04em}',
    '.lw-rtitle{margin:4px 0 0;font-size:16px;line-height:1.5;font-weight:700;color:#431407}',
    '.lw-rtext{margin:6px 0 0;font-size:14px;line-height:1.6;color:#6B4A36}',
    '.lw-rows{margin:12px 0 0;padding:10px 14px;background:#FFF1E0;background:var(--day-theme-50,#FFF1E0);border-radius:14px;text-align:left;font-size:14px}',
    '.lw-row{display:-webkit-box;display:-webkit-flex;display:flex;-webkit-justify-content:space-between;justify-content:space-between;padding:3px 0;color:#6B4A36}',
    '.lw-row b{font-weight:700;font-variant-numeric:tabular-nums}',
    '.lw-row.lw-minus b{color:#C2410C;color:var(--day-theme-t600,#C2410C)}',
    '.lw-row.lw-total{border-top:1px dashed #E7B98F;border-top-color:var(--day-theme-300,#E7B98F);margin-top:5px;padding-top:8px;color:#431407;font-weight:900;font-size:17px}',
    '.lw-row.lw-total b{font-weight:900}',
    '.lw-btns{margin-top:14px}',
    '.lw-btn{display:block;width:100%;border:0;border-radius:16px;padding:13px 10px;font-size:16px;font-weight:900;color:#FFFFFF;background:#F97316;',
    'cursor:pointer;box-shadow:0 6px 16px rgba(249,115,22,.3);box-shadow:0 6px 16px rgba(var(--day-theme-rgb,249,115,22),.3);font-family:inherit;-webkit-appearance:none}',
    '.lw-btn.lw-theme{background-color:var(--day-theme,#F97316);background-image:var(--day-theme-bg,none);color:var(--day-theme-on,#FFFFFF)}',
    '.lw-btn.lw-linepay{background:#06C755;background-image:none;color:#FFFFFF;box-shadow:0 6px 16px rgba(6,199,85,.3)}',
    '.lw-btn.lw-ghost{background:transparent;color:#9A6B4F;box-shadow:none;font-weight:700;font-size:14px;padding:10px}',
    '.lw-btn + .lw-btn{margin-top:8px}',
    '.lw-btn:focus{outline:3px solid #FDBA74;outline-offset:2px}',
    '.lw-corner{position:absolute;top:8px;border:0;background:transparent;color:#9A6B4F;font-size:12px;padding:8px 10px;cursor:pointer;font-family:inherit;z-index:4}',
    '.lw-sound{left:6px}',
    '.lw-skip{right:6px}',
    '.lw-corner:focus{outline:2px solid #FDBA74}',
    '.lw-confetti{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;border-radius:24px;z-index:5}',
    '.lw-confetti i{position:absolute;top:0;left:0;display:block;width:7px;height:12px;border-radius:2px}',
    '.lw-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    '.lw-notice .lw-dialog{padding-top:26px}',
    '.lw-mini{display:block;width:64px;height:64px;margin:0 auto 10px}',
    '.lw-hl{display:inline-block;margin:10px 0 0;padding:8px 16px;border-radius:999px;background:#FFEDD5;background:var(--day-theme-100,#FFEDD5);color:#C2410C;color:var(--day-theme-t600,#C2410C);font-weight:900;font-size:22px;letter-spacing:.02em}',
    '.lw-rim{fill:#7C2D12;fill:var(--day-theme-t700,#7C2D12)}'
  ].join('');

  function nowMs() {
    return (root.performance && root.performance.now) ? root.performance.now() : Date.now();
  }
  var raf = root.requestAnimationFrame || root.webkitRequestAnimationFrame ||
    function (cb) { return setTimeout(function () { cb(nowMs()); }, 16); };
  var caf = root.cancelAnimationFrame || root.webkitCancelAnimationFrame || clearTimeout;

  function mod(x, m) { return ((x % m) + m) % m; }

  function prefersReducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.appendChild(document.createTextNode(CSS));
    (document.head || document.documentElement).appendChild(s);
  }

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function s(tag, attrs) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    return e;
  }

  function setTransform(el, value) {
    el.style.webkitTransform = value;
    el.style.transform = value;
  }

  // 角度 0 在正上方、順時針增加
  function polar(r, deg) {
    var rad = (deg - 90) * Math.PI / 180;
    return { x: r * Math.cos(rad), y: r * Math.sin(rad) };
  }

  function sectorPath(r, a0, a1) {
    if (a1 - a0 >= 359.999) {
      return 'M0 ' + (-r) + ' A' + r + ' ' + r + ' 0 1 1 0 ' + r + ' A' + r + ' ' + r + ' 0 1 1 0 ' + (-r) + 'Z';
    }
    var p0 = polar(r, a0), p1 = polar(r, a1);
    var large = (a1 - a0) > 180 ? 1 : 0;
    return 'M0 0 L' + p0.x.toFixed(3) + ' ' + p0.y.toFixed(3) +
      ' A' + r + ' ' + r + ' 0 ' + large + ' 1 ' + p1.x.toFixed(3) + ' ' + p1.y.toFixed(3) + 'Z';
  }

  function storageGet(key) { try { return root.localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, v) { try { root.localStorage.setItem(key, v); } catch (e) {} }

  // ---------- 音效（Web Audio，失敗就安靜） ----------
  function Sound(enabled) {
    this.on = enabled;
    this.ctx = null;
    this.lastTick = 0;
  }
  Sound.prototype.unlock = function () {
    if (!this.on) return;
    try {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return;
      if (!this.ctx) this.ctx = new AC();
      if (this.ctx.state === 'suspended' && this.ctx.resume) this.ctx.resume();
    } catch (e) { this.ctx = null; }
  };
  Sound.prototype.blip = function (freq, vol, dur, type, delay) {
    if (!this.on || !this.ctx) return;
    try {
      var ctx = this.ctx, t = ctx.currentTime + (delay || 0);
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'triangle';
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.03);
    } catch (e) {}
  };
  Sound.prototype.tick = function () {
    var t = nowMs();
    if (t - this.lastTick < 45) return;
    this.lastTick = t;
    this.blip(1900, 0.035, 0.035, 'triangle');
  };
  Sound.prototype.win = function () {
    var notes = [784, 988, 1175, 1568];
    for (var i = 0; i < notes.length; i++) this.blip(notes[i], 0.07, 0.22, 'triangle', i * 0.09);
  };
  Sound.prototype.soft = function () { this.blip(523, 0.05, 0.25, 'sine'); };
  Sound.prototype.close = function () {
    try { if (this.ctx && this.ctx.close) this.ctx.close(); } catch (e) {}
    this.ctx = null;
  };

  // ---------- 轉盤 ----------
  function LuckyWheel(options) {
    var o = options || {};
    this.opts = {
      title: o.title || '幸運轉盤',
      status: o.status || '訂單送出中，轉出你的折扣…',
      hubText: o.hubText === undefined ? '元氣' : o.hubText,
      speed: o.speed > 0 ? o.speed : 0.84,
      accelMs: o.accelMs > 0 ? o.accelMs : 650,
      minSpinMs: o.minSpinMs >= 0 ? o.minSpinMs : 1300,
      stopMs: o.stopMs > 0 ? o.stopMs : 2600
    };
    var saved = storageGet('lw_sound');
    this.sound = new Sound(saved === null ? o.sound !== false : saved === '1');
    this.reduce = prefersReducedMotion();
    this.segments = this._layout(o.segments || []);
    this.angle = 0;
    this.speed = 0;
    this.phase = 'idle';
    this._raf = null;
    this._pending = null;
    this._decel = null;
    this._lastSeg = -1;
    this._lastTickAt = -1000;
    this._resultResolve = null;
    this._onResize = null;
  }

  LuckyWheel.prototype._layout = function (list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += (list[i].size > 0 ? list[i].size : 1);
    var out = [], a = 0;
    for (i = 0; i < list.length; i++) {
      var seg = list[i];
      var span = 360 * (seg.size > 0 ? seg.size : 1) / (total || 1);
      var pal = DEFAULT_COLORS[i % DEFAULT_COLORS.length];
      out.push({
        label: String(seg.label === undefined ? '' : seg.label),
        sub: seg.sub ? String(seg.sub) : '',
        fill: seg.color || pal.fill,
        text: seg.textColor || pal.text,
        start: a,
        end: a + span,
        center: a + span / 2
      });
      a += span;
    }
    return out;
  };

  LuckyWheel.prototype._buildSvg = function () {
    var R = 98;
    var svg = s('svg', { viewBox: '-112 -112 224 224', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(s('circle', { cx: 0, cy: 0, r: 111, 'class': 'lw-rim' }));
    svg.appendChild(s('circle', { cx: 0, cy: 0, r: 101, fill: '#FCD34D' }));
    var segs = this.segments;
    var glows = [];
    for (var i = 0; i < segs.length; i++) {
      var sg = segs[i];
      svg.appendChild(s('path', { d: sectorPath(R, sg.start, sg.end), style: 'fill:' + sg.fill }));
    }
    for (i = 0; i < segs.length && segs.length > 1; i++) {
      var p = polar(R, segs[i].start);
      svg.appendChild(s('line', { x1: 0, y1: 0, x2: p.x.toFixed(3), y2: p.y.toFixed(3), stroke: '#FFFBF5', 'stroke-width': 1.6, 'stroke-opacity': 0.85 }));
    }
    for (i = 0; i < segs.length; i++) {
      sg = segs[i];
      var span = sg.end - sg.start;
      var g = s('g', { transform: 'rotate(' + sg.center.toFixed(3) + ')' });
      var len = sg.label.length;
      var big = len <= 2 ? 19 : len === 3 ? 17 : len === 4 ? 14 : 12;
      if (span < 34) big = Math.min(big, 13);
      var t1 = s('text', {
        x: 0, y: -66, 'text-anchor': 'middle', style: 'fill:' + sg.text,
        'font-size': big, 'font-weight': 900,
        'font-family': '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif'
      });
      t1.textContent = sg.label;
      g.appendChild(t1);
      if (sg.sub && span >= 30) {
        var t2 = s('text', {
          x: 0, y: -50, 'text-anchor': 'middle', style: 'fill:' + sg.text, 'fill-opacity': 0.85,
          'font-size': 8.5, 'font-weight': 700,
          'font-family': '"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif'
        });
        t2.textContent = sg.sub;
        g.appendChild(t2);
      }
      svg.appendChild(g);
      var glow = s('path', { d: sectorPath(R, sg.start, sg.end), 'class': 'lw-glow' });
      svg.appendChild(glow);
      glows.push(glow);
    }
    var bulbs = Math.max(16, Math.min(28, segs.length * 2));
    for (i = 0; i < bulbs; i++) {
      var b = polar(106, i * 360 / bulbs);
      svg.appendChild(s('circle', { cx: b.x.toFixed(3), cy: b.y.toFixed(3), r: 2.9, 'class': 'lw-bulb ' + (i % 2 ? 'lw-bulb-b' : 'lw-bulb-a') }));
    }
    this._glows = glows;
    return svg;
  };

  LuckyWheel.prototype._buildPointer = function () {
    var svg = s('svg', { viewBox: '0 0 36 46', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(s('path', { d: 'M18 44 L5.5 17 A13.5 13.5 0 1 1 30.5 17 Z', fill: '#DC2626', stroke: '#FFFBF5', 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
    svg.appendChild(s('circle', { cx: 18, cy: 13, r: 4.2, fill: '#FFFBF5' }));
    return svg;
  };

  // 依視窗剩餘高度決定轉盤大小：標題、結果面板放得下，整個視窗就不需要捲動
  LuckyWheel.prototype._size = function () {
    var vw = root.innerWidth || 360;
    var ov = this.overlay, dlg = this.dialog;
    var availH = root.innerHeight || 640;
    try {
      var cs = root.getComputedStyle(ov);
      availH = ov.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
    } catch (e) {}
    var current = this.stage.offsetHeight || 0;
    var others = dlg.scrollHeight - current;
    var size = Math.min(320, vw - 32 - 36 - 8, availH - others - 2);
    size = Math.max(140, Math.floor(size));
    this.stage.style.width = size + 'px';
    this.stage.style.height = size + 'px';
    this.hub.style.fontSize = Math.max(11, Math.round(size * 0.05)) + 'px';
  };

  LuckyWheel.prototype.open = function () {
    if (this.phase !== 'idle') return this;
    injectCss();
    var self = this;
    this.sound.unlock();

    var overlay = h('div', 'lw-overlay');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    var dialog = h('div', 'lw-dialog lw-spinning');
    var titleId = 'lw-title-' + Math.floor(Math.random() * 1e9);
    var title = h('h2', 'lw-title', this.opts.title);
    title.id = titleId;
    overlay.setAttribute('aria-labelledby', titleId);
    var status = h('p', 'lw-status', this.opts.status);
    status.setAttribute('aria-live', 'polite');

    var stage = h('div', 'lw-stage');
    var clip = h('div', 'lw-clip');
    var rotor = h('div', 'lw-rotor');
    rotor.appendChild(this._buildSvg());
    clip.appendChild(rotor);
    var pointer = h('div', 'lw-pointer');
    pointer.appendChild(this._buildPointer());
    var hub = h('div', 'lw-hub', this.opts.hubText);
    stage.appendChild(clip);
    stage.appendChild(pointer);
    stage.appendChild(hub);

    var foot = h('div', 'lw-foot');
    var soundBtn = h('button', 'lw-corner lw-sound', this.sound.on ? '音效 開' : '音效 關');
    soundBtn.type = 'button';
    soundBtn.setAttribute('aria-pressed', this.sound.on ? 'true' : 'false');
    soundBtn.onclick = function () {
      self.sound.on = !self.sound.on;
      storageSet('lw_sound', self.sound.on ? '1' : '0');
      if (self.sound.on) self.sound.unlock();
      soundBtn.textContent = self.sound.on ? '音效 開' : '音效 關';
      soundBtn.setAttribute('aria-pressed', self.sound.on ? 'true' : 'false');
    };
    var skipBtn = h('button', 'lw-corner lw-skip', '直接看結果');
    skipBtn.type = 'button';
    skipBtn.style.visibility = 'hidden';
    skipBtn.onclick = function () { self.skip(); };

    dialog.appendChild(soundBtn);
    dialog.appendChild(skipBtn);
    dialog.appendChild(title);
    dialog.appendChild(status);
    dialog.appendChild(stage);
    dialog.appendChild(foot);
    overlay.appendChild(dialog);

    this.overlay = overlay; this.dialog = dialog; this.statusEl = status;
    this.stage = stage; this.rotor = rotor; this.pointer = pointer; this.hub = hub;
    this.foot = foot; this.skipBtn = skipBtn;

    this._onResize = function () { self._size(); };
    root.addEventListener('resize', this._onResize);

    this._prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    this.stage.style.width = '320px';
    this.stage.style.height = '320px';
    this._size();
    // 下一個 frame 再加 class，才會有淡入
    raf(function () { overlay.className += ' lw-in'; });

    this.openedAt = nowMs();
    this.phase = 'accel';
    this.speed = 0;
    this._last = this.openedAt;
    this._loop();
    return this;
  };

  LuckyWheel.prototype._loop = function () {
    var self = this;
    if (this._raf !== null) return;
    var step = function () {
      self._raf = null;
      var t = nowMs();
      var dt = Math.min(64, Math.max(0, t - self._last));
      self._last = t;
      var o = self.opts;

      if (self.phase === 'accel') {
        var u = Math.min(1, (t - self.openedAt) / o.accelMs);
        self.speed = o.speed * u * u;
        self.angle += self.speed * dt;
        if (u >= 1) self.phase = 'cruise';
      } else if (self.phase === 'cruise') {
        self.speed = o.speed;
        self.angle += self.speed * dt;
      } else if (self.phase === 'decel') {
        var d = self._decel;
        var k = Math.min(1, (t - d.start) / d.T);
        var e = 1 - Math.pow(1 - k, 3);
        var prev = self.angle;
        self.angle = d.a0 + d.D * e;
        self.speed = dt > 0 ? (self.angle - prev) / dt : 0;
        if (k >= 1) {
          self.angle = d.a0 + d.D;
          self._render(t);
          self._land();
          return;
        }
      }

      if (self._pending && self.phase === 'cruise' && (self.reduce || t - self.openedAt >= o.minSpinMs)) {
        self._beginDecel(self._pending);
        self._pending = null;
      } else if (self._pending && self.reduce && self.phase === 'accel') {
        self._beginDecel(self._pending);
        self._pending = null;
      }

      self._render(t);
      if (self.phase === 'accel' || self.phase === 'cruise' || self.phase === 'decel') {
        self._raf = raf(step);
      }
    };
    this._raf = raf(step);
  };

  LuckyWheel.prototype._segmentAtPointer = function () {
    var a = mod(-this.angle, 360);
    var segs = this.segments;
    for (var i = 0; i < segs.length; i++) if (a >= segs[i].start && a < segs[i].end) return i;
    return segs.length - 1;
  };

  LuckyWheel.prototype._render = function (t) {
    setTransform(this.rotor, 'rotate(' + this.angle.toFixed(2) + 'deg)');
    var seg = this._segmentAtPointer();
    if (seg !== this._lastSeg) {
      if (this._lastSeg !== -1) {
        this._lastTickAt = t;
        this.sound.tick();
      }
      this._lastSeg = seg;
    }
    // 指針被格線撥動：越快越常被撥，停下前一格一格「喀」
    var since = t - this._lastTickAt;
    var flick = this.reduce ? 0 : Math.max(0, 1 - since / 110) * 20;
    setTransform(this.pointer, 'rotate(' + (-flick).toFixed(1) + 'deg)');
  };

  LuckyWheel.prototype._beginDecel = function (p) {
    // 還在加速時就要停（只會發生在 abort 或減少動態模式），用巡航速度的六成起算，避免減速拖太久
    var w = Math.max(this.speed, this.opts.speed * 0.6);
    var target;
    if (p.index === null) {
      target = mod(this.angle + w * this.opts.stopMs * 0.25 + Math.random() * 360, 360);
    } else {
      var seg = this.segments[p.index];
      var half = (seg.end - seg.start) / 2;
      var jitter = (Math.random() * 2 - 1) * half * 0.55;
      target = mod(-(seg.center + jitter), 360);
    }
    var D, T;
    if (this.reduce) {
      D = mod(target - this.angle, 360);
      if (D < 60) D += 360;
      T = 700;
    } else {
      var Dmin = w * this.opts.stopMs / 3 * (p.index === null ? 0.5 : 1);
      D = Dmin + mod(target - (this.angle + Dmin), 360);
      T = 3 * D / w; // 三次 ease-out 的起始速度 = 3D/T，與目前轉速銜接，不會頓一下
    }
    this._decel = { a0: this.angle, D: D, T: T, start: nowMs(), index: p.index, resolve: p.resolve };
    this.phase = 'decel';
    if (p.index !== null) this.skipBtn.style.visibility = 'visible';
  };

  LuckyWheel.prototype._land = function () {
    var d = this._decel;
    this.phase = 'done';
    this.speed = 0;
    this.dialog.className = this.dialog.className.replace(' lw-spinning', '');
    setTransform(this.pointer, 'rotate(0deg)');
    this.skipBtn.style.visibility = 'hidden';
    if (d.index !== null) {
      if (this._glows[d.index]) this._glows[d.index].setAttribute('class', 'lw-glow lw-on');
      this.sound.win();
      try { if (root.navigator && root.navigator.vibrate) root.navigator.vibrate(35); } catch (e) {}
    } else {
      this.sound.soft();
    }
    var resolve = d.resolve;
    setTimeout(function () { resolve(); }, d.index !== null ? 380 : 150);
  };

  LuckyWheel.prototype.stopAt = function (index) {
    var self = this;
    var i = Math.floor(Number(index));
    if (!(i >= 0 && i < this.segments.length)) i = 0;
    return new Promise(function (resolve) {
      if (self.phase === 'idle') self.open();
      if (self.phase === 'decel' || self.phase === 'done') { resolve(); return; }
      self._pending = { index: i, resolve: resolve };
      self._loop();
    });
  };

  LuckyWheel.prototype.skip = function () {
    if (this.phase === 'decel' && this._decel && this._decel.index !== null) {
      this._decel.start = nowMs() - this._decel.T;
    }
  };

  LuckyWheel.prototype._panel = function (r) {
    var self = this;
    var wrap = h('div', 'lw-result');
    if (r.badge) wrap.appendChild(h('div', 'lw-badge', r.badge));
    if (r.title) wrap.appendChild(h('p', 'lw-rtitle', r.title));
    if (r.text) wrap.appendChild(h('p', 'lw-rtext', r.text));
    if (r.rows && r.rows.length) {
      var rows = h('div', 'lw-rows');
      for (var i = 0; i < r.rows.length; i++) {
        var row = r.rows[i];
        var line = h('div', 'lw-row' + (row.kind ? ' lw-' + row.kind : ''));
        line.appendChild(h('span', '', row.label));
        line.appendChild(h('b', '', row.value));
        rows.appendChild(line);
      }
      wrap.appendChild(rows);
    }
    var btns = h('div', 'lw-btns');
    var primary = h('button', 'lw-btn ' + (r.primaryStyle ? 'lw-' + r.primaryStyle : 'lw-theme'), r.primary || '完成');
    primary.type = 'button';
    btns.appendChild(primary);
    var secondary = null;
    if (r.secondary) {
      secondary = h('button', 'lw-btn lw-ghost', r.secondary);
      secondary.type = 'button';
      btns.appendChild(secondary);
    }
    wrap.appendChild(btns);
    this.foot.innerHTML = '';
    this.foot.appendChild(wrap);
    if (r.status !== undefined) {
      this.statusEl.textContent = r.status;
      this.statusEl.style.display = r.status ? '' : 'none';
    }
    this._size(); // 結果面板出現後，轉盤自動縮小到放得下
    try { primary.focus(); } catch (e) {}
    return new Promise(function (resolve) {
      var done = false;
      var finish = function (action) {
        if (done) return;
        done = true;
        primary.disabled = true;
        if (secondary) secondary.disabled = true;
        resolve(action);
      };
      primary.onclick = function () { finish('primary'); };
      if (secondary) secondary.onclick = function () { finish('secondary'); };
      if (r.autoContinueMs > 0) {
        var left = Math.ceil(r.autoContinueMs / 1000);
        var base = primary.textContent;
        primary.textContent = base + '（' + left + '）';
        var iv = setInterval(function () {
          left -= 1;
          if (done) { clearInterval(iv); return; }
          if (left <= 0) { clearInterval(iv); finish('primary'); return; }
          primary.textContent = base + '（' + left + '）';
        }, 1000);
      }
      self._resultResolve = finish;
    });
  };

  LuckyWheel.prototype.showResult = function (r) {
    r = r || {};
    if (r.confetti !== false && !this.reduce) this._confetti();
    if (r.status === undefined) r.status = '';
    return this._panel(r);
  };

  LuckyWheel.prototype.abort = function (msg) {
    var self = this;
    var r = typeof msg === 'string' ? { title: msg } : (msg || {});
    if (r.status === undefined) r.status = '';
    if (!r.primary) r.primary = '知道了';
    return new Promise(function (resolve) {
      if (self.phase === 'idle') { resolve('primary'); return; }
      var show = function () { self._panel(r).then(resolve); };
      if (self.phase === 'done') { show(); return; }
      if (self.phase === 'decel') { self._decel.index = null; }
      var waitStop = function () {
        if (self.phase === 'done') { show(); return; }
        setTimeout(waitStop, 60);
      };
      if (self.phase === 'accel' || self.phase === 'cruise') {
        self._pending = null;
        self._beginDecel({ index: null, resolve: function () {} });
        self._loop();
      }
      waitStop();
    });
  };

  LuckyWheel.prototype._confetti = function () {
    var box = h('div', 'lw-confetti');
    this.dialog.appendChild(box);
    var colors = ['#F97316', '#FACC15', '#DC2626', '#06C755', '#FDBA74', '#7C2D12'];
    var W = this.dialog.clientWidth || 320;
    var y0 = (this.stage.offsetTop || 80) + (this.stage.offsetHeight || 260) * 0.45;
    var parts = [];
    for (var i = 0; i < 38; i++) {
      var el = document.createElement('i');
      el.style.background = colors[i % colors.length];
      box.appendChild(el);
      var ang = (-90 + (Math.random() * 2 - 1) * 70) * Math.PI / 180;
      var v = 0.35 + Math.random() * 0.45;
      parts.push({ el: el, x: W / 2, y: y0, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, r: Math.random() * 360, vr: (Math.random() * 2 - 1) * 0.8 });
    }
    var start = nowMs(), last = start;
    var step = function () {
      var t = nowMs(), dt = Math.min(48, t - last);
      last = t;
      for (var j = 0; j < parts.length; j++) {
        var p = parts[j];
        p.vy += 0.0011 * dt;
        p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
        setTransform(p.el, 'translate(' + p.x.toFixed(1) + 'px,' + p.y.toFixed(1) + 'px) rotate(' + p.r.toFixed(0) + 'deg)');
        p.el.style.opacity = String(Math.max(0, 1 - (t - start) / 1700));
      }
      if (t - start < 1700) raf(step);
      else if (box.parentNode) box.parentNode.removeChild(box);
    };
    raf(step);
  };

  LuckyWheel.prototype.close = function () {
    var self = this;
    return new Promise(function (resolve) {
      if (self._raf !== null) { caf(self._raf); self._raf = null; }
      self.phase = 'closed';
      if (self._onResize) root.removeEventListener('resize', self._onResize);
      self.sound.close();
      var ov = self.overlay;
      if (!ov) { resolve(); return; }
      ov.className = ov.className.replace(' lw-in', '');
      setTimeout(function () {
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        document.documentElement.style.overflow = self._prevOverflow || '';
        resolve();
      }, 240);
    });
  };

  // ---------- 提示視窗（例：還差 $XX 就可參加） ----------
  function miniWheelSvg() {
    var svg = s('svg', { viewBox: '-34 -36 68 70', 'class': 'lw-mini', 'aria-hidden': 'true', focusable: 'false' });
    svg.appendChild(s('circle', { cx: 0, cy: 0, r: 31, 'class': 'lw-rim' }));
    var cols = ['#FACC15', 'var(--day-theme,#F97316)', 'var(--day-theme-50,#FFEDD5)', 'var(--day-theme-200,#FDBA74)', 'var(--day-theme,#F97316)', 'var(--day-theme-50,#FFEDD5)'];
    for (var i = 0; i < 6; i++) svg.appendChild(s('path', { d: sectorPath(27, i * 60, (i + 1) * 60), style: 'fill:' + cols[i] }));
    svg.appendChild(s('circle', { cx: 0, cy: 0, r: 8, 'class': 'lw-rim' }));
    svg.appendChild(s('path', { d: 'M0 -22 L-6 -34 L6 -34 Z', fill: '#DC2626', stroke: '#FFFBF5', 'stroke-width': 1.5, 'stroke-linejoin': 'round' }));
    return svg;
  }

  /**
   * LuckyWheel.notice({ title, highlight, text, primary, secondary, primaryStyle }) → Promise
   * resolve 'primary' | 'secondary' | 'cancel'（按 Esc 或點背景）
   */
  function notice(o) {
    o = o || {};
    injectCss();
    return new Promise(function (resolve) {
      var overlay = h('div', 'lw-overlay lw-notice');
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      var dialog = h('div', 'lw-dialog');
      dialog.appendChild(miniWheelSvg());
      var title = h('h2', 'lw-title', o.title || '');
      var tid = 'lw-n-' + Math.floor(Math.random() * 1e9);
      title.id = tid;
      overlay.setAttribute('aria-labelledby', tid);
      dialog.appendChild(title);
      if (o.highlight) dialog.appendChild(h('div', 'lw-hl', o.highlight));
      if (o.text) dialog.appendChild(h('p', 'lw-rtext', o.text));
      var btns = h('div', 'lw-btns');
      var primary = h('button', 'lw-btn ' + (o.primaryStyle ? 'lw-' + o.primaryStyle : 'lw-theme'), o.primary || '知道了');
      primary.type = 'button';
      btns.appendChild(primary);
      var secondary = null;
      if (o.secondary) {
        secondary = h('button', 'lw-btn lw-ghost', o.secondary);
        secondary.type = 'button';
        btns.appendChild(secondary);
      }
      dialog.appendChild(btns);
      overlay.appendChild(dialog);
      var prevOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = 'hidden';
      document.body.appendChild(overlay);
      raf(function () { overlay.className += ' lw-in'; });
      try { primary.focus(); } catch (e) {}
      var done = false;
      var finish = function (action) {
        if (done) return;
        done = true;
        overlay.className = overlay.className.replace(' lw-in', '');
        setTimeout(function () {
          if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
          document.documentElement.style.overflow = prevOverflow || '';
          resolve(action);
        }, 220);
      };
      primary.onclick = function () { finish('primary'); };
      if (secondary) secondary.onclick = function () { finish('secondary'); };
      overlay.addEventListener('keydown', function (e) { if (e.key === 'Escape' || e.keyCode === 27) finish('cancel'); });
      overlay.addEventListener('click', function (e) { if (e.target === overlay) finish('cancel'); });
    });
  }

  root.LuckyWheel = {
    version: VERSION,
    create: function (options) { return new LuckyWheel(options); },
    notice: notice
  };
})(window);
