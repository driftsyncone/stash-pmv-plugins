// Songs kept in Stash: the sound files in "PMV Generator/Songs" of the first video library (where "Music from a
// video" saves them with "Also keep the sound as a file", or where you put your own). The backend lists them and
// hands one out piece by piece, like an extracted sound.

import { gql } from "./api.js";

async function run(plugin, args) {
  const d = await gql(`mutation($p: ID!, $a: Map) { runPluginOperation(plugin_id: $p, args: $a) }`, { p: plugin, a: args });
  const out = d.runPluginOperation;
  if (!out) throw new Error("No answer from the PMV Generator backend – is Python in the PATH?");
  if (out.error) throw new Error(out.error);
  return out.output || out;
}

// → { dir, songs: [{ path, name, size, mtime }] }, newest first
export const listStashSongs = (plugin = "pmvGenerator") => run(plugin, { mode: "songs_list" });

const TYPES = { m4a: "audio/mp4", aac: "audio/aac", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg", flac: "audio/flac", weba: "audio/webm" };

// One song as a File, ready for the beat detection. onProgress(0..1) while it comes in.
export async function openStashSong(path, { plugin = "pmvGenerator", onProgress = () => {} } = {}) {
  onProgress(0);
  const r = await run(plugin, { mode: "song_open", path });
  const parts = [];
  let offset = 0;
  for (;;) {
    const c = await run(plugin, { mode: "audio_chunk", id: r.id, offset });
    const bin = atob(c.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    parts.push(bytes);
    offset += bytes.length;
    onProgress(Math.min(1, offset / (c.size || r.size || 1)));
    if (c.last || !bytes.length) break;
  }
  const type = TYPES[r.ext] || "audio/mpeg";
  return new File(parts, `${r.name}.${r.ext}`, { type });
}
