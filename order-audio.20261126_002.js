/*
 * order-audio.20261126_002.js — admin／pos 共用「訂單錄音」小播放器（order-audio-20261126）
 * ------------------------------------------------------------
 * 錄音放在店裡的 Pi 5，透過 LINE Pay 服務（manage 設定的 linePayServerUrl）讀，要帶 POS／admin 的 Firebase 登入：
 *   ☎️ 電話點餐   GET /api/order-audio/phone/<YYYYMMDD_HHMMSS_電話>   （麵包台首頁播的同一個 wav）
 *   🎙️ 語音點餐   GET /api/order-audio/kiosk?date=&no=&t=&id=          （manage「📝 點餐紀錄」的同一份錄音）
 * 網頁是 https，不能直接播麵包台用的 http://10.0.1.9:1881/order/…（瀏覽器會擋），所以一定走 Pi 的 https。
 *
 * 用法：
 *   OrderAudio.configure({ getBase: () => 'https://…', getToken: () => Promise<idToken>, right: () => 12, zIndex: 90 })
 *   OrderAudio.requestFor(order, { isPhone, phoneId })  → 這張單有沒有錄音可以聽（沒有回 null）
 *   OrderAudio.play(req)   要在按鈕的 click 裡直接呼叫（iPad Safari 規定要「手按」才能出聲）；同一張再按一次＝暫停／繼續
 *   OrderAudio.onChange(fn) → fn({ key, state })；state：idle｜loading｜playing｜paused｜ended｜error
 *
 * iPad 的 Safari 不能用 <audio> 播語音點餐平板錄的 webm（Opus）→ 這裡先解碼成 wav 再播（電腦的 Chrome 也一樣轉，進度條、倍速比較準）。
 * 一次只播一筆；聽過的留在記憶體（最多 6 筆），再聽不用重抓。
 *
 * _002（同一天）：多一個「放在頁面裡」的播放器，給 manage「🎙️ 語音點餐 → 📝 點餐紀錄」用：
 *   var p = OrderAudio.inline(容器, { kind: 'kiosk' });  先顯示「載入錄音中…」
 *   p.setBlob(錄音)   頁面自己跟 Pi 抓好的錄音；準備好就顯示 ▶，不會自己出聲（店員按 ▶ 才播）
 *   p.loading() ／ p.fail('原因') ／ p.destroy()
 *   和浮動播放器同一套按鈕（↺5秒、拖進度條、倍速）、同一個倍速設定；webm 一樣先轉 wav（iPad 也能聽）。
 * admin／pos 用的 _001 沒有改。
 */
