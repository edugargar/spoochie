// Renders video.html one frame at a time.
//
// The page draws itself from a time value (`render(t)`), so every frame is the same on
// every run, with no screen recorder and no dropped frames. From this directory:
//
//   npm i --no-save playwright-core
//   python3 music.py                        writes music.wav
//   CHROME=/path/to/chrome node render.mjs  writes frames/
//   CHROME=/path/to/chrome node render.mjs 12.5 33   only those seconds, to keys/
//   ffmpeg -framerate 30 -i frames/f%05d.jpg -i music.wav -c:v libx264 -crf 23 \
//     -pix_fmt yuv420p -c:a aac -b:a 160k -shortest -movflags +faststart ../spoochie.mp4
//
// clips/ holds the stock footage as frames, cut by clips.sh.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const FPS = 30;
const keys = process.argv.slice(2).map(Number);
const b = await chromium.launch({ executablePath: process.env.CHROME });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto("file://" + process.cwd() + "/video.html");
await p.evaluate(() => document.fonts.ready);
const shot = async (t, path) => {
  await p.evaluate(t => window.render(t), t);
  await p.evaluate(() => Promise.all([...document.images].map(i => i.decode().catch(() => {}))));
  await p.screenshot({ path, type: path.endsWith(".png") ? "png" : "jpeg", ...(path.endsWith(".png") ? {} : { quality: 92 }) });
};
if (keys.length) {
  mkdirSync("keys", { recursive: true });
  for (const t of keys) await shot(t, `keys/k-${t.toFixed(1).padStart(5, "0")}.png`);
} else {
  const n = Math.round((await p.evaluate(() => window.DURATION)) * FPS);
  mkdirSync("frames", { recursive: true });
  for (let i = 0; i < n; i++) await shot(i / FPS, `frames/f${String(i).padStart(5, "0")}.jpg`);
}
await b.close();
