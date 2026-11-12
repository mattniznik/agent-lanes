// Which lane runs a job. Pure: sign-in statuses, run results and the run log come in as data.
//
// A route names a lane and a fallback list, tried in order. A lane that is signed out, not installed,
// missing its key or known to be rate limited is skipped. A run that reports a rate limit, or a
// refused login, BEFORE it used any tool hands over to the next lane. Once a tool has run, the run
// stays where it is and reports the failure: the tool may already have changed a file or sent
// something, and starting the same task again on another lane could do it twice.

import { toMs } from "./parse.mjs";

const CLAUDE_MODEL = /claude|opus|sonnet|haiku|fable/i;

/** A route's lanes in order: its lane, then its fallback, which is one lane or a list. */
export function routeLanes(route) {
  return [route?.lane, ...[].concat(route?.fallback ?? [])].filter(Boolean);
}

/**
 * The Claude flags a route's guards ask for. `denyCommands` become deny rules for both the Bash and
 * the PowerShell tool, `denyTools` are passed as written, `strictMcp` loads no MCP server from the
 * user's or project's settings. Deny rules hold in every permission mode, bypassPermissions
 * included. They match the command as written, so `git push*` does not catch `git -C . push`: a
 * seatbelt against a run's mistakes, not a security boundary.
 */
export function routeFlags(route) {
  if (!route) return [];
  const deny = [...(route.denyCommands ?? []).flatMap((c) => [`Bash(${c})`, `PowerShell(${c})`]), ...(route.denyTools ?? [])];
  return [...(route.strictMcp ? ["--strict-mcp-config"] : []), ...(deny.length ? ["--disallowedTools", ...deny] : [])];
}

/** A route with guards. Codex does not read Claude Code's deny rules and would do the same job
 * without them, so such a route only ever runs on Claude lanes. */
export const guarded = (route) => routeFlags(route).length > 0;

/** The lanes a run tries, in order, or null when `target` is neither a route nor a lane. A lane
 * named directly is tried alone. */
export function routeOrder(config, target) {
  const route = config.routes?.[target];
  if (!route) return config.lanes?.[target] ? [target] : null;
  const all = routeLanes(route);
  return guarded(route) ? all.filter((id) => config.lanes?.[id]?.cli === "claude") : all;
}

/** `claude` arguments for one run on `route`; the prompt goes on stdin. The guards come last
 * because --disallowedTools takes every argument after it. */
export function claudeArgs(route, { model } = {}) {
  return [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    ...(route?.permissionMode ? ["--permission-mode", route.permissionMode] : []),
    ...(model ? ["--model", model] : []),
    ...routeFlags(route),
  ];
}

/** `codex exec` arguments: JSON events, the route's sandbox when it names one (Codex's own default,
 * read-only, otherwise), the prompt on stdin. A Claude model name is not passed to Codex. */
export function codexArgs(route, { model } = {}) {
  return [
    "exec",
    "--json",
    ...(route?.sandbox ? ["--sandbox", route.sandbox] : []),
    ...(model && !CLAUDE_MODEL.test(model) ? ["--model", model] : []),
    "-",
  ];
}

/**
 * Before a lane runs: { step: "run" }, "skip" to the next lane, or "stop" the whole run.
 *   status    the lane's sign-in check: { ok, signedOut, missing, line }
 *   outUntil  until when the run log says it is rate limited, or null
 *   hasNext   whether another lane follows
 * Signed out, not installed or no key set is an ordinary state for a lane on a given machine, so it
 * skips. Any other failed check (a login of a different kind than the lane declares, a check that did
 * not answer) stops, so a person sees it instead of the job quietly moving on. The last lane runs even
 * when known to be rate limited: the limit may have lifted.
 */
export function beforeLane({ status = null, outUntil = null, hasNext = false }) {
  if (outUntil && hasNext) return { step: "skip", why: "rate limited" };
  if (status && !status.ok) {
    if ((status.signedOut || status.missing) && hasNext) return { step: "skip", why: status.line ?? "unavailable" };
    return { step: "stop", why: status.line ?? "the sign-in check failed" };
  }
  return { step: "run" };
}

/** After a lane ran: "done" keeps its result, "next" tries the next lane. Only a run refused before
 * it used any tool moves on. A run that failed for another reason is not retried elsewhere. */
export function afterLane(res) {
  if (!res.limited && !res.authFailed) return { step: "done", why: res.ok ? "ok" : "failed" };
  if (res.didWork) return { step: "done", why: "refused after a tool ran" };
  return { step: "next", why: res.limited ? "rate limited" : "login refused" };
}

/**
 * The next lane to run, looking from order[from] on. `inspect(id)` returns { status, outUntil } and is
 * called only until a lane is found, so a later lane's sign-in is not checked while the first one runs.
 * -> { id, index, skipped } | { id: null, stop: { id, why }, skipped } | { id: null, skipped } when
 * nothing is left. `skipped` is [{ id, why, until, next }].
 */
export function pickLane(order, inspect, from = 0) {
  const skipped = [];
  for (let i = from; i < order.length; i++) {
    const id = order[i];
    const seen = inspect(id);
    const d = beforeLane({ ...seen, hasNext: i < order.length - 1 });
    if (d.step === "skip") skipped.push({ id, why: d.why, until: seen.outUntil ?? null, next: order[i + 1] });
    else if (d.step === "stop") return { id: null, stop: { id, why: d.why }, skipped };
    else return { id, index: i, skipped };
  }
  return { id: null, skipped };
}

/**
 * The lane loop of a run, with its effects passed in:
 *   inspect(id) -> { status, outUntil }      exec(id) -> Promise<run summary>
 *   note(e)     e = { kind: "skip" | "handover" | "kept", id, why, until, next }
 * -> { res, tried, stop }. `res` is the last lane's result, null when nothing ran.
 */
export async function runRoute(order, { inspect, exec, note = () => {} }) {
  const tried = [];
  let res = null;
  let from = 0;
  for (;;) {
    const pick = pickLane(order, inspect, from);
    for (const s of pick.skipped) note({ kind: "skip", ...s });
    if (pick.stop) return { res, tried, stop: pick.stop };
    if (!pick.id) break;
    res = await exec(pick.id);
    tried.push(pick.id);
    const after = afterLane(res);
    if (after.step === "done") {
      if (after.why === "refused after a tool ran") note({ kind: "kept", id: pick.id, why: res.limited ? "rate limited" : "login refused" });
      break;
    }
    note({ kind: "handover", id: pick.id, why: after.why, next: order[pick.index + 1] ?? null });
    from = pick.index + 1;
  }
  return { res, tried, stop: null };
}

/**
 * Until when lane `id` is rate limited (ms), from the run log (oldest row first), or null. The newest
 * word wins: a run that worked after a refusal means the limit has lifted, and a run that failed for
 * another reason says nothing either way.
 */
export function knownOut(rows, id, now) {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (r?.lane !== id) continue;
    if (r.ok) return null;
    const until = toMs(r.limited?.resetsAt);
    if (until == null) continue;
    return until > now ? until : null;
  }
  return null;
}
