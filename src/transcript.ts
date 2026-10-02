/**
 * El transcript de un spoochie, en HTML, listo para publicarse como Artifact.
 *
 * El demonio genera el fichero; NO lo publica. Publicar un Artifact es una
 * herramienta de la sesion de Claude, no de un proceso suelto, asi que el
 * demonio deja el HTML en disco y la CLI le dice a Claude que lo publique y
 * que devuelva la URL con `spoochie transcript <id> --url <url>`.
 * El Artifact pertenece a quien abre el spoochie y se comparte con el otro lado:
 * dos transcripts del mismo hilo serian dos versiones de la misma conversacion.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./paths.ts";
import type { Thread, Msg } from "./threads.ts";

export const TRANSCRIPTS_DIR = join(ROOT, "transcripts");

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });

/** Un bloque parece codigo si la mayoria de sus lineas lo parecen. No hay forma
 *  perfecta de saberlo, pero un hook de 15 lineas puesto como prosa con <br> pierde
 *  la sangria y la monoespaciada, y deja de leerse. Ante la duda, prosa. */
function pareceCodigo(bloque: string): boolean {
  const lineas = bloque.split("\n").filter(l => l.trim());
  if (lineas.length < 2) return false;
  const pistas = /^\s{2,}\S|[{};]\s*$|=>|\b(function|const|let|var|import|export|return|async|await|if|for|class|def|interface|type)\b|^[+-]\s|^@@/;
  return lineas.filter(l => pistas.test(l)).length >= Math.ceil(lineas.length * 0.6);
}

/** El cuerpo de un mensaje: parrafos de prosa y bloques de codigo, no una sola
 *  parrafada con saltos de linea. */
