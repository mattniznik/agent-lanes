// The three commands. Everything that reaches outside (the environment, the clock, finding and
// starting the CLIs, the output) is passed in, so the tests drive the real commands with fakes and a
// temp folder. bin/agent-lanes.mjs passes the real ones.
//
//   <stateDir>/runs.jsonl         one row per lane run: lane, outcome, cost, time. Never the prompt.
//   <stateDir>/fix-history.jsonl  one row per fix attempt: { key, at }. Append-only; the caps read it.
//   <stateDir>/fixes/             each fix run's reply, kept on this machine

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveLane } from "./config.mjs";
import { keysSet, laneEnv, missingKey } from "./env.mjs";
import { clockOf } from "./failover.mjs";
import { decisionNotice, FIX_DEFAULTS, fixPrompt, notice, planFixes, subjectOf } from "./fix.mjs";
import { readerFor } from "./parse.mjs";
import { claudeArgs, codexArgs, guarded, knownOut, routeOrder, runRoute } from "./routing.mjs";
import { checkSignIn, findCli, runProcess } from "./runner.mjs";
import { appendJsonl, readJsonl } from "./store.mjs";

export function createLanes({
  config,
  stateDir,
  cwd = process.cwd(),
  env = process.env,
  homeDir = homedir(),
  clock = () => new Date(),
  timeZone,
  find = findCli,
  check = checkSignIn,
  spawnRun = runProcess,
  out = (line) => process.stdout.write(`${line}\n`),
  err = (line) => process.stderr.write(`${line}\n`),
}) {
  const RUNS = join(stateDir, "runs.jsonl");
  const HISTORY = join(stateDir, "fix-history.jsonl");
  const FIXES = join(stateDir, "fixes");
  const lane = (id) => resolveLane(config, id, homeDir);
  const at = (t) => clockOf(t, timeZone);

  /** Where the lane's CLI is, and its sign-in checked against its declared auth. A CLI that is not
   * installed, or an apiKey lane whose key is not set, is never started. */
  function signIn(l) {
    const exe = find(l.cli, env);
    if (!exe) return { exe, status: { ok: false, missing: true, line: `${l.cli} is not installed` } };
    const key = missingKey(l, env);
    if (key) return { exe, status: { ok: false, missing: true, line: `${key} is not set` } };
    return { exe, status: check(l, exe, laneEnv(l, env)) };
  }

  function status() {
    const now = clock().getTime();
    const rows = readJsonl(RUNS);
    out("Lanes");
    for (const id of Object.keys(config.lanes)) {
      const l = lane(id);
      const { status: st } = signIn(l);
      const until = knownOut(rows, id, now);
      out(`  ${st.ok && !until ? "OK" : "--"}  ${id.padEnd(10)} ${l.cli.padEnd(7)} ${l.auth.padEnd(13)} ${st.line}   [${config.lanes[id].home}]`);
      if (until) out(`        rate limited until ${at(until)}, by the run log`);
    }
    out("Routes");
    for (const [k, r] of Object.entries(config.routes ?? {}))
      out(`  ${k.padEnd(10)} ${routeOrder(config, k).join(" -> ")}${guarded(r) ? "   (guarded: Claude lanes only)" : ""}`);
    const keys = keysSet(env);
    if (keys.length) out(`Note: ${keys.join(", ")} set in this shell. Each lane run keeps only the one its keyEnv names.`);
  }

  const noteLine = (e) => {
    const then = e.next ? ` Moving to ${e.next}.` : " No lane left.";
    if (e.kind === "skip") return `${e.id}: ${e.why === "rate limited" ? `rate limited until ${at(e.until)}` : e.why}.${then}`;
    if (e.kind === "handover") return `${e.id}: ${e.why} before it used any tool.${then}`;
    return `${e.id}: ${e.why} after a tool ran. Not starting again on another lane, so nothing runs twice.`;
  };

  /** Run `prompt` on `target` (a route or a lane). -> runRoute's { res, tried, stop }. */
  async function run(target, prompt, { model } = {}) {
    const order = routeOrder(config, target);
    if (!order) throw new Error(`"${target}" is neither a route (${Object.keys(config.routes ?? {}).join(", ")}) nor a lane (${Object.keys(config.lanes).join(", ")})`);
    const route = config.routes?.[target] ?? null;
    const rows = readJsonl(RUNS);
    const found = new Map();
    const inspect = (id) => {
      const l = lane(id);
      const { exe, status: st } = signIn(l);
      found.set(id, { l, exe });
      return { status: st, outUntil: knownOut(rows, id, clock().getTime()) };
    };
    const exec = async (id) => {
      const { l, exe } = found.get(id);
      const t0 = clock().getTime();
      const args = l.cli === "claude" ? claudeArgs(route, { model }) : codexArgs(route, { model });
      const res = await spawnRun({ exe, args, env: laneEnv(l, env), cwd, prompt, read: readerFor(l.cli), lane: id });
      res.ms = clock().getTime() - t0;
      const { ok, limited, authFailed, didWork, sessionId, costUsd, error } = res;
      appendJsonl(RUNS, [{ at: clock().toISOString(), target, lane: id, ok, limited, authFailed, didWork, sessionId, costUsd, ms: res.ms, error }]);
      return res;
    };
    return runRoute(order, { inspect, exec, note: (e) => err(noteLine(e)) });
  }

  /**
   * One pass over the problems open now. stdout gets one fixed phrase per problem and one per finished
   * run; the run's reply goes to <stateDir>/fixes/. `dryRun` prints the decisions and the prompts and
   * records and starts nothing. -> { plan, ran: [{ key, ok }] }
   */
  async function fix(problems, { dryRun = false } = {}) {
    const opts = { ...FIX_DEFAULTS, ...config.fix };
    if (!config.routes?.[opts.route]) throw new Error(`no route "${opts.route}" for fix runs`);
    const { plan, attempts } = planFixes(problems, readJsonl(HISTORY), clock(), opts);
    if (dryRun) {
      for (const { problem, decision } of plan) {
        const subject = subjectOf(problem);
        out(decision.ok ? `${subject}: would start an automatic fix on route "${opts.route}".` : decisionNotice(decision, subject, opts));
        if (decision.ok) out(`----- prompt -----\n${fixPrompt(problem)}\n------------------`);
      }
      out("Dry run: nothing recorded, nothing started.");
      return { plan, ran: [] };
    }
    appendJsonl(HISTORY, attempts); // before any run starts, so a crashed run still counts
    const ran = [];
    for (const { problem, decision } of plan) {
      const subject = subjectOf(problem);
      out(decisionNotice(decision, subject, opts));
      if (!decision.ok) continue;
      const { res, stop } = await run(opts.route, fixPrompt(problem));
      const ok = !stop && !!res?.ok;
      mkdirSync(FIXES, { recursive: true });
      const name = `${clock().toISOString().replace(/[:.]/g, "-")}-${String(problem.key).replace(/[^\w-]+/g, "-").slice(0, 40)}.md`;
      writeFileSync(join(FIXES, name), `# ${subject}\n\nlane: ${res?.lane ?? "none"}\nok: ${ok}\nerror: ${stop?.why ?? res?.error ?? ""}\n\n${res?.text ?? ""}\n`);
      out(notice(ok ? "done" : "failed", subject, opts));
      ran.push({ key: problem.key, ok });
    }
    return { plan, ran };
  }

  return { status, run, fix };
}
