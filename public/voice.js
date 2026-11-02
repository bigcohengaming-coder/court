// Live courtroom voice.
// First choice: a direct WebRTC audio connection between every pair of people in voice (one sendrecv
// transceiver each). Who may talk is decided by the server's case state; we swap the mic track in or out
// with replaceTrack, so permission changes never renegotiate.
// Fallback: when two people's networks block a direct connection, their audio goes through our own
// server instead (see audio-worklet.js). The listener decides: any speaker it can't reach directly
// within a few seconds is relayed.
(() => {
"use strict";

const DIRECT_GRACE_MS = 7000;

class CourtVoice {
  constructor(socket, hooks) {
    this.socket = socket;
    this.hooks = hooks;           // { onChange(), canSpeak(uid), me(), participants(), toast(msg) }
    this.code = null;
    this.joined = false;
    this.joining = false;
    this.peers = new Map();       // uid -> { pc, sender, audio, analyser, pending: [], createdAt }
    this.iceServers = [];
    this.mic = null;              // MediaStream
    this.selfMuted = false;
    this.ctx = null;
    this.levels = new Map();      // uid -> 0..1
    this.meterTimer = null;
    this.watchTimer = null;
    // relay state
    this.workletReady = null;     // Promise
    this.firstSeen = new Map();   // uid -> when we first saw them in voice
    this.relayFrom = new Set();   // speakers I hear through the server
    this.players = new Map();     // uid -> { node, gain, lastAt }
    this.relayTargets = 0;        // listeners who need my audio through the server
    this.capture = null;          // { node, src }
    this.lastLoudAt = 0;
    this.forceRelay = false;      // debugging: pretend every direct connection is blocked
    this.fakeMic = false;         // debugging: a tone instead of a real microphone

    socket.on("voice:peer-joined", () => {});   // the newcomer calls us; nothing to do until its offer lands
    socket.on("voice:peer-left", ({ uid }) => { this.dropPeer(uid); this.dropPlayer(uid); this.firstSeen.delete(uid); });
    socket.on("rtc:signal", msg => this.onSignal(msg).catch(e => console.warn("signal", e)));
    socket.on("voice:kicked", ({ reason }) => { this.hooks.toast(reason); this.leave(true); });
    socket.on("disconnect", () => { if (this.joined) this.leave(true); });
    socket.on("relay:targets", ({ count }) => { this.relayTargets = count || 0; this.updateCapture(); });
    socket.on("a", (from, buf) => this.onRelayAudio(from, buf));
    // Some browsers refuse to start audio until the next tap; retry playback then.
    document.addEventListener("pointerdown", () => {
      this.audioCtx();
      for (const p of this.peers.values()) if (p.audio.srcObject && p.audio.paused) p.audio.play().catch(() => {});
    });
  }

  audioCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  loadWorklet() {
    const ctx = this.audioCtx();
    if (!ctx || !ctx.audioWorklet) return Promise.resolve(false);
    if (!this.workletReady) this.workletReady = ctx.audioWorklet.addModule("/audio-worklet.js").then(() => true, e => { console.warn("worklet", e); return false; });
    return this.workletReady;
  }

  async join(code) {
    if (this.joined || this.joining) return;
    if (!window.RTCPeerConnection && !window.AudioWorkletNode) { this.hooks.toast("This browser can't do voice chat. Try Chrome, Edge, Firefox or Safari."); return; }
    this.joining = true; this.hooks.onChange();
    this.audioCtx();
    const workletPromise = this.loadWorklet();
    const res = await new Promise(r => this.socket.emit("voice:join", { code }, r));
    this.joining = false;
    if (!res || res.error) { this.hooks.toast(res?.error || "Couldn't join voice."); this.hooks.onChange(); return; }
    await workletPromise;
    this.code = code;
    this.joined = true;
    this.iceServers = res.iceServers || [];
    if (window.RTCPeerConnection && !this.forceRelay) for (const uid of res.peers) this.call(uid).catch(e => console.warn("call", e));
    this.startMeters();
    this.startWatch();
    await this.sync();
    this.hooks.onChange();
  }

  leave(silent) {
    if (!this.joined && !this.joining) return;
    if (!silent) this.socket.emit("voice:leave", {});
    for (const uid of [...this.peers.keys()]) this.dropPeer(uid);
    for (const uid of [...this.players.keys()]) this.dropPlayer(uid);
    this.stopCapture();
    if (this.mic) { this.mic.getTracks().forEach(t => t.stop()); this.mic = null; this.selfAnalyser = null; }
    this.joined = false; this.code = null;
    clearInterval(this.meterTimer); this.meterTimer = null;
    clearInterval(this.watchTimer); this.watchTimer = null;
    this.levels.clear(); this.firstSeen.clear(); this.relayFrom.clear(); this.relayTargets = 0;
    this.hooks.onChange();
  }

  // ---------- direct connections ----------
  // Outgoing call to someone who was already in voice when we joined.
  async call(uid) {
    const peer = this.makePeer(uid);
    const tr = peer.pc.addTransceiver("audio", { direction: "sendrecv" });
    peer.sender = tr.sender;
    await this.applyTrack(peer);
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    this.signal(uid, { sdp: peer.pc.localDescription });
  }

  makePeer(uid) {
    this.dropPeer(uid);
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    audio.hidden = true;
    document.body.appendChild(audio);
    const peer = { pc, sender: null, audio, analyser: null, pending: [], createdAt: Date.now() };
    this.peers.set(uid, peer);
    pc.onicecandidate = e => { if (e.candidate) this.signal(uid, { cand: e.candidate }); };
    pc.ontrack = e => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      audio.srcObject = stream;
      audio.play().catch(() => {});
      this.updateRemoteMute(uid);
      const ctx = this.audioCtx();
      if (ctx) {
        try {
          const src = ctx.createMediaStreamSource(stream);
          const an = ctx.createAnalyser(); an.fftSize = 512;
          src.connect(an); peer.analyser = an;
        } catch { /* meters are decorative */ }
      }
    };
    pc.onconnectionstatechange = () => { this.checkLinks(); this.hooks.onChange(); };
    return peer;
  }

  dropPeer(uid) {
    const p = this.peers.get(uid);
    if (!p) return;
    try { p.pc.close(); } catch {}
    p.audio.srcObject = null;
    p.audio.remove();
    this.peers.delete(uid);
    this.levels.delete(uid);
    this.hooks.onChange();
  }

  signal(to, data) { this.socket.emit("rtc:signal", { to, data: JSON.parse(JSON.stringify(data)) }); }

  async onSignal({ from, data }) {
    if (!this.joined || !data || !window.RTCPeerConnection || this.forceRelay) return;
    if (data.sdp && data.sdp.type === "offer") {
      const peer = this.makePeer(from);
      await peer.pc.setRemoteDescription(data.sdp);
      const tr = peer.pc.getTransceivers()[0];
      if (tr) { tr.direction = "sendrecv"; peer.sender = tr.sender; }
      await this.applyTrack(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      this.signal(from, { sdp: peer.pc.localDescription });
      for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
    } else if (data.sdp && data.sdp.type === "answer") {
      const peer = this.peers.get(from);
      if (!peer || peer.pc.signalingState !== "have-local-offer") return;
      await peer.pc.setRemoteDescription(data.sdp);
      for (const c of peer.pending.splice(0)) await peer.pc.addIceCandidate(c).catch(() => {});
    } else if (data.cand) {
      const peer = this.peers.get(from);
      if (!peer) return;
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(data.cand).catch(() => {});
      else peer.pending.push(data.cand);
    }
  }

  directOk(uid) {
    const p = this.peers.get(uid);
    return !this.forceRelay && !!p && p.pc.connectionState === "connected";
  }

  // ---------- relay ----------
  // Every second: anyone in voice we haven't reached directly within the grace period gets relayed.
  startWatch() {
    clearInterval(this.watchTimer);
    this.watchTimer = setInterval(() => this.checkLinks(), 1000);
  }
  checkLinks() {
    if (!this.joined) return;
    const now = Date.now(), me = this.hooks.me();
    const others = this.hooks.participants().filter(u => u !== me);
    for (const u of others) if (!this.firstSeen.has(u)) this.firstSeen.set(u, now);
    for (const u of [...this.firstSeen.keys()]) if (!others.includes(u)) this.firstSeen.delete(u);
    const want = new Set();
    for (const u of others) {
      if (this.directOk(u)) continue;
      const p = this.peers.get(u);
      const failed = p && ["failed", "closed"].includes(p.pc.connectionState);
      if (this.forceRelay || failed || now - this.firstSeen.get(u) > DIRECT_GRACE_MS) want.add(u);
    }
    const same = want.size === this.relayFrom.size && [...want].every(u => this.relayFrom.has(u));
    if (same) return;
    this.relayFrom = want;
    for (const u of [...this.players.keys()]) if (!want.has(u)) this.dropPlayer(u);
    this.socket.emit("relay:need", { uids: [...want] });
    for (const u of this.peers.keys()) this.updateRemoteMute(u);
    this.hooks.onChange();
  }

  onRelayAudio(from, buf) {
    if (!this.joined || !this.relayFrom.has(from)) return;
    const pl = this.player(from);
    if (!pl) return;
    pl.lastAt = Date.now();
    pl.node.port.postMessage(new Uint8Array(buf));
  }

  player(uid) {
    let pl = this.players.get(uid);
    if (pl) return pl;
    const ctx = this.ctx;
    if (!ctx || typeof AudioWorkletNode === "undefined") return null;
    try {
      const node = new AudioWorkletNode(ctx, "relay-player", { numberOfInputs: 0, outputChannelCount: [1] });
      const gain = ctx.createGain();
      node.connect(gain).connect(ctx.destination);
      pl = { node, gain, lastAt: 0 };
      this.players.set(uid, pl);
      this.updateRemoteMute(uid);
      return pl;
    } catch (e) { console.warn("player", e); return null; }
  }
  dropPlayer(uid) {
    const pl = this.players.get(uid);
    if (!pl) return;
    try { pl.node.disconnect(); pl.gain.disconnect(); } catch {}
    this.players.delete(uid);
  }

  // Send my mic through the server only while someone needs it and I'm allowed to talk.
  async updateCapture() {
    const need = this.joined && this.relayTargets > 0 && this.wantsMic() && this.mic;
    if (!need) { this.stopCapture(); return; }
    if (this.capture && this.capture.stream === this.mic) return;
    this.stopCapture();
    if (!(await this.loadWorklet()) || !this.mic) return;
    try {
      const ctx = this.ctx;
      const src = ctx.createMediaStreamSource(this.mic);
      // A silent path to the speakers keeps every browser pulling audio through the node.
      const node = new AudioWorkletNode(ctx, "relay-capture", { outputChannelCount: [1] });
      const silent = ctx.createGain(); silent.gain.value = 0;
      node.connect(silent).connect(ctx.destination);
      node.port.onmessage = e => {
        const { bytes, level } = e.data, now = Date.now();
        if (level > 0.008) this.lastLoudAt = now;
        // Skip silence (with a short tail) to save bandwidth.
        if (now - this.lastLoudAt < 400 && this.relayTargets > 0) this.socket.volatile.emit("a", bytes);
      };
      src.connect(node);
      this.capture = { node, src, stream: this.mic };
    } catch (e) { console.warn("capture", e); }
  }
  stopCapture() {
    if (!this.capture) return;
    try { this.capture.src.disconnect(); this.capture.node.disconnect(); this.capture.node.port.onmessage = null; } catch {}
    this.capture = null;
  }

  // ---------- permissions ----------
  // Can I be heard right now? Server permission and my own mute button both have to agree.
  wantsMic() { return this.joined && this.hooks.canSpeak(this.hooks.me()) && !this.selfMuted; }
  allowedToSpeak() { return this.joined && this.hooks.canSpeak(this.hooks.me()); }

  async ensureMic() {
    if (this.mic) return true;
    try {
      if (this.fakeMic) {
        const ctx = this.audioCtx(), osc = ctx.createOscillator(), dest = ctx.createMediaStreamDestination();
        osc.frequency.value = 330; osc.connect(dest); osc.start();
        this.mic = dest.stream;
      } else {
        if (!navigator.mediaDevices?.getUserMedia) { this.hooks.toast("This browser won't share a microphone here. The site needs https."); return false; }
        this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      }
      const ctx = this.audioCtx();
      if (ctx) {
        try {
          const an = ctx.createAnalyser(); an.fftSize = 512;
          ctx.createMediaStreamSource(this.mic).connect(an);
          this.selfAnalyser = an;
        } catch {}
      }
      return true;
    } catch (e) {
      this.hooks.toast(e && e.name === "NotAllowedError" ? "Microphone blocked. Allow it in your browser's site settings to speak." : "Couldn't find a microphone.");
      this.selfMuted = true;
      return false;
    }
  }

  async applyTrack(peer) {
    if (!peer.sender) return;
    const track = this.wantsMic() && this.mic ? this.mic.getAudioTracks()[0] : null;
    if (peer.sender.track !== track) await peer.sender.replaceTrack(track).catch(() => {});
  }

  updateRemoteMute(uid) {
    // Listeners enforce the judge's rules too: someone without the floor isn't played even if they send audio.
    const allowed = this.hooks.canSpeak(uid);
    const p = this.peers.get(uid);
    if (p) p.audio.muted = !allowed || this.relayFrom.has(uid);   // never play the same person twice
    const pl = this.players.get(uid);
    if (pl) pl.gain.gain.value = allowed ? 1 : 0;
  }

  // Call after every case-state update and after the mute button.
  async sync() {
    if (!this.joined) return;
    if (this.wantsMic()) await this.ensureMic();
    for (const p of this.peers.values()) await this.applyTrack(p);
    for (const uid of this.peers.keys()) this.updateRemoteMute(uid);
    for (const uid of this.players.keys()) this.updateRemoteMute(uid);
    if (this.mic && !this.allowedToSpeak()) {
      // Lost the floor: release the mic so the browser's recording light goes off.
      this.mic.getTracks().forEach(t => t.stop()); this.mic = null; this.selfAnalyser = null;
    }
    this.checkLinks();
    await this.updateCapture();
  }

  async toggleSelfMute() {
    this.selfMuted = !this.selfMuted;
    await this.sync();
    this.hooks.onChange();
  }

  // ---------- status ----------
  links() {
    const me = this.hooks.me(), out = { direct: 0, relay: 0, connecting: 0 };
    if (!this.joined) return out;
    for (const u of this.hooks.participants()) {
      if (u === me) continue;
      if (this.directOk(u)) out.direct++;
      else if (this.relayFrom.has(u)) out.relay++;
      else out.connecting++;
    }
    return out;
  }

  startMeters() {
    clearInterval(this.meterTimer);
    const buf = new Uint8Array(256);
    const level = an => {
      an.getByteTimeDomainData(buf);
      let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
      return Math.sqrt(sum / buf.length);
    };
    this.meterTimer = setInterval(() => {
      const me = this.hooks.me(), now = Date.now();
      for (const [uid, p] of this.peers) this.levels.set(uid, p.analyser && !p.audio.muted ? level(p.analyser) : 0);
      for (const [uid, pl] of this.players) if (now - pl.lastAt < 250 && pl.gain.gain.value > 0) this.levels.set(uid, 1);
      this.levels.set(me, this.selfAnalyser && this.wantsMic() ? level(this.selfAnalyser) : 0);
      document.querySelectorAll("[data-speaker]").forEach(el => {
        el.classList.toggle("talking", (this.levels.get(el.dataset.speaker) || 0) > 0.04);
      });
    }, 120);
  }
}

// A short wooden knock for the gavel, synthesized so there's no audio file to ship.
function knock(ctx) {
  if (!ctx) return;
  const t0 = ctx.currentTime;
  for (const [delay, gain] of [[0, 0.9], [0.18, 0.7], [0.36, 1]]) {
    const t = t0 + delay;
    const osc = ctx.createOscillator(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    osc.type = "triangle"; osc.frequency.setValueAtTime(190, t); osc.frequency.exponentialRampToValueAtTime(70, t + 0.12);
    f.type = "lowpass"; f.frequency.value = 900;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(f).connect(g).connect(ctx.destination);
    osc.start(t); osc.stop(t + 0.18);
  }
}

window.CourtVoice = CourtVoice;
window.courtKnock = knock;
})();
