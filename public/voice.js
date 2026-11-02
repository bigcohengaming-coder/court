// Live courtroom voice: a full mesh of WebRTC audio connections between everyone who joined voice.
// Each connection carries one sendrecv audio transceiver. Who may talk is decided by the server's case
// state; we swap the mic track in or out with replaceTrack, so permission changes never renegotiate.
(() => {
"use strict";

class CourtVoice {
  constructor(socket, hooks) {
    this.socket = socket;
    this.hooks = hooks;           // { onChange(), canSpeak(uid) -> bool, toast(msg) }
    this.code = null;
    this.joined = false;
    this.joining = false;
    this.peers = new Map();       // uid -> { pc, sender, audio, analyser, pending: [] }
    this.iceServers = [];
    this.mic = null;              // MediaStream
    this.selfMuted = false;
    this.ctx = null;
    this.levels = new Map();      // uid -> 0..1
    this.meterTimer = null;

    socket.on("voice:peer-joined", () => {});   // the newcomer calls us; nothing to do until its offer lands
    socket.on("voice:peer-left", ({ uid }) => this.dropPeer(uid));
    socket.on("rtc:signal", msg => this.onSignal(msg).catch(e => console.warn("signal", e)));
    socket.on("voice:kicked", ({ reason }) => { this.hooks.toast(reason); this.leave(true); });
    socket.on("disconnect", () => { if (this.joined) this.leave(true); });
  }

  audioCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  async join(code) {
    if (this.joined || this.joining) return;
    if (!window.RTCPeerConnection) { this.hooks.toast("This browser can't do voice chat. Try Chrome, Edge, Firefox or Safari."); return; }
    this.joining = true; this.hooks.onChange();
    this.audioCtx();
    const res = await new Promise(r => this.socket.emit("voice:join", { code }, r));
    this.joining = false;
    if (!res || res.error) { this.hooks.toast(res?.error || "Couldn't join voice."); this.hooks.onChange(); return; }
    this.code = code;
    this.joined = true;
    this.iceServers = res.iceServers || [];
    for (const uid of res.peers) this.call(uid);
    this.startMeters();
    await this.sync();
    this.hooks.onChange();
  }

  leave(silent) {
    if (!this.joined && !this.joining) return;
    if (!silent) this.socket.emit("voice:leave", {});
    for (const uid of [...this.peers.keys()]) this.dropPeer(uid);
    if (this.mic) { this.mic.getTracks().forEach(t => t.stop()); this.mic = null; }
    this.joined = false; this.code = null;
    clearInterval(this.meterTimer); this.meterTimer = null;
    this.levels.clear();
    this.hooks.onChange();
  }

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
    const audio = new Audio();
    audio.autoplay = true;
    audio.setAttribute("playsinline", "");
    const peer = { pc, sender: null, audio, analyser: null, pending: [] };
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
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed") {
        this.hooks.toast("A voice connection failed. Someone may be behind a strict network.");
      }
      this.hooks.onChange();
    };
    return peer;
  }

  dropPeer(uid) {
    const p = this.peers.get(uid);
    if (!p) return;
    try { p.pc.close(); } catch {}
    p.audio.srcObject = null;
    this.peers.delete(uid);
    this.levels.delete(uid);
    this.hooks.onChange();
  }

  signal(to, data) { this.socket.emit("rtc:signal", { to, data: JSON.parse(JSON.stringify(data)) }); }

  async onSignal({ from, data }) {
    if (!this.joined || !data) return;
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

  // Can I be heard right now? Server permission and my own mute button both have to agree.
  wantsMic() { return this.joined && this.hooks.canSpeak(this.hooks.me()) && !this.selfMuted; }
  allowedToSpeak() { return this.joined && this.hooks.canSpeak(this.hooks.me()); }

  async ensureMic() {
    if (this.mic) return true;
    if (!navigator.mediaDevices?.getUserMedia) { this.hooks.toast("This browser won't share a microphone here. The site needs https."); return false; }
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
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
    const p = this.peers.get(uid);
    // Listeners enforce the judge's rules too: someone without the floor isn't played even if they send audio.
    if (p) p.audio.muted = !this.hooks.canSpeak(uid);
  }

  // Call after every case-state update and after the mute button.
  async sync() {
    if (!this.joined) return;
    if (this.wantsMic()) await this.ensureMic();
    for (const p of this.peers.values()) await this.applyTrack(p);
    for (const uid of this.peers.keys()) this.updateRemoteMute(uid);
    if (this.mic && !this.allowedToSpeak()) {
      // Lost the floor: release the mic so the browser's recording light goes off.
      this.mic.getTracks().forEach(t => t.stop()); this.mic = null; this.selfAnalyser = null;
    }
  }

  async toggleSelfMute() {
    this.selfMuted = !this.selfMuted;
    await this.sync();
    this.hooks.onChange();
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
      const me = this.hooks.me();
      for (const [uid, p] of this.peers) this.levels.set(uid, p.analyser && !p.audio.muted ? level(p.analyser) : 0);
      this.levels.set(me, this.selfAnalyser && this.wantsMic() ? level(this.selfAnalyser) : 0);
      document.querySelectorAll("[data-speaker]").forEach(el => {
        el.classList.toggle("talking", (this.levels.get(el.dataset.speaker) || 0) > 0.04);
      });
    }, 120);
  }

  status(uid) {
    const p = this.peers.get(uid);
    return p ? p.pc.connectionState : null;
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