function cuerpoHtml(text: string): string {
  // Un bloque cercado gana siempre: si quien escribe lo marca, se respeta.
  const partes = text.split(/```/);
  return partes.map((parte, i) => {
    if (i % 2 === 1) return `<pre class="code">${esc(parte.replace(/^\n|\n$/g, ""))}</pre>`;
    return parte
      .split(/\n\s*\n/)
      .map(b => b.trim())
      .filter(Boolean)
      .map(b => pareceCodigo(b) ? `<pre class="code">${esc(b)}</pre>` : `<p>${esc(b).replace(/\n/g, "<br>")}</p>`)
      .join("");
  }).join("");
}

function msgHtml(t: Thread, m: Msg): string {
  const mine = m.from === t.from.sessionId;
  const side = mine ? t.from : t.to;
  const who = esc(side.human ?? side.name);
  const chips = [
    m.author === "human" ? `<span class="chip">en persona</span>` : "",
    m.kind === "patch" ? `<span class="chip">parche</span>` : "",
    m.kind === "branch" ? `<span class="chip">rama</span>` : "",
    m.offTopic && m.offTopic.verdict !== "dentro"
      ? `<span class="chip warn">${esc(m.offTopic.verdict)} del asunto</span>` : "",
  ].filter(Boolean).join(" ");

  const diff = (d: string) => esc(d).split("\n").map(l =>
    l.startsWith("+") && !l.startsWith("+++") ? `<span class="add">${l}</span>`
    : l.startsWith("-") && !l.startsWith("---") ? `<span class="del">${l}</span>` : l).join("\n");

  const body = m.kind === "patch"
    ? `<pre class="diff">${diff(m.text)}</pre>`
    : m.kind === "branch"
      ? `<p><code>${esc(m.text)}</code></p>`
      : cuerpoHtml(m.text);
  const files = m.files?.length
    ? `<ul class="files">${m.files.map(f => `<li><code>${esc(f)}</code></li>`).join("")}</ul>` : "";

  return `    <article class="msg ${mine ? "a" : "b"}">
      <h2>${who} ${chips}<time>${hhmm(m.at)}</time></h2>
      ${body}${files}
    </article>`;
}

export function renderHtml(t: Thread): string {
  const ctx = [
    t.context.branch ? `<code>${esc(t.context.branch)}</code>` : null,
    t.context.sha ? `<code>${esc(t.context.sha.slice(0, 7))}</code>` : null,
    t.context.files?.length ? `${t.context.files.length} ficheros tocados` : null,
  ].filter(Boolean).join(" · ");

  const a = esc(t.from.human ?? t.from.name);
  const b = esc(t.to.human ?? t.to.name);

  return `<title>${esc(t.subject)}</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
  /* Dos canales y una espina: el hilo es el tunel, y cada mensaje cuelga del lado
     que lo dijo. Los colores no son acento y neutro, son A y B. */
  :root{
    --ground:#f1f4f6; --surface:#ffffff; --ink:#171a1d; --dim:#5d666f; --line:#dce2e8;
    --a:#1d5fbf; --a-soft:#e8f0fc; --b:#b0541f; --b-soft:#fbeee4; --warn:#8a6100; --warn-soft:#fbf2dd;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --ground:#0f1214; --surface:#171b1e; --ink:#e5eaee; --dim:#8a949d; --line:#242a2f;
      --a:#79aeff; --a-soft:#16232f; --b:#f0a069; --b-soft:#2a1e16; --warn:#dcae4e; --warn-soft:#2a2416;
    }
  }
  :root[data-theme="dark"]{
    --ground:#0f1214; --surface:#171b1e; --ink:#e5eaee; --dim:#8a949d; --line:#242a2f;
    --a:#79aeff; --a-soft:#16232f; --b:#f0a069; --b-soft:#2a1e16; --warn:#dcae4e; --warn-soft:#2a2416;
  }
  *{box-sizing:border-box}
  body{background:var(--ground);color:var(--ink);margin:0;
    font:16px/1.6 "IBM Plex Sans","Helvetica Neue",-apple-system,system-ui,sans-serif;
    -webkit-font-smoothing:antialiased}
  code,pre,time,.id{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
  main{max-width:44rem;margin:0 auto;padding:3rem 1.25rem 5rem;display:flex;flex-direction:column;gap:1.5rem}
  header.top{display:flex;flex-direction:column;gap:.5rem}
  h1{margin:0;font-size:1.6rem;line-height:1.25;font-weight:600;letter-spacing:-.015em;text-wrap:balance}
  .who{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;font-size:.85rem;color:var(--dim)}
  .who b{font-weight:500}
  .who .na{color:var(--a)} .who .nb{color:var(--b)}
  .pill{font-size:.72rem;letter-spacing:.07em;text-transform:uppercase;font-weight:500;
    border:1px solid var(--line);border-radius:2px;padding:.15rem .45rem;color:var(--dim)}
  .pill.open{color:var(--a);border-color:var(--a)}
  .pill.pending{color:var(--warn);border-color:var(--warn)}
  .pill.closed{color:var(--dim);border-color:var(--line)}
  .ctx{font-size:.82rem;color:var(--dim)}
  .ctx code{background:var(--surface);border:1px solid var(--line);border-radius:2px;padding:.05rem .3rem;font-size:.95em}

  /* La espina */
  .thread{position:relative;display:flex;flex-direction:column;gap:.9rem;padding-left:1.35rem}
  .thread::before{content:"";position:absolute;left:.32rem;top:.4rem;bottom:.4rem;width:1px;background:var(--line)}
  .msg{position:relative;background:var(--surface);border:1px solid var(--line);border-radius:3px;padding:.8rem .95rem}
  .msg::before{content:"";position:absolute;left:-1.35rem;top:1.05rem;width:.65rem;height:.65rem;
    border-radius:50%;border:2px solid var(--ground)}
  .msg.a::before{background:var(--a)} .msg.b::before{background:var(--b)}
  .msg.a{border-left:2px solid var(--a)} .msg.b{border-left:2px solid var(--b)}
  .msg h2{margin:0 0 .4rem;font-size:.85rem;font-weight:600;display:flex;align-items:center;gap:.45rem}
  .msg.a h2{color:var(--a)} .msg.b h2{color:var(--b)}
  .msg time{margin-left:auto;font-size:.75rem;font-weight:400;color:var(--dim);font-variant-numeric:tabular-nums}
  .msg p{margin:0}
  .msg>p:last-child,.msg>pre:last-child{margin-bottom:0}
  .chip{font-size:.68rem;letter-spacing:.05em;text-transform:uppercase;font-weight:500;
    border-radius:2px;padding:.1rem .35rem;background:var(--a-soft);color:var(--a)}
  .msg.b .chip{background:var(--b-soft);color:var(--b)}
  .chip.warn{background:var(--warn-soft);color:var(--warn);text-transform:none;letter-spacing:0}
  pre.diff,pre.code{overflow-x:auto;margin:.55rem 0;padding:.7rem .8rem;font-size:.82rem;line-height:1.55;
    background:var(--ground);border:1px solid var(--line);border-radius:3px;white-space:pre}
  pre.code:first-child,pre.diff:first-child{margin-top:0}
  .msg p+p{margin-top:.6rem}
  pre.diff .add{color:var(--a)} pre.diff .del{color:var(--b)}
  .files{margin:.55rem 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:.15rem;
    font-size:.8rem;color:var(--dim)}
  footer{border-top:1px solid var(--line);padding-top:.9rem;font-size:.8rem;color:var(--dim);
    display:flex;flex-wrap:wrap;gap:.6rem;align-items:baseline}
  footer .id{color:var(--ink)}
  a{color:var(--a)}
  :focus-visible{outline:2px solid var(--a);outline-offset:2px}
</style>
<main>
  <header class="top">
    <h1>${esc(t.subject)}</h1>
    <div class="who">
      <span class="pill ${esc(t.state)}">${esc(t.state)}</span>
      <b class="na">${a}</b> <span>y</span> <b class="nb">${b}</b>
    </div>
    ${ctx ? `<div class="ctx">${ctx}</div>` : ""}
  </header>
  <div class="thread">
${t.messages.map(m => msgHtml(t, m)).join("\n")}
  </div>
  <footer>
    <span class="id">spoochie ${esc(t.id)}</span>
    ${t.closeReason ? `<span>cerrado: ${esc(t.closeReason)}</span>` : "<span>en curso</span>"}
  </footer>
</main>`;
}

export const transcriptPath = (id: string) => join(TRANSCRIPTS_DIR, `${id}.html`);

/** Escribe el HTML y devuelve su ruta. La URL la pone la sesion de Claude al publicarlo. */
export function writeTranscript(t: Thread): string {
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true, mode: 0o700 });
  const p = join(TRANSCRIPTS_DIR, `${t.id}.html`);
  writeFileSync(p, renderHtml(t));
  return p;
}

/** Lo llama el demonio en cada turno. Mantiene el fichero al dia; republicar es
 *  cosa de la sesion que lo publico. */
export async function publishTranscript(t: Thread): Promise<string | null> {
  writeTranscript(t);
  return t.transcriptUrl ?? null;
}
