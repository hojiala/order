// 店內語音點餐平板：麥克風擷取（AudioWorklet）— kiosk-mic-worklet.20261128_001.js（kiosk-voice-denoise-20261128）
//   'kiosk-mic'    ：舊的，每 128 個取樣點原樣送回主執行緒（新的建不起來時用）
//   'kiosk-mic-nr' ：音量倍數 → AI 降噪（RNNoise／GTCRN，wasm 由主執行緒下載後傳進來）→ 雜音門檻 → 送回主執行緒，並附上處理前後的音量
/* kiosk-voice-denoise-20261128：店內語音點餐的收音處理（在 AudioWorklet 裡跑，不經過網路）
 *   輸入音量倍數 → AI 降噪（RNNoise 或 GTCRN，二選一）→ 雜音門檻（比門檻小聲的送靜音）→ 送給 xAI
 *   另外每一小段都量音量（處理前、處理後），給紀錄算「背景噪音、客人講話」用。
 *   RNNoise：xiph/rnnoise（BSD-3-Clause），wasm 取自 @sapphi-red/web-noise-suppressor（MIT）/ shiguredo/rnnoise-wasm（Apache-2.0）
 *   GTCRN：Xiaobin-Rong/gtcrn（MIT），wasm 取自 @sapphi-red/web-noise-suppressor（MIT）
 */
