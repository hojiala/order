/*!
 * daily-theme.js — 每日主題顏色 → CSS 變數（20261021）
 *
 * manage「🎨 每日主題顏色設定」(settings.dailyThemes) 每天有一組「起始色 → 結束色」。
 * index / dinein / pos / admin 各自的 applyDailyTheme() 讀到設定後呼叫 DailyTheme.apply(cfg)，
 * 這裡把兩個顏色換算成一整組 CSS 變數；daily-theme.css 再把原本寫死的橘色改成吃這些變數，
 * 所以彈窗、按鈕、價格、選項 chip 都會跟著當天的主題色，改設定時即時更新。
 *
 * 變數一覽（都掛在 <html> 上）：
 *   --day-theme           起始色（原有）
 *   --day-theme-end       結束色
 *   --day-theme-bg        起→迄漸層（原有，頂部色條也用它）
 *   --day-theme-rgb       起始色的 "r, g, b"，給 rgba() 陰影用
 *   --day-theme-on        放在主題色底上的文字色：深色主題用白字、淺色主題自動換深灰字
 *   --day-theme-on-soft   同上，較淡（副標題）
 *   --day-theme-50 … 400  由淺到深的淡色階，給淡底色／邊框
 *   --day-theme-t400 … t700  放在白底上的文字色，會自動加深到夠看得清楚
 *   --day-theme-deep-bg   整頁深色漸層（PIN 輸入、平板配對畫面，上面是白字）
 *
 * 沒載入這支檔案時，daily-theme.css 裡每個 var() 都有原本橘色當 fallback，畫面維持原樣。
 * 只用 ES5，LIFF / 舊 Android WebView 也能跑。
 */
