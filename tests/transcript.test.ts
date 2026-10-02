import { expect, test } from "bun:test";
import { renderHtml } from "../src/transcript.ts";
import type { Thread } from "../src/threads.ts";

const base: Thread = {
  id: "t1", subject: "subject",
  from: { sessionId: "A", name: "a", cwd: "/a", human: "Edu" },
  to: { sessionId: "B", name: "b", cwd: "/b", human: "Sam" },
  state: "open", createdAt: 0, lastActivityAt: 0, context: {}, messages: [],
};

test("escapes HTML in the content", () => {
  const html = renderHtml({ ...base, messages: [
    { at: 0, from: "A", author: "claude", kind: "text", text: '<img src=x onerror="alert(1)">' },
  ]});
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("&lt;img src=x");
});

test("each theme defines its colors in its own block, and body paints its own background", () => {
  const html = renderHtml(base);
  expect(html).toContain(":root{");
  expect(html).toContain("prefers-color-scheme:dark");
  expect(html).toContain(':root[data-theme="dark"]');
  expect(html).toContain(':root:not([data-theme="light"])');
  expect(html).toContain("background:var(--ground)");
});

test("marks which side each message comes from", () => {
  const html = renderHtml({ ...base, messages: [
    { at: 0, from: "A", author: "claude", kind: "text", text: "mine" },
    { at: 0, from: "B", author: "claude", kind: "text", text: "theirs" },
  ]});
  expect(html).toContain('class="msg a"');
  expect(html).toContain('class="msg b"');
});

test("highlights diff lines without breaking escaping", () => {
  const html = renderHtml({ ...base, messages: [
    { at: 0, from: "A", author: "claude", kind: "patch", text: "--- a\n+++ b\n-  <old>\n+  <new>" },
  ]});
  expect(html).toContain('<span class="del">-  &lt;old&gt;</span>');
  expect(html).toContain('<span class="add">+  &lt;new&gt;</span>');
  // The --- and +++ headers are not changes and are not highlighted.
  expect(html).not.toContain('<span class="del">--- a</span>');
});

test("the watcher notice shows as a chip and does not hide the message", () => {
  const html = renderHtml({ ...base, messages: [
    { at: 0, from: "B", author: "claude", kind: "text", text: "about lunch", offTopic: { verdict: "fuera", why: "food" } },
  ]});
  expect(html).toContain("off topic");
  expect(html).toContain("about lunch");
});

test("the title is the subject, with nothing tacked on", () => {
  expect(renderHtml({ ...base, subject: "the header collapses" })).toContain("<title>the header collapses</title>");
});

test("code inside a message renders as code, not as prose with line breaks", () => {
  const hook = `Answering with the code in front of me.

export function useSaveProfile() {
  const [saving, setSaving] = useState(false);
  async function save(data: Profile) {
    await api.post("/profile", data);
  }
  return { save, saving };
}

It returns a promise but never rejects.`;
  const html = renderHtml({ ...base, messages: [{ at: 0, from: "A", author: "claude", kind: "text", text: hook }] });
  expect(html).toContain('<pre class="code">');
  expect(html).toContain("export function useSaveProfile");
  // Prose stays prose, in separate paragraphs.
  expect(html).toContain("<p>Answering with the code in front of me.</p>");
  expect(html).toContain("<p>It returns a promise but never rejects.</p>");
});

test("a backtick-fenced block wins over the heuristic", () => {
  const html = renderHtml({ ...base, messages: [
    { at: 0, from: "A", author: "claude", kind: "text", text: "look:\n```\nhello\n```" },
  ]});
  expect(html).toContain('<pre class="code">hello</pre>');
});

test("a single sentence is not mistaken for code", () => {
  const html = renderHtml({ ...base, messages: [
    { at: 0, from: "A", author: "claude", kind: "text", text: "The await is missing and that is why the modal closes." },
  ]});
  expect(html).not.toContain("pre class=\"code\"");
});
