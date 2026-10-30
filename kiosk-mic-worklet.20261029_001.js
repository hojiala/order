// 店內語音點餐平板：麥克風擷取（AudioWorklet）。每 128 個取樣點送回主執行緒，由 kiosk-voice.html 轉成 24kHz PCM16。
class KioskMicProcessor extends AudioWorkletProcessor {
  process(inputs) {
    var ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('kiosk-mic', KioskMicProcessor);