(function (root) {
    'use strict';

    var HEX_RE = /^#[0-9A-Fa-f]{6}$/;
    var ANGLE_RE = /^-?\d{1,3}deg$/;
    var CACHE_KEY = 'dailyThemeCache.v1';
    var WHITE = [255, 255, 255];
    var BLACK = [0, 0, 0];
    var DARK_TEXT = [31, 41, 55];      // #1f2937
    var MIN_WHITE_CONTRAST = 1.9;      // 白字對比低於這個值（主題色太淺）就改用深灰字

    function parseHex(hex) {
        return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
    }
    function toHex(rgb) {
        return '#' + rgb.map(function (v) {
            var s = Math.max(0, Math.min(255, Math.round(v))).toString(16);
            return s.length < 2 ? '0' + s : s;
        }).join('');
    }
    // 由 a 往 b 混色，t=0 → a，t=1 → b
    function mix(a, b, t) {
        return [
            Math.round(a[0] + (b[0] - a[0]) * t),
            Math.round(a[1] + (b[1] - a[1]) * t),
            Math.round(a[2] + (b[2] - a[2]) * t)
        ];
    }
    function channel(v) {
        v = v / 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    function luminance(c) {
        return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
    }
    function contrast(a, b) {
        var la = luminance(a), lb = luminance(b);
        return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
    }
    // 顏色已經夠深就原樣回傳；太淺才一路往黑色加深，直到對 bg 的對比 >= min
    function darkenToContrast(rgb, bg, min) {
        var out = rgb;
        for (var i = 0; i <= 20; i++) {
            out = mix(rgb, BLACK, i * 0.05);
            if (contrast(out, bg) >= min) break;
        }
        return out;
    }
    // 主題色（漸層兩端）上要放白字還是深灰字
    function pickOnColor(s, e) {
        var whiteMin = Math.min(contrast(WHITE, s), contrast(WHITE, e));
        if (whiteMin >= MIN_WHITE_CONTRAST) return WHITE;
        var darkMin = Math.min(contrast(DARK_TEXT, s), contrast(DARK_TEXT, e));
        return darkMin > whiteMin ? DARK_TEXT : WHITE;
    }

    function normalize(cfg) {
        if (!cfg || typeof cfg !== 'object' || !HEX_RE.test(cfg.start || '')) return null;
        return {
            start: cfg.start,
            end: HEX_RE.test(cfg.end || '') ? cfg.end : cfg.start,
            angle: ANGLE_RE.test(cfg.angle || '') ? cfg.angle : '135deg'
        };
    }

    function derive(cfg) {
        var s = parseHex(cfg.start);
        var e = parseHex(cfg.end);
        var m = mix(s, e, 0.5);
        var on = pickOnColor(s, e);
        return {
            '--day-theme': cfg.start,
            '--day-theme-end': cfg.end,
            '--day-theme-bg': 'linear-gradient(' + cfg.angle + ', ' + cfg.start + ', ' + cfg.end + ')',
            '--day-theme-rgb': s.join(', '),
            '--day-theme-on': toHex(on),
            '--day-theme-on-soft': 'rgba(' + on.join(', ') + ', ' + (on === WHITE ? '0.85' : '0.75') + ')',
            '--day-theme-50': toHex(mix(s, WHITE, 0.92)),
            '--day-theme-100': toHex(mix(s, WHITE, 0.85)),
            '--day-theme-200': toHex(mix(s, WHITE, 0.68)),
            '--day-theme-300': toHex(mix(s, WHITE, 0.47)),
            '--day-theme-400': toHex(mix(s, WHITE, 0.2)),
            '--day-theme-t400': toHex(darkenToContrast(mix(s, WHITE, 0.2), WHITE, 2.2)),
            '--day-theme-t500': toHex(darkenToContrast(s, WHITE, 2.8)),
            '--day-theme-t600': toHex(darkenToContrast(mix(s, BLACK, 0.12), WHITE, 3.6)),
            '--day-theme-t700': toHex(darkenToContrast(mix(s, BLACK, 0.3), WHITE, 5)),
            '--day-theme-deep-bg': 'linear-gradient(145deg, ' + toHex(darkenToContrast(s, WHITE, 2.8)) + ' 0%, ' +
                toHex(darkenToContrast(m, WHITE, 3.6)) + ' 50%, ' + toHex(darkenToContrast(e, WHITE, 5.2)) + ' 100%)'
        };
    }

    function todayIndex() { return new Date().getDay(); }

    function readCache(day) {
        try {
            var raw = root.localStorage.getItem(CACHE_KEY);
            if (!raw) return null;
            var saved = JSON.parse(raw);
            return saved && saved.day === day ? normalize(saved.cfg) : null;
        } catch (err) { return null; }
    }
    function writeCache(day, cfg) {
        try { root.localStorage.setItem(CACHE_KEY, JSON.stringify({ day: day, cfg: cfg })); } catch (err) { /* 無痕模式等情況不能存，沒差 */ }
    }

    function paint(cfg) {
        var vars = derive(cfg);
        var style = root.document.documentElement.style;
        for (var name in vars) {
            if (Object.prototype.hasOwnProperty.call(vars, name)) style.setProperty(name, vars[name]);
        }
        var meta = root.document.querySelector('meta[name="theme-color"]');
        if (meta) meta.setAttribute('content', cfg.start);
    }

    root.DailyTheme = {
        derive: function (cfg) { var c = normalize(cfg); return c ? derive(c) : null; },
        // 這一天（預設今天）有沒有「上次真的從設定套用過」的主題
        hasCache: function (day) { return !!readCache(day == null ? todayIndex() : day); },
        // opts.day：星期幾 (0-6)；opts.isDefault：true 代表只是頁面內建的預設色，不是設定值
        apply: function (cfg, opts) {
            var c = normalize(cfg);
            if (!c) return false;
            opts = opts || {};
            var day = opts.day == null ? todayIndex() : opts.day;
            // 預設色只在沒有上次主題可用時才套，避免畫面先閃一下預設色
            if (opts.isDefault && readCache(day)) return false;
            paint(c);
            if (!opts.isDefault) writeCache(day, c);
            return true;
        }
    };

    // 先用上次套用的主題畫第一格，設定還沒從 PocketBase / Firebase 回來前就不會閃預設色
    var cached = readCache(todayIndex());
    if (cached) paint(cached);
})(window);
