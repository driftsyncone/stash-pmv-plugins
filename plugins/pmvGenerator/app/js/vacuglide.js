// The Autoblow VacuGlide 2: plays the show's funscript like The Handy does (see interactive.js), through
// Autoblow's cloud API. The script is uploaded to the device as a sync script, then playback follows
// the show's clock: start at a position, stop, again on every new song.
// The device token is the one the "VacuGlide Sync" plugin keeps (its settings in Stash); the sync
// offset is the one it keeps in this browser, so both play the same.
// The VacuGlide plays speeds, not positions: every move between two points sets the motor to
// |position change| per second / 6 (600 units per second = full speed).

import { pluginConfig } from "./api.js";

const LATENCY_HOST = "https://latency.autoblowapi.com";
const SLOW_MS = 90000; // an upload can take up to 60 s

function userOffset() {
  try {
    return Number(JSON.parse(localStorage.getItem("vacuglide:offset"))) || 0;
  } catch (e) {
    return 0;
  }
}

class VacuGlide {
  constructor(token) {
    this.token = token;
    this.host = null;
    this.state = "idle"; // idle | connecting | uploading | ready | error
    this.error = "";
    this.listeners = new Set();
  }
  set(state, error = "") {
    this.state = state;
    this.error = error;
    this.listeners.forEach((f) => f(this));
  }
  async req(method, path, { body, base, timeoutMs = 15000, keepalive } = {}) {
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      const headers = { "x-device-token": this.token };
      let payload = body;
      if (body && !(body instanceof FormData)) {
        headers["Content-Type"] = "application/json";
        payload = JSON.stringify(body);
      }
      try {
        const r = await fetch((base || this.host) + path, { method, headers, body: payload, signal: ctl.signal, keepalive });
        const text = await r.text();
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch (e) {
          data = { message: text };
        }
        if (r.status === 429 && attempt < 3) {
          await new Promise((res) => setTimeout(res, 1000)); // rate limit: wait and try again
          continue;
        }
        if (!r.ok) throw new Error(r.status === 502 ? "the VacuGlide is offline (hold its mode button 2.5 s)" : data.message || data.error || "HTTP " + r.status);
        return data;
      } catch (e) {
        if (e.name === "AbortError") throw new Error("the VacuGlide didn't answer in time");
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
  }
  async connect() {
    this.set("connecting");
    const d = await this.req("GET", "/vacuglide/connected", { base: LATENCY_HOST });
    if (!d.connected) throw new Error("the VacuGlide is offline (hold its mode button 2.5 s)");
    if (d.deviceType && d.deviceType !== "vacuglide") throw new Error("the token is for a " + d.deviceType);
    const c = String(d.cluster || "");
    this.host = "https://" + (c.includes(".") ? c.replace(/^https?:\/\//, "") : c + ".autoblowapi.com");
  }
  // Half the round trip (median of 3): how much earlier the device has to run to be on time
  async latency() {
    const samples = [];
    for (let i = 0; i < 3; i++) {
      const t = performance.now();
      await this.req("GET", "/vacuglide/state");
      samples.push(performance.now() - t);
    }
    samples.sort((a, b) => a - b);
    return Math.round(samples[1] / 2);
  }
  async load(fs) {
    if (!this.host) await this.connect();
    this.set("uploading");
    const fd = new FormData();
    fd.append("file", new Blob([JSON.stringify(fs)], { type: "application/json" }), "pmv.funscript");
    await this.req("PUT", "/vacuglide/sync-script/upload-funscript", { body: fd, timeoutMs: SLOW_MS });
    const ms = Math.max(-10000, Math.min(10000, (await this.latency()) + userOffset()));
    await this.req("PUT", "/vacuglide/sync-script/offset", { body: { offsetTimeMs: ms } });
    this.set("ready");
  }
  play(sec) {
    return this.req("PUT", "/vacuglide/sync-script/start", { body: { startTimeMs: Math.max(0, Math.round(sec * 1000)) } });
  }
  stop(keepalive) {
    return this.req("PUT", "/vacuglide/sync-script/stop", { keepalive });
  }
}

// The token from VacuGlide Sync's settings, or null when there is none
export async function vacuglideToken() {
  try {
    return (await pluginConfig("vacuglideSync")).deviceToken || null;
  } catch (e) {
    return null;
  }
}

// Plays getScript()'s funscript on the VacuGlide along with clock (currentTime in seconds, paused, and the
// events "playing" / "pause"). Same shape as attachHandy: setVariant(fs) for the next song, stop() at the end.
export function attachVacuglide(clock, { token, getScript, onState } = {}) {
  const dev = new VacuGlide(token);
  let alive = true;
  let script = null; // what is loaded on the device (the object, to notice a new song)
  let loading = null;
  let sent = null; // "play" | "stop": the last command that reached the device
  let busy = false;
  let again = false;
  if (onState) dev.listeners.add((d) => alive && onState(d));

  // Sends only the latest wanted state; changes that come in meanwhile are sent right after.
  async function pump(force) {
    if (force) sent = null;
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      do {
        again = false;
        if (!alive || dev.state !== "ready") break;
        const want = clock.paused ? "stop" : "play";
        if (want === sent) continue;
        if (want === "play") await dev.play(clock.currentTime);
        else await dev.stop();
        sent = want;
      } while (again);
    } catch (e) {
      sent = null;
      if (alive) dev.set("error", e.message);
    } finally {
      busy = false;
    }
  }

  function load(fs) {
    if (!fs || !alive) return Promise.resolve();
    script = fs;
    const run = (loading || Promise.resolve()).catch(() => {}).then(async () => {
      if (!alive || script !== fs) return; // a newer song came in while waiting
      try {
        if (sent === "play") {
          await dev.stop().catch(() => {});
          sent = "stop";
        }
        await dev.load(fs);
        if (alive) pump(true);
      } catch (e) {
        if (alive) dev.set("error", e.message);
      }
    });
    loading = run;
    return run;
  }

  const onPlay = () => pump();
  const onPause = () => pump();
  clock.addEventListener("playing", onPlay);
  clock.addEventListener("pause", onPause);
  const onHide = () => {
    if (sent === "play") dev.stop(true).catch(() => {});
  };
  window.addEventListener("pagehide", onHide);

  Promise.resolve(getScript && getScript()).then(load);

  return {
    get device() {
      return dev;
    },
    // a new song in a playlist: its script goes to the device, then it goes on from the song's position
    setVariant: (fs) => load(fs),
    retry: () => {
      dev.host = null;
      return load(script);
    },
    stop() {
      alive = false;
      clock.removeEventListener("playing", onPlay);
      clock.removeEventListener("pause", onPause);
      window.removeEventListener("pagehide", onHide);
      dev.stop().catch(() => {});
    },
  };
}
