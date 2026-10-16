// Beat bar over the show: the "Beat Bar" Stash plugin's themes (classic, angular, neon …) drawn from the beats
// of the show – the funscript's strokes when a funscript plays (its bottoms, like Beat Bar does), else the
// song's beats. The themes come from that plugin (its JavaScript, which registers window.BeatBarThemes), and so do
// its settings (size, opacity, look-ahead, BPM, tempo colours) and the theme picked on its bar in this browser.
// Drawn either on a layer of its own over the picture, or into the picture (then it is in the recording too).

import { pluginConfig } from "./api.js";

const THEMES_URL = "/plugin/beatBar/javascript";
let loading = null;

// true once the themes are there (false: the Beat Bar plugin isn't installed or enabled)
export function loadBeatBarThemes() {
  if (window.BeatBarThemes && Object.keys(window.BeatBarThemes).length) return Promise.resolve(true);
  if (!loading) {
    loading = new Promise((res) => {
      const s = document.createElement("script");
      s.src = THEMES_URL;
      s.onload = () => res(!!(window.BeatBarThemes && Object.keys(window.BeatBarThemes).length));
      s.onerror = () => res(false);
      document.head.appendChild(s);
    }).then((ok) => {
      if (!ok) loading = null; // try again next time
      return ok;
    });
  }
  return loading;
}

// Beat times (seconds) of a funscript: the bottoms of its strokes
export function strokeBeats(fs) {
  const a = ((fs && fs.actions) || []).slice().sort((p, q) => p.at - q.at);
  const out = [];
  for (let i = 0; i < a.length; i++) {
    const prev = a[i - 1], next = a[i + 1];
    if ((!prev || a[i].pos <= prev.pos) && (!next || a[i].pos < next.pos) && (prev || next)) out.push(a[i].at / 1000);
  }
  return out;
}

function hexRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function mix(a, b, k) {
  const x = hexRgb(a), y = hexRgb(b);
  if (!x || !y) return a;
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
const heatOf = (gap) => (isFinite(gap) ? Math.max(0, Math.min(1, (0.75 - gap) / 0.5)) : 0); // 80 BPM → 0, 240 BPM → 1
const num = (v, d, lo, hi) => {
  const n = parseFloat(v);
  return isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : d;
};

// Beat Bar's settings as it reads them (its plugin settings, plus the theme picked on the bar in this browser)
export async function beatBarSettings() {
  let st = {};
  try {
    st = await pluginConfig("beatBar");
  } catch (e) { /* defaults */ }
  let picked = "";
  try {
    picked = JSON.parse(localStorage.getItem("beatBar:theme") || '""');
  } catch (e) { /* none */ }
  return {
    theme: picked || String(st.theme || "").trim().toLowerCase() || "classic",
    size: num(st.size, 100, 40, 250) / 100,
    lookahead: num(st.lookahead, 0, 0.5, 8),
    opacity: num(st.opacity, 100, 10, 100) / 100,
    bpm: !st.hideBpm,
    tempo: !st.noTempoColors,
  };
}

export class BeatBar {
  constructor(cfg, beats) {
    this.cfg = cfg;
    this.setBeats(beats);
  }
  setBeats(beats) {
    this.beats = (beats || []).slice().sort((a, b) => a - b);
  }
  theme() {
    const all = window.BeatBarThemes || {};
    return all[this.cfg.theme] || all.classic || Object.values(all)[0] || null;
  }
  // bar height for a picture this tall
  height(pictureH) {
    const th = this.theme();
    return th ? Math.round(th.height(pictureH) * this.cfg.size) : 0;
  }
  first(t) {
    const b = this.beats;
    let lo = 0, hi = b.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (b[mid] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
  // Draws the bar into ctx's rectangle (x, y, W, H) for song time t (seconds)
  draw(ctx, x, y, W, H, t) {
    const th = this.theme();
    if (!th || !W || !H) return;
    const beats = this.beats;
    const scale = this.cfg.lookahead ? this.cfg.lookahead / th.ahead : 1;
    const ahead = th.ahead * scale, behind = th.behind * scale;
    const list = [];
    for (let i = this.first(t - behind), to = this.first(t + ahead); i < to; i++) {
      const gap = i + 1 < beats.length ? beats[i + 1] - beats[i] : i > 0 ? beats[i] - beats[i - 1] : Infinity;
      list.push({ t: beats[i], dt: beats[i] - t, gap, heat: heatOf(gap), i });
    }
    const n = this.first(t);
    const last = n > 0 ? beats[n - 1] : null, next = n < beats.length ? beats[n] : null;
    const c = th.colors || {};
    const view = {
      W, H, t, beats: list, ahead, behind,
      pulse: last === null ? 0 : Math.exp(-(t - last) * 9),
      progress: last !== null && next !== null ? (t - last) / (next - last) : 0,
      colors: c,
      heatColor: (b, base = c.marker, hot = c.hot) => (this.cfg.tempo && hot ? mix(base, hot, b.heat) : base),
      mix,
    };
    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.clip();
    ctx.globalAlpha = this.cfg.opacity;
    try {
      th.draw(ctx, view);
    } catch (e) {
      console.warn("[PMV Generator] beat bar theme", e);
    }
    if (this.cfg.bpm) {
      const gaps = [];
      for (let i = Math.max(1, this.first(t - 4)); i < Math.min(beats.length, this.first(t + 4)); i++) gaps.push(beats[i] - beats[i - 1]);
      if (gaps.length > 2) {
        gaps.sort((a, b) => a - b);
        const bpm = Math.round(60 / gaps[gaps.length >> 1]) + " BPM";
        const fs = Math.max(11, Math.round(H * 0.2));
        ctx.globalAlpha = this.cfg.opacity;
        ctx.font = `700 ${fs}px system-ui, sans-serif`;
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.strokeText(bpm, W - 8, 2);
        ctx.fillStyle = "rgba(255,255,255,0.9)";
        ctx.fillText(bpm, W - 8, 2);
      }
    }
    ctx.restore();
  }
}
