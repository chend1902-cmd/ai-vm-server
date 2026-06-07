// Beep detection for Twilio Media Streams audio (8kHz mu-law / G711u).
// Voicemail greetings end in a tone (~900-1500 Hz) right before "leave a message".
// A human never produces that tone, so a sustained tonal block is a strong
// "this is voicemail, start the message" signal.

// ---- mu-law decode (G.711 u-law byte -> signed 16-bit PCM) ----
function muLawDecode(u) {
  u = ~u & 0xff;
  let t = ((u & 0x0f) << 3) + 0x84;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? 0x84 - t : t - 0x84;
}

// ---- Goertzel power at a target frequency over a sample block ----
function goertzelPower(samples, freq, sampleRate) {
  const n = samples.length;
  const k = Math.round((n * freq) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const coeff = 2 * Math.cos(w);
  let s0 = 0,
    s1 = 0,
    s2 = 0;
  for (let i = 0; i < n; i++) {
    s0 = samples[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

class BeepDetector {
  // candidates: frequencies to watch. consecutive: blocks of tone required.
  constructor(opts = {}) {
    this.sampleRate = 8000;
    this.blockSize = opts.blockSize || 200; // 25ms at 8kHz
    this.candidates = opts.candidates || [950, 1000, 1100, 1200, 1400];
    this.tonalThreshold = opts.tonalThreshold || 0.6; // 1.0 = pure tone
    this.energyFloor = opts.energyFloor || 1e5; // ignore near-silence
    this.consecutive = opts.consecutive || 12; // ~300ms sustained
    this.buf = [];
    this.run = 0;
    this.runFreq = null;
    this.fired = false;
  }

  // Feed a base64 mu-law payload from a Twilio "media" message.
  // Returns true exactly once, when a beep is confidently detected.
  pushBase64(b64) {
    const bytes = Buffer.from(b64, 'base64');
    for (let i = 0; i < bytes.length; i++) this.buf.push(muLawDecode(bytes[i]));
    let detected = false;
    while (this.buf.length >= this.blockSize) {
      const block = this.buf.splice(0, this.blockSize);
      if (this._processBlock(block)) detected = true;
    }
    return detected;
  }

  _processBlock(block) {
    if (this.fired) return false;
    let energy = 0;
    for (let i = 0; i < block.length; i++) energy += block[i] * block[i];

    if (energy < this.energyFloor) {
      this.run = 0;
      this.runFreq = null;
      return false;
    }

    const rms = Math.sqrt(energy / block.length);
    const peakAmp = rms * Math.SQRT2;

    // Find the strongest candidate tone in this block.
    let bestFreq = null;
    let bestRatio = 0;
    for (const f of this.candidates) {
      const p = goertzelPower(block, f, this.sampleRate);
      const amp = (2 * Math.sqrt(Math.max(p, 0))) / block.length;
      const ratio = amp / (peakAmp || 1);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestFreq = f;
      }
    }

    if (bestRatio >= this.tonalThreshold) {
      if (this.runFreq === bestFreq) this.run++;
      else {
        this.runFreq = bestFreq;
        this.run = 1;
      }
      if (this.run >= this.consecutive) {
        this.fired = true;
        return true;
      }
    } else {
      this.run = 0;
      this.runFreq = null;
    }
    return false;
  }
}

module.exports = { BeepDetector, muLawDecode };
