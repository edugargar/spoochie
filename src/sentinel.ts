/**
 * The sentinel: checks that the aside Claude answered through the tunnel before going quiet.
 *
 * Why it exists. The aside has one job: read the repo and answer with
 * `spoochie say`. If it ends its turn without doing that (because it decided the question
 * wasn't its business, because the gatekeeper cut something off and it gave up, or because
 * it just talked to the window), nothing visible happens: the person sees a still window and
 * the other side sees silence until the 10-minute clock closes the spoochie. Nobody
 * learns there was an answer that never went out.
 *
 * It is a `Stop` hook. It looks at the thread on disk: if the last message is from the other
 * side, we haven't answered, and it blocks the stop with the reason. Only once per
 * turn: if Claude Code says we already blocked (`stop_hook_active`), it lets it through,
 * because an aside stuck in a loop is worse than a quiet aside.
 */
import * as T from "./threads.ts";

export type Decision = { decision?: "block"; reason?: string };

/** The decision itself, with the thread already loaded. Split out so it can be tested without files. */
export function judgeTurn(t: T.Thread | null, sessionId: string, alreadyBlocked: boolean): Decision {
  if (!t) return {};
  if (t.state !== "open") return {};
  if (alreadyBlocked) return {};

  const mine = T.mySide(t, sessionId).sessionId;
  // Only messages that actually got in count: one held by the watcher isn't
  // waiting for an answer, it's waiting for its human to release it.
  const delivered = t.messages.filter(m => m.retenido !== "si" && m.retenido !== "descartado");
  const last = delivered[delivered.length - 1];
  if (!last || last.from === mine) return {};

  return {
    decision: "block",
    reason: `You haven't answered through the tunnel yet. The last message in spoochie ${t.id} is from the other side and is still waiting.`
      + ` Answer with:  spoochie say ${t.id} "<text>"  (or --file <path> if it's long).`
      + ` If you can't answer what they ask, say so through the tunnel anyway and close with:  spoochie close ${t.id} --reason "..."`
      + ` What you write here never leaves this window.`,
  };
}

/** The whole hook, from Claude Code's input to the decision. */
export function sentinel(input: unknown, id: string | undefined, sessionId: string | undefined): Decision {
  if (!id || !sessionId) return {};
  const e = input as { stop_hook_active?: boolean } | null;
  return judgeTurn(T.load(id), sessionId, Boolean(e?.stop_hook_active));
}
