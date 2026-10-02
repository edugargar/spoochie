import { expect, test, afterEach } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { download, SPOOL, MAX_BYTES } from "../src/files.ts";

/** A URL like the ones Slack really sets. Since `download` checks the host, any old
 *  string no longer works, and that is the point. */
const URL_OK = "https://files.slack.com/files-pri/T1-F1/captura.png";

const real = globalThis.fetch;
afterEach(() => { globalThis.fetch = real; });

function serve(payload: Uint8Array, ok = true) {
  globalThis.fetch = (async () => ({
    ok, arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
  })) as any;
}

test("a name with ../ does not write outside the spool", async () => {
  serve(new TextEncoder().encode("hola"));
  const paths = await download("t", [{ id: "F1", name: "../../../outside.txt", url_private_download: URL_OK }], "h1");
  expect(paths.length).toBe(1);
  expect(paths[0].startsWith(join(SPOOL, "h1") + "/")).toBe(true);
  // Slashes become _, so the dots that survive lead nowhere.
  expect(paths[0].slice(join(SPOOL, "h1").length + 1)).not.toContain("/");
  expect(readFileSync(paths[0], "utf8")).toBe("hola");
});

test("the id does not sneak through either: the other side sets it too", async () => {
  serve(new TextEncoder().encode("x"));
  const paths = await download("t", [{ id: "../../../evil", name: "a.txt", url_private_download: URL_OK }], "h2");
  expect(paths.length).toBe(1);
  expect(paths[0].startsWith(join(SPOOL, "h2") + "/")).toBe(true);
  expect(existsSync(join(SPOOL, "h2"))).toBe(true);
});

test("anything over the limit never touches the disk", async () => {
  serve(new Uint8Array(MAX_BYTES + 1));
  const paths = await download("t", [{ id: "F2", name: "big.bin", url_private_download: URL_OK }], "h3");
  expect(paths).toEqual([]);
});

test("a file without a url is skipped without taking down the rest", async () => {
  serve(new TextEncoder().encode("ok"));
  const paths = await download("t", [{ id: "F3", name: "no-url.txt" }, { id: "F4", name: "with-url.txt", url_private: URL_OK }], "h4");
  expect(paths.length).toBe(1);
  expect(paths[0]).toContain("with-url.txt");
});

test("a failed download leaves no half file", async () => {
  serve(new TextEncoder().encode("x"), false);
  const paths = await download("t", [{ id: "F5", name: "a.txt", url_private_download: URL_OK }], "h5");
  expect(paths).toEqual([]);
});

/**
 * `download` sends the bot token as `Authorization` to whatever URL the message says.
 * Today the Slack API sets that field over TLS, so there was no open hole: there was a
 * function that relied on nobody calling it wrong. A URL on another host walks away with
 * the whole team's token, and that cannot be fixed afterwards.
 */
test("a non-Slack url is not fetched, even in the usual field", async () => {
  const fetched: string[] = [];
  globalThis.fetch = (async (u: any) => { fetched.push(String(u)); return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) }; }) as any;
  const paths = await download("bot-token", [
    { id: "F6", name: "a.txt", url_private_download: "https://files.slack.com.mio.example/x" },
    { id: "F7", name: "b.txt", url_private_download: "http://files.slack.com/x" },   // no TLS either
    { id: "F8", name: "c.txt", url_private_download: URL_OK },
  ], "h6");
  expect(paths.length).toBe(1);
  expect(fetched).toEqual([URL_OK]);
});

test("and the thread id is cleaned here even if it arrives clean", async () => {
  serve(new TextEncoder().encode("x"));
  const paths = await download("t", [{ id: "F9", name: "a.txt", url_private_download: URL_OK }], "../../../outside");
  expect(paths.length).toBe(1);
  // Dots can survive; slashes do not, so the ".." ends up as an ugly directory name
  // and not as a jump.
  expect(resolve(paths[0]).startsWith(resolve(SPOOL) + "/")).toBe(true);
  expect(paths[0].slice(SPOOL.length + 1).split("/").length).toBe(2);
});

/**
 * The spool of a thread that never came to exist.
 *
 * A chunk can arrive before the invite, so it waits in the spool: that is fine and
 * necessary, relays do not keep order. What nobody planned for is the invite never
 * arriving. The daemon's sweep walks the threads, and nobody looked after a thread that
 * does not exist: measured, a file from a contact sat in ~/.claude/spoochie/files/<id>/
 * forever, never showing up anywhere a person would see it. And before anyone had been
 * asked anything.
 */
test("spool left with no thread to claim it is swept; spool with a thread is not", async () => {
  const { sweepOrphans } = await import("../src/files.ts");
  const { mkdirSync, writeFileSync, utimesSync } = await import("node:fs");
  const TTL = 4 * 60 * 60 * 1000;
  const old = (Date.now() - TTL - 60_000) / 1000;

  for (const id of ["orphan", "withthread", "recent"]) {
    mkdirSync(join(SPOOL, id), { recursive: true, mode: 0o700 });
    writeFileSync(join(SPOOL, id, "x.bin"), "x", { mode: 0o600 });
  }
  utimesSync(join(SPOOL, "orphan"), old, old);
  utimesSync(join(SPOOL, "withthread"), old, old);

  const swept = sweepOrphans(id => id === "withthread", TTL);
  expect(swept).toEqual(["orphan"]);
  expect(existsSync(join(SPOOL, "orphan"))).toBe(false);
  // One with a live thread is left alone even if old: `purge` handles it on close.
  expect(existsSync(join(SPOOL, "withthread"))).toBe(true);
  // And one that just arrived is given time for its invite to show up.
  expect(existsSync(join(SPOOL, "recent"))).toBe(true);
});
