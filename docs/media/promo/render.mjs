// Renders video.html to docs/media/spoochie.mp4, one frame at a time.
//
// The page draws itself from a time value (`render(t)`), so every frame is the same on
// every run, with no screen recorder and no dropped frames. From this directory:
//
//   npm i --no-save playwright-core
//   CHROME=/path/to/chrome node render.mjs
//   ffmpeg -framerate 30 -i frames/f%05d.jpg -c:v libx264 -crf 20 -pix_fmt yuv420p \
//     -movflags +faststart ../spoochie.mp4
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const FPS = 30;
const b = await chromium.launch({ executablePath: process.env.CHROME });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto("file://" + process.cwd() + "/video.html");
await p.evaluate(() => document.fonts.ready);
const n = Math.round((await p.evaluate(() => window.DURATION)) * FPS);
mkdirSync("frames", { recursive: true });
for (let i = 0; i < n; i++) {
  await p.evaluate(t => window.render(t), i / FPS);
  await p.screenshot({ path: `frames/f${String(i).padStart(5, "0")}.jpg`, type: "jpeg", quality: 92 });
}
await b.close();
