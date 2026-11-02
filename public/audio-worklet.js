// Audio processors for the server relay: 16 kHz mono, 8-bit mu-law, 40 ms frames (640 bytes).
const RELAY_RATE = 16000;
const FRAME = 640;

function linToMu(x) {
  let s = Math.max(-1, Math.min(1, x)) * 32635;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += 132;
  let exp = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exp > 0; exp--, mask >>= 1) {}
  const mant = (s >> (exp + 3)) & 0x0f;
  return ~(sign | (exp << 4) | mant) & 0xff;
}
const MU_TABLE = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const u = ~i & 0xff, sign = u & 0x80, exp = (u >> 4) & 7, mant = u & 0x0f;
  const s = (((mant << 3) + 132) << exp) - 132;
  MU_TABLE[i] = (sign ? -s : s) / 32768;
}

// Microphone -> mu-law frames. Averaging while downsampling doubles as a rough low-pass filter.
class RelayCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / RELAY_RATE;
    this.pos = 0; this.sum = 0; this.cnt = 0; this.sq = 0;
    this.buf = new Uint8Array(FRAME); this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.sum += ch[i]; this.cnt++; this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = this.sum / this.cnt;
        this.sum = 0; this.cnt = 0;
        this.sq += s * s;
        this.buf[this.n++] = linToMu(s);
        if (this.n === FRAME) {
          this.port.postMessage({ bytes: this.buf.slice(0), level: Math.sqrt(this.sq / FRAME) });
          this.n = 0; this.sq = 0;
        }
      }
    }
    return true;
  }
}

// Relayed frames -> speakers, with a small jitter buffer that refills after an underrun.
class RelayPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = []; this.buffered = 0; this.readPos = 0; this.started = false;
    this.step = RELAY_RATE / sampleRate;
    this.port.onmessage = e => {
      const u8 = e.data, f = new Float32Array(u8.length);
      for (let i = 0; i < u8.length; i++) f[i] = MU_TABLE[u8[i]];
      this.q.push(f); this.buffered += f.length;
      // Too far behind (network burst): drop old audio to stay near real time.
      while (this.buffered > RELAY_RATE * 0.5 && this.q.length > 1) { this.buffered -= this.q.shift().length; this.readPos = 0; }
    };
  }
  process(_, outputs) {
    const out = outputs[0];
    const ch0 = out[0];
    if (!this.started && this.buffered >= RELAY_RATE * 0.08) this.started = true;
    for (let i = 0; i < ch0.length; i++) {
      if (!this.started || !this.q.length) { ch0[i] = 0; this.started = false; continue; }
      const cur = this.q[0], idx = this.readPos | 0, frac = this.readPos - idx;
      const a = cur[idx], b = idx + 1 < cur.length ? cur[idx + 1] : (this.q[1] ? this.q[1][0] : a);
      ch0[i] = a + (b - a) * frac;
      this.readPos += this.step;
      if (this.readPos >= cur.length) { this.readPos -= cur.length; this.buffered -= cur.length; this.q.shift(); }
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    return true;
  }
}

registerProcessor("relay-capture", RelayCapture);
registerProcessor("relay-player", RelayPlayer);
