/*
 * print-jobs-alert.20260928_001.js — 「未印出工單」提示音（POS / admin 共用）
 * ------------------------------------------------------------
 * 音效檔：網站根目錄的 print-alert.mp3（和 pos.html、admin.html 同一層）。
 * 找不到或無法播放時，改用瀏覽器內建合成的「嗶嗶」兩聲，所以沒有音效檔也會響。
 *
 * 瀏覽器規定：頁面要先被點過一次（任何點擊/觸控/按鍵）之後才允許播放聲音；
 * 這裡會在第一次點擊時自動「解鎖」，POS 平常一定會被點，所以不需要額外操作。
 *
 * 響鈴規則（createJobWatcher）：
 *   - 出現新的未印出工單（自動重試中或需人工）→ 響一次
 *   - 有「需人工處理」（紅色）的單、而且店員還沒打開清單看過 → 每 30 秒再響一次
 *   - 打開清單、按重印或忽略 → 視為已看到，不再重複響
 */
(function (global) {
    'use strict';

    var DEFAULT_SRC = './print-alert.mp3?v=20260928';

    function createPrintAlert(options) {
        options = options || {};
        var src = options.src || DEFAULT_SRC;
        var audio = null;
        var audioOk = null; // null = 還不知道；false = 檔案不存在或格式不支援
        var ctx = null;
        var unlocked = false;

        function getAudio() {
            if (audio || audioOk === false) return audio;
            try {
                audio = new global.Audio(src);
                audio.preload = 'auto';
                audio.addEventListener('error', function () { audioOk = false; });
                audio.addEventListener('canplaythrough', function () { audioOk = true; });
            } catch (e) {
                audioOk = false;
                audio = null;
            }
            return audio;
        }

        function getCtx() {
            if (ctx) return ctx;
            var Ctor = global.AudioContext || global.webkitAudioContext;
            if (!Ctor) return null;
            try { ctx = new Ctor(); } catch (e) { ctx = null; }
            return ctx;
        }

        function beep() {
            var c = getCtx();
            if (!c) return false;
            try {
                if (c.state === 'suspended' && c.resume) c.resume();
                var t = c.currentTime;
                [[0, 880], [0.24, 1320]].forEach(function (tone) {
                    var osc = c.createOscillator();
                    var gain = c.createGain();
                    osc.type = 'square';
                    osc.frequency.value = tone[1];
                    gain.gain.setValueAtTime(0.0001, t + tone[0]);
                    gain.gain.exponentialRampToValueAtTime(0.25, t + tone[0] + 0.01);
                    gain.gain.exponentialRampToValueAtTime(0.0001, t + tone[0] + 0.18);
                    osc.connect(gain);
                    gain.connect(c.destination);
                    osc.start(t + tone[0]);
                    osc.stop(t + tone[0] + 0.2);
                });
                return true;
            } catch (e) {
                return false;
            }
        }

        function play() {
            var a = getAudio();
            if (a && audioOk !== false) {
                try {
                    a.currentTime = 0;
                    var p = a.play();
                    if (p && p.catch) p.catch(function () { beep(); });
                    return;
                } catch (e) { /* 改用合成音 */ }
            }
            beep();
        }

        function unlock() {
            if (unlocked) return;
            unlocked = true;
            var c = getCtx();
            if (c && c.state === 'suspended' && c.resume) {
                try { c.resume(); } catch (e) { /* ignore */ }
            }
            var a = getAudio();
            if (!a) return;
            try {
                a.muted = true;
                var p = a.play();
                var done = function () { try { a.pause(); a.currentTime = 0; } catch (e) { /* ignore */ } a.muted = false; };
                if (p && p.then) p.then(done).catch(function () { a.muted = false; });
                else done();
            } catch (e) {
                a.muted = false;
            }
        }

        function bindUnlock(target) {
            target = target || global.document;
            if (!target || !target.addEventListener) return;
            ['pointerdown', 'touchstart', 'keydown'].forEach(function (name) {
                target.addEventListener(name, unlock, { passive: true });
            });
        }

        return { play: play, beep: beep, unlock: unlock, bindUnlock: bindUnlock };
    }

    function createJobWatcher(options) {
        var repeatMs = (options && options.repeatMs) || 30000;
        var seen = {};
        var acked = {};
        var lastRing = 0;
        return {
            // 傳入最新的工作清單；回傳這次要不要響
            update: function (jobs, now) {
                now = now || Date.now();
                var fresh = false;
                var unackedFailed = false;
                (jobs || []).forEach(function (job) {
                    if (!job || job.id === undefined || job.id === null) return;
                    if (!seen[job.id]) { seen[job.id] = true; fresh = true; }
                    if (job.status === 'failed' && !acked[job.id]) unackedFailed = true;
                });
                var ring = fresh || (unackedFailed && now - lastRing >= repeatMs);
                if (ring) lastRing = now;
                return ring;
            },
            // 店員打開清單或按了按鈕 → 這些單不再重複響
            ack: function (jobs) {
                (jobs || []).forEach(function (job) { if (job && job.id !== undefined) acked[job.id] = true; });
            }
        };
    }

    global.YuangiPrintAlert = { createPrintAlert: createPrintAlert, createJobWatcher: createJobWatcher };
})(typeof window !== 'undefined' ? window : this);