(function (global) {
    'use strict';

    var VERSION = 'order-audio-20261126';
    var PHONE_RE = /^(\d{8})_(\d{6})_([0-9A-Za-z+]{2,32})$/;
    var RATES = [1, 1.25, 1.5, 0.75];
    var CACHE_MAX = 6;
    var TIMEOUT_MS = 25000;

    var cfg = { getBase: null, getToken: null, right: null, bottom: null, zIndex: 90 };
    var el = null;            // <audio>
    var ui = null;            // 播放器的 DOM
    var cur = null;           // 目前這筆
    var state = 'idle';
    var listeners = [];
    var cache = [];           // [{ key, url }]
    var seq = 0;
    var unlocked = false;
    var seeking = false;
    var actx = null;
    var rateIdx = 0;
    try { rateIdx = Math.max(0, RATES.indexOf(Number(global.localStorage.getItem('order_audio_rate')))); } catch (_) { rateIdx = 0; }

    // ── 圖示（用 SVG：⏸ ▶ 這些符號在有些字型會變成小方塊）──
    var PATHS = {
        idle: '<path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16.5 12a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"/>',
        playing: '<path d="M6 5h4v14H6zM14 5h4v14h-4z"/>',
        paused: '<path d="M8 5v14l11-7z"/>',
        ended: '<path d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"/>',
        error: '<path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>'
    };
    var LABELS = { idle: '聽錄音', loading: '載入中', playing: '暫停', paused: '繼續聽', ended: '再聽', error: '再試' };
    function iconHtml(st) {
        if (st === 'loading') {
            return '<svg class="oa-ico oa-spin" data-oa-icon="loading" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="38 100"/></svg>';
        }
        if (!PATHS[st]) st = 'idle';
        return '<svg class="oa-ico" data-oa-icon="' + st + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + PATHS[st] + '</svg>';
    }
    function buttonHtml(st, withLabel) {   // admin／pos 卡片按鈕的內容（v-html；只有固定字串，沒有訂單資料）
        st = st || 'idle';
        return iconHtml(st) + (withLabel ? '<span>' + (LABELS[st] || LABELS.idle) + '</span>' : '');
    }

    // ── 這張單能不能聽 ──
    function str(v) { return v == null ? '' : String(v).trim(); }
    function pad(n, w) { n = String(n); while (n.length < w) n = '0' + n; return n; }
    function hm(d) { return pad(d.getHours(), 2) + ':' + pad(d.getMinutes(), 2); }
    function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1, 2) + '-' + pad(d.getDate(), 2); }
    function cleanPhoneId(v) {
        v = str(v);
        if (v.indexOf('/') >= 0) v = v.split('/').pop();
        v = v.replace(/_(?:繁體|分析結果|analysis_result)\.json$/i, '').replace(/\.(?:json|wav|txt)$/i, '');
        v = v.replace(/^(?:phone_ai|pos_local)_/i, '');
        return v;
    }
    function orderTs(order) {
        var ts = order && (order.timestamp || order.createdAt || order.created_at);
        if (typeof ts === 'string' && !/^\d+$/.test(ts)) ts = Date.parse(ts);
        ts = Number(ts) || 0;
        if (ts && ts < 1e12) ts *= 1000;   // 秒 → 毫秒
        return ts > 0 ? ts : 0;
    }
    function isVoiceKiosk(order) {
        var c = (order && order.customer && typeof order.customer === 'object') ? order.customer : {};
        return str(order && (order.tableType || order.table_type) || c.tableType).toLowerCase() === 'voice_kiosk';
    }
    function requestFor(order, h) {
        if (!order || typeof order !== 'object') return null;
        h = h || {};
        var no = Number(order.orderNo || order.order_no) || 0;
        var noText = no > 0 ? 'No.' + pad(no, 3) : '';
        var phoneLike = h.isPhone ? !!h.isPhone(order) : /^(?:phone_ai|pos_local)$/i.test(str(order.source));
        if (phoneLike) {
            var original = order._integrationOriginal || {};
            var sid = cleanPhoneId(h.phoneId ? h.phoneId(order) : (order.sourceOrderId || original.sourceOrderId || order.orderId || order.id));
            var m = PHONE_RE.exec(sid);
            if (!m || /^pos$/i.test(m[3])) return null;   // POS 自己建的電話單沒有錄音
            var phone = str(order.phone || (order.customer && order.customer.phone)) || m[3];
            return { kind: 'phone', key: 'phone:' + sid, sid: sid,
                title: '☎️ 電話訂單' + (noText ? ' ' + noText : ''),
                sub: phone + ' · ' + m[2].slice(0, 2) + ':' + m[2].slice(2, 4) };
        }
        if (isVoiceKiosk(order)) {
            var ts = orderTs(order);
            var day = ts ? ymd(new Date(ts)) : str(order.orderDateKey || order.pickupDate);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || (!no && !ts)) return null;
            var id = str(order.id);
            if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) id = '';
            var mode = str(order.type || order.pickupMode || order.pickup_mode).toLowerCase();
            var dine = (mode === 'dinein' || mode === '內用') ? '內用' : '外帶';
            return { kind: 'kiosk', key: 'kiosk:' + day + ':' + (no || '') + ':' + (id || ts), day: day, no: no, t: ts, id: id,
                title: '🎙️ 語音點餐' + (noText ? ' ' + noText : ''),
                sub: dine + (ts ? ' · ' + hm(new Date(ts)) : '') };
        }
        return null;
    }

    // ── 狀態 ──
    function setState(s, msg) {
        state = s;
        render(msg);
        var info = { key: cur ? cur.key : '', state: cur ? s : 'idle' };
        listeners.slice().forEach(function (fn) { try { fn(info); } catch (e) { console.warn('[order-audio]', e); } });
    }
    function onChange(fn) {
        if (typeof fn === 'function') listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
    }
    function status() { return { key: cur ? cur.key : '', state: cur ? state : 'idle' }; }

    // ── 播放器 ──
    var CSS = '.oa-bar{position:fixed;bottom:calc(12px + env(safe-area-inset-bottom,0px));width:min(440px,calc(100vw - 24px));box-sizing:border-box;' +
        'background:#0f172a;color:#f8fafc;border-radius:16px;box-shadow:0 12px 32px rgba(15,23,42,.45);padding:10px 12px 10px 14px;' +
        'font-family:inherit;border-left:6px solid var(--oa-accent,#06b6d4);-webkit-user-select:none;user-select:none}' +
        '.oa-bar[hidden]{display:none}' +
        '.oa-top{display:flex;align-items:center;gap:8px;min-width:0}' +
        '.oa-title{font-weight:900;font-size:14px;white-space:nowrap}' +
        '.oa-sub{font-size:12px;color:#94a3b8;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}' +
        '.oa-x{flex-shrink:0;width:32px;height:32px;border-radius:999px;border:0;background:rgba(255,255,255,.08);color:#cbd5e1;font-size:15px;cursor:pointer}' +
        '.oa-row{display:flex;align-items:center;gap:8px;margin-top:6px}' +
        '.oa-btn{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;height:40px;min-width:40px;border-radius:999px;border:0;background:rgba(255,255,255,.1);color:#f8fafc;font-weight:800;font-size:13px;cursor:pointer;padding:0 8px}' +
        '.oa-play{width:48px;height:48px;font-size:20px;background:var(--oa-accent,#06b6d4);color:#fff}' +
        '.oa-btn:active,.oa-x:active{transform:scale(.94)}' +
        '.oa-btn:disabled{opacity:.45;cursor:default}' +
        '.oa-seek{flex:1;min-width:60px;height:28px;accent-color:var(--oa-accent,#06b6d4);cursor:pointer}' +
        '.oa-time{flex-shrink:0;font-size:12px;font-variant-numeric:tabular-nums;color:#cbd5e1;min-width:74px;text-align:right}' +
        '.oa-msg{font-size:12px;margin-top:4px;color:#fbbf24}' +
        '.oa-msg:empty{display:none}' +
        '.oa-kind-kiosk{--oa-accent:#10b981}' +
        '.oa-kind-phone{--oa-accent:#06b6d4}' +
        // 卡片上的「🔊 聽錄音」按鈕（admin、pos 的 tailwind 是事先編好的，新顏色放這裡）
        '.oa-card-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;border:2px solid;border-radius:999px;font-weight:800;' +
        'line-height:1;cursor:pointer;white-space:nowrap;flex-shrink:0;transition:transform .08s,box-shadow .15s,background-color .15s;-webkit-tap-highlight-color:transparent}' +
        '.oa-card-btn:active{transform:scale(.93)}' +
        '.oa-card-btn.oa-phone{background:#ecfeff;color:#0e7490;border-color:#67e8f9}' +
        '.oa-card-btn.oa-phone:hover{background:#cffafe}' +
        '.oa-card-btn.oa-kiosk{background:#ecfdf5;color:#047857;border-color:#6ee7b7}' +
        '.oa-card-btn.oa-kiosk:hover{background:#d1fae5}' +
        '.oa-card-btn.oa-on{animation:oa-pulse 1.4s ease-out infinite}' +
        '.oa-card-btn.oa-phone.oa-on{--oa-ring:6,182,212}' +
        '.oa-card-btn.oa-kiosk.oa-on{--oa-ring:16,185,129}' +
        '@keyframes oa-pulse{0%{box-shadow:0 0 0 0 rgba(var(--oa-ring),.55)}100%{box-shadow:0 0 0 8px rgba(var(--oa-ring),0)}}' +
        '.oa-card-btn.oa-pill{padding:8px 14px;font-size:14px}' +
        '.oa-card-btn.oa-round{width:34px;height:34px;padding:0;font-size:15px}' +
        '.oa-card-btn.oa-dark{border-width:1px;padding:6px 12px;font-size:12px}' +
        '.oa-card-btn.oa-dark.oa-kiosk{background:rgba(16,185,129,.18);color:#a7f3d0;border-color:rgba(110,231,183,.5)}' +
        '.oa-card-btn.oa-dark.oa-phone{background:rgba(6,182,212,.18);color:#a5f3fc;border-color:rgba(103,232,249,.5)}' +
        '.oa-ico{width:1.15em;height:1.15em;flex-shrink:0;display:inline-block;vertical-align:-0.2em}' +
        '.oa-play .oa-ico{width:24px;height:24px}' +
        '.oa-spin{animation:oa-rot .9s linear infinite}' +
        '@keyframes oa-rot{to{transform:rotate(360deg)}}' +
        // 頁面裡的播放器（manage 點餐紀錄）
        '.oa-inline{display:flex;flex-wrap:wrap;align-items:center;gap:8px;box-sizing:border-box;width:100%;max-width:560px;background:#0f172a;color:#f8fafc;' +
        'border:1px solid rgba(148,163,184,.25);border-left:6px solid var(--oa-accent,#10b981);border-radius:14px;padding:8px 10px;-webkit-user-select:none;user-select:none}' +
        '.oa-inline .oa-msg{flex-basis:100%;margin-top:0}';

    function injectCss() {
        if (document.querySelector('style[data-order-audio]')) return;
        var style = document.createElement('style');
        style.setAttribute('data-order-audio', VERSION);
        style.textContent = CSS;
        (document.head || document.documentElement).appendChild(style);
    }
    if (typeof document !== 'undefined') injectCss();

    function make(tag, cls, text, attrs) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text != null) n.textContent = text;
        if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
        return n;
    }
    function ensureUI() {
        if (ui) return ui;
        injectCss();
        var bar = make('div', 'oa-bar', null, { role: 'region', 'aria-label': '訂單錄音', 'data-order-audio-bar': '' });
        bar.hidden = true;
        var top = make('div', 'oa-top');
        var title = make('span', 'oa-title');
        var sub = make('span', 'oa-sub');
        var x = make('button', 'oa-x', '✕', { type: 'button', 'aria-label': '關閉', 'data-oa-close': '' });
        top.appendChild(title); top.appendChild(sub); top.appendChild(x);
        var row = make('div', 'oa-row');
        var back = make('button', 'oa-btn', '↺5秒', { type: 'button', 'aria-label': '倒退 5 秒', 'data-oa-back': '' });
        var play = make('button', 'oa-btn oa-play', null, { type: 'button', 'aria-label': '播放', 'data-oa-play': '' });
        var seek = make('input', 'oa-seek', null, { type: 'range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': '進度', 'data-oa-seek': '' });
        var time = make('span', 'oa-time', '0:00');
        var rate = make('button', 'oa-btn', RATES[rateIdx] + 'x', { type: 'button', 'aria-label': '播放速度', 'data-oa-rate': '' });
        row.appendChild(back); row.appendChild(play); row.appendChild(seek); row.appendChild(time); row.appendChild(rate);
        var msg = make('div', 'oa-msg', null, { 'data-oa-msg': '' });
        bar.appendChild(top); bar.appendChild(row); bar.appendChild(msg);
        document.body.appendChild(bar);
        ui = { bar: bar, title: title, sub: sub, play: play, back: back, seek: seek, time: time, rate: rate, msg: msg };

        x.addEventListener('click', function (e) { e.stopPropagation(); close(); });
        play.addEventListener('click', function (e) {
            e.stopPropagation();
            if (!cur) return;
            if (state === 'error') { var r = cur; cur = null; play_(r); return; }
            toggle();
        });
        back.addEventListener('click', function (e) {
            e.stopPropagation();
            if (el && isFinite(el.currentTime)) el.currentTime = Math.max(0, el.currentTime - 5);
        });
        rate.addEventListener('click', function (e) {
            e.stopPropagation();
            rateIdx = (rateIdx + 1) % RATES.length;
            try { global.localStorage.setItem('order_audio_rate', String(RATES[rateIdx])); } catch (_) { }
            if (el) { el.playbackRate = RATES[rateIdx]; el.defaultPlaybackRate = RATES[rateIdx]; }
            rate.textContent = RATES[rateIdx] + 'x';
        });
        seek.addEventListener('input', function () {
            seeking = true;
            var d = duration();
            if (d) { ui.time.textContent = fmt(Number(seek.value) / 1000 * d) + ' / ' + fmt(d); }
        });
        seek.addEventListener('change', function () {
            var d = duration();
            if (el && d) el.currentTime = Number(seek.value) / 1000 * d;
            seeking = false;
        });
        ['click', 'pointerdown', 'touchstart'].forEach(function (ev) { bar.addEventListener(ev, function (e) { e.stopPropagation(); }, { passive: true }); });
        global.addEventListener('resize', place);
        return ui;
    }
    function place() {
        if (!ui) return;
        var right = 12, bottom = null;
        try { if (cfg.right) right = Math.max(0, Number(cfg.right()) || 0); } catch (_) { right = 12; }
        try { if (cfg.bottom) bottom = Number(cfg.bottom()); } catch (_) { bottom = null; }
        ui.bar.style.right = right + 'px';
        ui.bar.style.width = 'min(440px, calc(100vw - ' + (right + 12) + 'px))';
        if (bottom != null && isFinite(bottom)) ui.bar.style.bottom = 'calc(' + bottom + 'px + env(safe-area-inset-bottom, 0px))';
        ui.bar.style.zIndex = String(cfg.zIndex || 90);
    }
    function fmt(sec) {
        sec = Math.max(0, Math.floor(Number(sec) || 0));
        return Math.floor(sec / 60) + ':' + pad(sec % 60, 2);
    }
    function duration() {
        var d = el ? el.duration : 0;
        return (d && isFinite(d)) ? d : 0;
    }
    function render(msg) {
        if (!ui) return;
        if (!cur) { ui.bar.hidden = true; return; }
        place();
        ui.bar.hidden = false;
        ui.bar.className = 'oa-bar oa-kind-' + cur.kind;
        ui.bar.setAttribute('data-oa-state', state);
        ui.title.textContent = cur.title || '';
        ui.sub.textContent = cur.sub || '';
        var busy = state === 'loading';
        ui.play.innerHTML = iconHtml(busy ? 'loading' : (state === 'playing' ? 'playing' : ((state === 'error' || state === 'ended') ? 'ended' : 'paused')));
        ui.play.setAttribute('aria-label', state === 'playing' ? '暫停' : (state === 'error' ? '再試一次' : '播放'));
        ui.play.disabled = busy;
        ui.back.disabled = busy || state === 'error';
        ui.seek.disabled = busy || state === 'error';
        ui.rate.textContent = RATES[rateIdx] + 'x';
        if (msg !== undefined) ui.msg.textContent = msg || '';
        if (busy) ui.msg.textContent = msg || '載入錄音中…';
        progress();
    }
    function progress() {
        if (!ui || !el || seeking) return;
        var d = duration(), t = el.currentTime || 0;
        if (state === 'loading' || state === 'error') { ui.seek.value = '0'; ui.time.textContent = '0:00'; return; }
        ui.seek.value = d ? String(Math.round(Math.min(1, t / d) * 1000)) : '0';
        ui.time.textContent = fmt(t) + (d ? ' / ' + fmt(d) : '');
    }

    // ── <audio> ──
    var SILENT = (function () {   // 0.05 秒無聲 wav：iPad 要在「手按」的那一下先播過，之後抓完錄音才能自動播
        var n = 400, buf = new Uint8Array(44 + n), dv = new DataView(buf.buffer);
        function w(o, s) { for (var i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); }
        w(0, 'RIFF'); dv.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, 8000, true); dv.setUint32(28, 8000, true); dv.setUint16(32, 1, true); dv.setUint16(34, 8, true); w(36, 'data'); dv.setUint32(40, n, true);
        for (var i = 44; i < buf.length; i++) buf[i] = 128;
        var s = ''; for (var j = 0; j < buf.length; j++) s += String.fromCharCode(buf[j]);
        return 'data:audio/wav;base64,' + global.btoa(s);
    })();
    function audioEl() {
        if (el) return el;
        el = new global.Audio();
        el.preload = 'auto';
        el.setAttribute('playsinline', '');
        el.addEventListener('playing', function () { if (cur && !isSilent()) setState('playing', ''); });
        el.addEventListener('pause', function () { if (cur && state === 'playing' && !el.ended) setState('paused'); });
        el.addEventListener('ended', function () { if (cur && !isSilent()) setState('ended'); });
        el.addEventListener('timeupdate', progress);
        el.addEventListener('durationchange', progress);
        el.addEventListener('loadedmetadata', progress);
        el.addEventListener('error', function () {
            if (!cur || isSilent() || !el.getAttribute('src')) return;
            if (cur._raw && !cur._converted) {   // 原檔播不了（webm）又還沒轉過 → 轉 wav 再試
                var r = cur, s = seq;
                setState('loading', '這台裝置不能直接播，轉檔中…');
                toWav(r._raw).then(function (blob) {
                    if (s !== seq) return;
                    r._converted = true;
                    start(r, URL.createObjectURL(blob));
                }).catch(function () { if (s === seq) fail('這台裝置不能播這種錄音格式，請用電腦的 manage 聽'); });
                return;
            }
            fail('這台裝置不能播這種錄音格式，請用電腦的 manage 聽');
        });
        return el;
    }
    function isSilent() { return String(el && (el.currentSrc || el.getAttribute('src')) || '').indexOf('data:audio/wav') === 0; }
    function unlock() {
        var a = audioEl();
        if (!actx) {   // 也在手按的這一下建好解碼用的 AudioContext（iPad 比較穩）；只拿來解碼，先暫停不占喇叭
            var AC = global.AudioContext || global.webkitAudioContext;
            try { if (AC) actx = new AC(); } catch (_) { actx = null; }
            try { var sp = actx && actx.suspend && actx.suspend(); if (sp && sp.catch) sp.catch(function () { }); } catch (_) { }
        }
        if (unlocked) return;
        unlocked = true;
        try {
            a.src = SILENT;
            var p = a.play();
            if (p && p.then) p.then(function () { if (isSilent()) a.pause(); }, function () { });
        } catch (_) { }
    }
    function toggle() {
        if (!el || !cur) return;
        if (state === 'playing') { el.pause(); return; }
        if (state === 'paused' || state === 'ended') {
            if (state === 'ended') el.currentTime = 0;
            var p = el.play();
            if (p && p.catch) p.catch(function () { setState('paused', '請再按一次 ▶'); });
        }
    }
    function stopAudio() {
        if (!el) return;
        try { el.pause(); } catch (_) { }
    }
    function close() {
        seq++;
        stopAudio();
        cur = null;
        setState('idle', '');
    }

    // ── 讀錄音 ──
    function errMsg(status, data, fallback) {
        var e = new Error((data && data.error) || fallback);
        e.status = status;
        return e;
    }
    function fetchAudio(req) {
        var base = '';
        try { base = str(cfg.getBase && cfg.getBase()).replace(/\/+$/, ''); } catch (_) { base = ''; }
        if (!base) return Promise.reject(new Error('還沒設定 Pi 伺服器網址（manage → LINE Pay 伺服器）'));
        var url = req.kind === 'phone'
            ? base + '/api/order-audio/phone/' + encodeURIComponent(req.sid)
            : base + '/api/order-audio/kiosk?date=' + encodeURIComponent(req.day) + '&no=' + encodeURIComponent(req.no || '') +
              '&t=' + encodeURIComponent(req.t || '') + (req.id ? '&id=' + encodeURIComponent(req.id) : '');
        return Promise.resolve(cfg.getToken ? cfg.getToken() : '').then(function (token) {
            if (!token) throw new Error('請先登入');
            var ctrl = global.AbortController ? new AbortController() : null;
            var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
            return fetch(url, { headers: { 'Authorization': 'Bearer ' + token }, cache: 'no-store', signal: ctrl ? ctrl.signal : undefined })
                .then(function (r) {
                    if (r.ok) return r.blob().then(function (b) {
                        var type = str(r.headers.get('Content-Type')).split(';')[0].toLowerCase() || b.type || '';
                        if (!b.size) throw new Error('錄音是空的');
                        return b.type ? b : new Blob([b], { type: type });
                    });
                    return r.text().then(function (body) {
                        var data = null;
                        try { data = body ? JSON.parse(body) : null; } catch (_) { data = null; }
                        if (r.status === 401) throw errMsg(401, null, '請重新登入（Pi 驗證不過）');
                        if (r.status === 404 && !(data && data.success === false)) throw errMsg(404, null, 'Pi 還沒安裝「聽錄音」（' + VERSION + '）');
                        throw errMsg(r.status, data, 'Pi 錯誤 HTTP ' + r.status);
                    });
                }, function (e) {
                    throw new Error(e && e.name === 'AbortError' ? '載入逾時（Pi 太慢或連不到）' : '連不到 Pi（店內網路或 Cloudflare Tunnel）');
                })
                .then(function (b) { clearTimeout(timer); return b; }, function (e) { clearTimeout(timer); throw e; });
        });
    }
    function readBuf(blob) {
        if (blob.arrayBuffer) return blob.arrayBuffer();
        return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.onerror = rej; fr.readAsArrayBuffer(blob); });
    }
    function decode(buf) {
        var AC = global.AudioContext || global.webkitAudioContext;
        if (!actx && AC) { try { actx = new AC(); } catch (_) { actx = null; } }
        if (!actx) return Promise.reject(new Error('no_audiocontext'));
        return new Promise(function (res, rej) {
            var done = false;
            var p = actx.decodeAudioData(buf, function (b) { if (!done) { done = true; res(b); } }, function (e) { if (!done) { done = true; rej(e || new Error('decode_failed')); } });
            if (p && p.then) p.then(function (b) { if (!done) { done = true; res(b); } }, function (e) { if (!done) { done = true; rej(e); } });
        });
    }
    function encodeWav(ab, rate) {   // 混成單聲道 → 降到 rate（說話 24kHz 就很清楚）→ 16-bit wav
        var n = ab.length, chs = ab.numberOfChannels, src = new Float32Array(n);
        for (var c = 0; c < chs; c++) { var d = ab.getChannelData(c); for (var i = 0; i < n; i++) src[i] += d[i] / chs; }
        var sr = ab.sampleRate, out = src;
        if (rate && sr > rate) {
            var len = Math.floor(n * rate / sr), step = sr / rate;
            out = new Float32Array(len);
            for (var k = 0; k < len; k++) {
                var pos = k * step, i0 = Math.floor(pos), f = pos - i0, a = src[i0] || 0, b = src[i0 + 1] == null ? a : src[i0 + 1];
                out[k] = a + (b - a) * f;
            }
            sr = rate;
        }
        var buf = new ArrayBuffer(44 + out.length * 2), dv = new DataView(buf);
        function w(o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); }
        w(0, 'RIFF'); dv.setUint32(4, 36 + out.length * 2, true); w(8, 'WAVEfmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
        dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, out.length * 2, true);
        for (var j = 0, o = 44; j < out.length; j++, o += 2) { var v = Math.max(-1, Math.min(1, out[j])); dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
        return new Blob([buf], { type: 'audio/wav' });
    }
    function toWav(blob) { return readBuf(blob).then(decode).then(function (ab) { return encodeWav(ab, 24000); }); }
    function prepare(req, blob) {
        var type = str(blob.type).split(';')[0].toLowerCase();
        if (/webm|ogg|opus/.test(type)) {   // 平板錄的 Opus：轉 wav（iPad 一定要；電腦轉了進度條、倍速也比較準）
            req._raw = blob;
            return toWav(blob).then(function (wav) { req._converted = true; return wav; }, function () { req._converted = false; return blob; });
        }
        return Promise.resolve(blob);
    }
    function cached(key) {
        for (var i = 0; i < cache.length; i++) if (cache[i].key === key) return cache[i];
        return null;
    }
    function remember(key, url) {
        cache = cache.filter(function (c) { return c.key !== key; });
        cache.push({ key: key, url: url });
        while (cache.length > CACHE_MAX) {
            var old = cache.shift();
            try { URL.revokeObjectURL(old.url); } catch (_) { }
        }
    }
    function start(req, url) {
        if (req !== cur) return;
        var a = audioEl();
        a.src = url;
        a.defaultPlaybackRate = RATES[rateIdx];
        a.playbackRate = RATES[rateIdx];
        try { a.currentTime = 0; } catch (_) { }
        var p = a.play();
        if (p && p.then) p.then(function () { a.playbackRate = RATES[rateIdx]; }, function (e) {
            if (req !== cur) return;
            if (e && e.name === 'NotAllowedError') setState('paused', '按 ▶ 開始播放');
            else if (e && e.name !== 'AbortError' && state === 'loading') setState('paused', '');
        });
    }
    function fail(msg) {
        stopAudio();
        setState('error', msg || '播不出來');
    }
    function play_(req) {
        if (!req || !req.key) return;
        ensureUI();
        if (cur && cur.key === req.key && state !== 'error' && state !== 'idle') {   // 同一張：暫停／繼續
            if (state !== 'loading') toggle();
            return;
        }
        unlock();
        stopAudio();
        var s = ++seq;
        cur = req;
        setState('loading');
        var hit = cached(req.key);
        if (hit) { start(req, hit.url); return; }
        fetchAudio(req).then(function (blob) {
            if (s !== seq) return null;
            return prepare(req, blob);
        }).then(function (blob) {
            if (!blob || s !== seq) return;
            var url = URL.createObjectURL(blob);
            remember(req.key, url);
            start(req, url);
        }).catch(function (e) {
            if (s !== seq) return;
            console.warn('[order-audio]', e && e.message ? e.message : e);
            fail(e && e.message ? e.message : String(e));
        });
    }

    // ── 頁面裡的播放器（_002，manage 點餐紀錄用）：錄音由頁面抓好交給它；不會自己出聲，按 ▶ 才播 ──
    function inline(host, opts) {
        opts = opts || {};
        injectCss();
        var a = new global.Audio(), st = 'loading', dead = false, url = '', drag = false, req = {}, fed = null;
        a.preload = 'auto';
        a.setAttribute('playsinline', '');
        var box = make('div', 'oa-inline oa-kind-' + (opts.kind === 'phone' ? 'phone' : 'kiosk'), null, { 'data-oa-inline': '' });
        var back = make('button', 'oa-btn', '↺5秒', { type: 'button', 'aria-label': '倒退 5 秒', 'data-oa-back': '' });
        var play = make('button', 'oa-btn oa-play', null, { type: 'button', 'aria-label': '播放', 'data-oa-play': '' });
        var seek = make('input', 'oa-seek', null, { type: 'range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': '進度', 'data-oa-seek': '' });
        var time = make('span', 'oa-time', '0:00');
        var rate = make('button', 'oa-btn', RATES[rateIdx] + 'x', { type: 'button', 'aria-label': '播放速度', 'data-oa-rate': '' });
        var msg = make('div', 'oa-msg', null, { 'data-oa-msg': '' });
        [back, play, seek, time, rate, msg].forEach(function (n) { box.appendChild(n); });
        host.appendChild(box);

        function dur() { var d = a.duration; return (d && isFinite(d)) ? d : 0; }
        function prog() {
            if (drag) return;
            var d = dur(), t = a.currentTime || 0;
            if (st === 'loading' || st === 'error') { seek.value = '0'; time.textContent = '0:00'; return; }
            seek.value = d ? String(Math.round(Math.min(1, t / d) * 1000)) : '0';
            time.textContent = fmt(t) + (d ? ' / ' + fmt(d) : '');
        }
        function paint(m) {
            if (dead) return;
            box.setAttribute('data-oa-state', st);
            play.innerHTML = iconHtml(st === 'loading' ? 'loading' : (st === 'playing' ? 'playing' : (st === 'error' ? 'error' : (st === 'ended' ? 'ended' : 'paused'))));
            play.setAttribute('aria-label', st === 'playing' ? '暫停' : '播放');
            play.disabled = back.disabled = seek.disabled = (st === 'loading' || st === 'error');
            rate.textContent = RATES[rateIdx] + 'x';
            if (m !== undefined) msg.textContent = m || '';
            prog();
        }
        function set(s, m) { st = s; paint(m); }
        a.addEventListener('playing', function () { set('playing', ''); });
        a.addEventListener('pause', function () { if (st === 'playing' && !a.ended) set('paused'); });
        a.addEventListener('ended', function () { set('ended'); });
        a.addEventListener('timeupdate', prog);
        a.addEventListener('durationchange', prog);
        a.addEventListener('loadedmetadata', prog);
        a.addEventListener('error', function () {
            if (dead || !a.getAttribute('src')) return;
            if (req._raw && !req._converted) {   // 原檔播不了（webm）又還沒轉過 → 轉 wav 再試
                var raw = req._raw;
                req._converted = true;
                set('loading', '這台裝置不能直接播，轉檔中…');
                toWav(raw).then(function (w) { use(w); }, function () { set('error', '這台裝置不能播這種錄音格式，請用電腦的 Chrome 聽'); });
                return;
            }
            set('error', '這台裝置不能播這種錄音格式，請用電腦的 Chrome 聽');
        });
        function use(blob) {
            if (dead) return;
            if (url) { try { URL.revokeObjectURL(url); } catch (_) { } }
            url = URL.createObjectURL(blob);
            a.src = url;
            a.defaultPlaybackRate = a.playbackRate = RATES[rateIdx];
            try { a.load(); } catch (_) { }
            set('paused', '');   // 準備好了：顯示 ▶，等店員按
        }
        play.addEventListener('click', function (e) {
            e.stopPropagation();
            if (st === 'playing') { a.pause(); return; }
            if (st !== 'paused' && st !== 'ended') return;
            if (st === 'ended') { try { a.currentTime = 0; } catch (_) { } }
            a.playbackRate = RATES[rateIdx];
            var p = a.play();
            if (p && p.catch) p.catch(function (err) { if (!dead && err && err.name === 'NotAllowedError') set('paused', '請再按一次 ▶'); });
        });
        back.addEventListener('click', function (e) {
            e.stopPropagation();
            if (isFinite(a.currentTime)) a.currentTime = Math.max(0, a.currentTime - 5);
        });
        rate.addEventListener('click', function (e) {
            e.stopPropagation();
            rateIdx = (rateIdx + 1) % RATES.length;
            try { global.localStorage.setItem('order_audio_rate', String(RATES[rateIdx])); } catch (_) { }
            a.defaultPlaybackRate = a.playbackRate = RATES[rateIdx];
            rate.textContent = RATES[rateIdx] + 'x';
        });
        seek.addEventListener('input', function () {
            drag = true;
            var d = dur();
            if (d) time.textContent = fmt(Number(seek.value) / 1000 * d) + ' / ' + fmt(d);
        });
        seek.addEventListener('change', function () {
            var d = dur();
            if (d) a.currentTime = Number(seek.value) / 1000 * d;
            drag = false;
        });
        set('loading', opts.loadingText || '載入錄音中…');

        return {
            element: box,
            state: function () { return st; },
            audio: a,
            loading: function () { if (dead) return; try { a.pause(); } catch (_) { } fed = null; set('loading', opts.loadingText || '載入錄音中…'); },
            setBlob: function (blob) {
                if (dead || !blob || blob === fed) return;
                fed = blob;
                req = {};
                set('loading', '準備錄音中…');
                prepare(req, blob).then(function (b) { if (!dead && fed === blob) use(b); }, function () { if (!dead) set('error', '錄音讀不出來'); });
            },
            fail: function (m) { if (dead) return; try { a.pause(); } catch (_) { } fed = null; set('error', m || '播不出來'); },
            destroy: function () {
                if (dead) return;
                dead = true;
                try { a.pause(); } catch (_) { }
                a.removeAttribute('src');
                try { a.load(); } catch (_) { }
                if (url) { try { URL.revokeObjectURL(url); } catch (_) { } }
                if (box.parentNode) box.parentNode.removeChild(box);
            }
        };
    }

    function configure(opts) {
        opts = opts || {};
        ['getBase', 'getToken', 'right', 'bottom', 'zIndex'].forEach(function (k) { if (opts[k] !== undefined) cfg[k] = opts[k]; });
        place();
    }

    global.OrderAudio = {
        version: VERSION,
        configure: configure,
        requestFor: requestFor,
        play: play_,
        toggle: toggle,
        close: close,
        status: status,
        onChange: onChange,
        iconHtml: iconHtml,
        buttonHtml: buttonHtml,
        inline: inline,
        _test: { encodeWav: encodeWav, cleanPhoneId: cleanPhoneId, SILENT: SILENT }
    };
})(window);