var KioskNR = (function () {
  'use strict';
  function dbOf(sumSq, n) { return n ? 10 * Math.log10(sumSq / n + 1e-12) : -120; }

  // ── 24kHz ↔ 48kHz（兩倍升降頻，半頻帶 FIR）──
  function halfband(taps) {
    var h = new Float64Array(taps), M = (taps - 1) / 2, sum = 0, n;
    for (n = 0; n < taps; n++) {
      var k = n - M, x = k === 0 ? 0.5 : Math.sin(Math.PI * 0.5 * k) / (Math.PI * k);
      var w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (taps - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (taps - 1));
      h[n] = x * w; sum += h[n];
    }
    for (n = 0; n < taps; n++) h[n] /= sum;
    return h;
  }
  var HB = halfband(47);
  function Up2() { this.h = HB; this.L = HB.length; this.z = new Float64Array(HB.length); this.p = 0; }   // 補零後濾波（48k 那邊的歷史）
  Up2.prototype.run = function (x, out) {   // x：24k 一段 → out：48k（長度 2 倍）
    var h = this.h, L = this.L, z = this.z, p = this.p, o = 0;
    for (var i = 0; i < x.length; i++) {
      for (var ph = 0; ph < 2; ph++) {
        z[p] = ph === 0 ? 2 * x[i] : 0;
        var acc = 0, q = p;
        for (var k = 0; k < L; k++) { acc += h[k] * z[q]; q = q === 0 ? L - 1 : q - 1; }
        out[o++] = acc;
        p = p + 1 === L ? 0 : p + 1;
      }
    }
    this.p = p;
  };
  function Down2() { this.h = HB; this.L = HB.length; this.z = new Float64Array(HB.length); this.p = 0; this.odd = 0; }
  Down2.prototype.run = function (x, out) {   // x：48k → out：24k（長度一半）；回傳寫了幾個
    var h = this.h, L = this.L, z = this.z, p = this.p, o = 0;
    for (var i = 0; i < x.length; i++) {
      z[p] = x[i];
      if (this.odd) {
        var acc = 0, q = p;
        for (var k = 0; k < L; k++) { acc += h[k] * z[q]; q = q === 0 ? L - 1 : q - 1; }
        out[o++] = acc;
      }
      this.odd ^= 1;
      p = p + 1 === L ? 0 : p + 1;
    }
    this.p = p;
    return o;
  };

  // ── wasm 降噪引擎（自己接，不用 emscripten 的 JS）──
  function Heap(getMem) { this.getMem = getMem; this.buf = null; this.f32 = null; }
  Heap.prototype.f = function () { var b = this.getMem().buffer; if (b !== this.buf) { this.buf = b; this.f32 = new Float32Array(b); } return this.f32; };
  function grow(mem, size) {
    var need = size - mem.buffer.byteLength;
    if (need <= 0) return 1;
    try { mem.grow(Math.ceil(need / 65536)); return 1; } catch (e) { return 0; }
  }
  function Rnnoise(module) {   // 48kHz、一格 480 點、數值用 16 位元的大小
    var mem = null, self = this;
    var inst = new WebAssembly.Instance(module, { env: {
      emscripten_memcpy_big: function (d, s, n) { new Uint8Array(mem.buffer).copyWithin(d, s, s + n); },
      emscripten_resize_heap: function (size) { return grow(mem, size >>> 0); },
      __assert_fail: function () { throw new Error('rnnoise assert'); }
    } });
    var x = inst.exports; mem = x.memory;
    if (x.emscripten_stack_init) x.emscripten_stack_init();
    if (x.__wasm_call_ctors) x.__wasm_call_ctors();
    this.x = x; this.heap = new Heap(function () { return mem; });
    this.frame = x.rnnoise_get_frame_size ? x.rnnoise_get_frame_size() : 480;
    this.st = x.rnnoise_create(0);
    this.pin = x.malloc(this.frame * 4); this.pout = x.malloc(this.frame * 4);
    if (!this.st || !this.pin || !this.pout) throw new Error('rnnoise init');
    this.vad = 0; void self;
  }
  Rnnoise.prototype.process = function (buf) {   // 就地處理一格
    var f = this.frame, h = this.heap.f(), a = this.pin >> 2, b = this.pout >> 2, i;
    for (i = 0; i < f; i++) h[a + i] = buf[i] * 32768;
    this.vad = this.x.rnnoise_process_frame(this.st, this.pout, this.pin);
    h = this.heap.f();
    for (i = 0; i < f; i++) buf[i] = h[b + i] / 32768;
  };
  Rnnoise.prototype.destroy = function () { try { this.x.rnnoise_destroy(this.st); this.x.free(this.pin); this.x.free(this.pout); } catch (e) {} this.st = 0; };
  function Gtcrn(module) {   // 48kHz、一格 768 點、數值 -1～1
    var mem = null;
    var inst = new WebAssembly.Instance(module, { a: {
      a: function () { throw new Error('gtcrn assert'); },
      b: function (size) { return grow(mem, size >>> 0); }
    } });
    var x = inst.exports; mem = x.c;
    x.d();
    this.x = x; this.heap = new Heap(function () { return mem; });
    this.frame = 768;
    this.st = x.e();
    this.pin = x.k(this.frame * 4); this.pout = x.k(this.frame * 4);
    if (!this.st || !this.pin || !this.pout) throw new Error('gtcrn init');
    this.vad = 0;
  }
  Gtcrn.prototype.process = function (buf) {
    var f = this.frame, h = this.heap.f(), a = this.pin >> 2, b = this.pout >> 2, i;
    for (i = 0; i < f; i++) h[a + i] = buf[i];
    this.x.j(this.st, this.pin, this.pout);
    h = this.heap.f();
    for (i = 0; i < f; i++) buf[i] = h[b + i];
  };
  Gtcrn.prototype.destroy = function () { try { this.x.f(this.pin); this.x.f(this.pout); this.x.g(this.st); } catch (e) {} this.st = 0; };

  // ── 一整串：音量倍數 → 降噪 → 門檻 ──
  //   opts：{ rate, mode: 'rnnoise'|'gtcrn'|'', module: WebAssembly.Module, gain, gateDb（0＝不用）, holdMs }
  function Chain(opts) {
    var o = opts || {};
    this.rate = o.rate || 24000;
    this.gain = o.gain > 0 ? o.gain : 1;
    this.status = 'off';
    this.eng = null;
    if (o.mode && o.module) {
      try {
        if (this.rate !== 24000 && this.rate !== 48000) throw new Error('rate ' + this.rate);
        this.eng = o.mode === 'gtcrn' ? new Gtcrn(o.module) : new Rnnoise(o.module);
        this.status = 'on';
      } catch (e) { this.eng = null; this.status = 'err:' + ((e && e.message) || e); }
    }
    if (this.eng) {
      var F = this.eng.frame, r = this.rate === 24000 ? 2 : 1;
      this.r = r; this.F = F;
      this.up = r === 2 ? new Up2() : null; this.down = r === 2 ? new Down2() : null;
      this.in48 = new Float32Array(F * 4); this.inLen = 0;
      this.frameBuf = new Float32Array(F);
      this.tmpUp = new Float32Array(256 * r);
      this.tmpDown = new Float32Array(F);
      var cap = F * 4 + 1024;
      this.q = new Float32Array(cap); this.qHead = 0; this.qLen = F / r;   // 先墊一格的靜音（延遲 F/r 點）
    }
    // 門檻：往後看 20 毫秒，開得及時；講完多留 holdMs 才關
    this.gateDb = o.gateDb < 0 ? o.gateDb : 0;
    this.la = this.gateDb ? Math.round(0.02 * this.rate) : 0;
    this.dl = new Float32Array(this.la + 256); this.dlHead = 0;
    this.holdN = Math.round(((o.holdMs || 450) / 1000) * this.rate);
    this.holdLeft = 0; this.g = this.gateDb ? 0 : 1;
    this.upStep = 1 / Math.max(1, Math.round(0.004 * this.rate));
    this.downStep = 1 / Math.max(1, Math.round(0.03 * this.rate));
    this.latency = (this.eng ? this.F / this.r : 0) + this.la;
  }
  Chain.prototype.process = function (input, out) {   // input、out：同長度（一般 128）；回傳 {raw, out, open, vad}
    var n = input.length, i, s, raw = 0;
    var x = this.work && this.work.length === n ? this.work : (this.work = new Float32Array(n));
    for (i = 0; i < n; i++) { s = input[i]; raw += s * s; x[i] = s * this.gain; }
    if (this.eng) this.nr(x);
    var open = 1;
    if (this.gateDb) open = this.gate(x);
    var o2 = 0;
    for (i = 0; i < n; i++) { s = x[i]; if (s > 1) s = 1; else if (s < -1) s = -1; out[i] = s; o2 += s * s; }
    return { raw: dbOf(raw, n), out: dbOf(o2, n), open: open, vad: this.eng ? this.eng.vad : -1 };
  };
  Chain.prototype.nr = function (x) {
    var n = x.length, F = this.F, r = this.r, i;
    if (r === 2) {
      if (this.tmpUp.length < n * 2) this.tmpUp = new Float32Array(n * 2);
      this.up.run(x, this.tmpUp);
      this.push48(this.tmpUp, n * 2);
    } else this.push48(x, n);
    while (this.inLen >= F) {
      var fb = this.frameBuf;
      for (i = 0; i < F; i++) fb[i] = this.in48[i];
      this.in48.copyWithin(0, F, this.inLen); this.inLen -= F;
      this.eng.process(fb);
      if (r === 2) { var m = this.down.run(fb, this.tmpDown); this.qPush(this.tmpDown, m); }
      else this.qPush(fb, F);
    }
    // 從佇列拿 n 點出來（前面墊了一格，不會不夠；萬一不夠就補 0）
    var cap = this.q.length;
    for (i = 0; i < n; i++) {
      if (this.qLen > 0) { x[i] = this.q[this.qHead]; this.qHead = this.qHead + 1 === cap ? 0 : this.qHead + 1; this.qLen--; }
      else x[i] = 0;
    }
  };
  Chain.prototype.push48 = function (a, len) {
    if (this.inLen + len > this.in48.length) { var b = new Float32Array((this.inLen + len) * 2); b.set(this.in48.subarray(0, this.inLen)); this.in48 = b; }
    for (var i = 0; i < len; i++) this.in48[this.inLen + i] = a[i];
    this.inLen += len;
  };
  Chain.prototype.qPush = function (a, len) {
    var cap = this.q.length;
    if (this.qLen + len > cap) {   // 不會發生；保險起見擴大
      var nb = new Float32Array((this.qLen + len) * 2), k;
      for (k = 0; k < this.qLen; k++) nb[k] = this.q[(this.qHead + k) % cap];
      this.q = nb; this.qHead = 0; cap = nb.length;
    }
    var tail = (this.qHead + this.qLen) % cap;
    for (var i = 0; i < len; i++) { this.q[tail] = a[i]; tail = tail + 1 === cap ? 0 : tail + 1; }
    this.qLen += len;
  };
  Chain.prototype.gate = function (x) {   // 就地；回傳這段結束時門是不是開的
    var n = x.length, i, sum = 0;
    for (i = 0; i < n; i++) sum += x[i] * x[i];
    var lvl = dbOf(sum, n);
    var thr = this.gateDb, open;
    if (lvl >= thr) this.holdLeft = this.holdN + this.la;
    else if (lvl >= thr - 4 && this.holdLeft > 0) this.holdLeft = Math.max(this.holdLeft, this.holdN);
    open = this.holdLeft > 0;
    // 延遲 la 點輸出，門的開合照「前面 la 點」的音量，字頭不會被切掉
    var L = this.dl.length, la = this.la;
    for (i = 0; i < n; i++) {
      var w = (this.dlHead + la) % L;
      this.dl[w] = x[i];
      var y = this.dl[this.dlHead];
      this.dlHead = this.dlHead + 1 === L ? 0 : this.dlHead + 1;
      if (open) { this.g += this.upStep; if (this.g > 1) this.g = 1; }
      else { this.g -= this.downStep; if (this.g < 0) this.g = 0; }
      x[i] = y * this.g;
    }
    this.holdLeft = Math.max(0, this.holdLeft - n);
    return open ? 1 : 0;
  };
  Chain.prototype.destroy = function () { if (this.eng) this.eng.destroy(); this.eng = null; };
  return { Chain: Chain, Up2: Up2, Down2: Down2, dbOf: dbOf };
})();

class KioskMicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    var ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('kiosk-mic', KioskMicProcessor);

var KIOSK_NR_MODULES = {};   // 同一個 AudioContext 只編譯一次 wasm
class KioskMicNrProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    var po = (options && options.processorOptions) || {}, self = this;
    this.alive = true;
    this.out = new Float32Array(128);
    this.chain = new KioskNR.Chain({ rate: sampleRate, gain: po.gain, gateDb: po.gateDb });
    this.port.onmessage = function (e) { if (e.data && e.data.cmd === 'stop') { self.alive = false; self.chain.destroy(); } };
    if ((po.mode === 'rnnoise' || po.mode === 'gtcrn') && po.wasm) {
      var p = KIOSK_NR_MODULES[po.mode] || (KIOSK_NR_MODULES[po.mode] = WebAssembly.compile(po.wasm));
      p.then(function (mod) {
        if (!self.alive) return;
        var c = new KioskNR.Chain({ rate: sampleRate, mode: po.mode, module: mod, gain: po.gain, gateDb: po.gateDb });
        self.chain = c;
        self.port.postMessage({ nr: c.status, lat: Math.round(c.latency * 1000 / sampleRate), rate: sampleRate });
      }, function (err) {
        delete KIOSK_NR_MODULES[po.mode];
        self.port.postMessage({ nr: 'err:' + ((err && err.message) || err) });
      });
    } else this.port.postMessage({ nr: 'off', rate: sampleRate });
  }
  process(inputs, outputs) {
    if (!this.alive) return false;
    var ch = inputs[0] && inputs[0][0];
    if (!ch || !ch.length) return true;
    var out = this.out.length === ch.length ? this.out : (this.out = new Float32Array(ch.length));
    var r = this.chain.process(ch, out);
    var o = outputs[0] && outputs[0][0];
    if (o && o.length === out.length) o.set(out);
    this.port.postMessage({ b: out.slice(0), r: r.raw, o: r.out, g: r.open });
    return true;
  }
}
registerProcessor('kiosk-mic-nr', KioskMicNrProcessor);
