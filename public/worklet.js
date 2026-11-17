// Junta el audio del micrófono en bloques de 100 ms (2400 muestras a 24 kHz)
// y los envía a la página como PCM16.
class Capture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(2400);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this.buf[this.n++] = s < 0 ? s * 32768 : s * 32767;
      if (this.n === this.buf.length) {
        const out = this.buf.slice();
        this.port.postMessage(out.buffer, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('capture', Capture);
