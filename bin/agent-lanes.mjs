#!/usr/bin/env node
// agent-lanes: run scheduled agent jobs on the Claude Code and Codex CLIs, with fallback between lanes.
//
//   agent-lanes status                                 every lane: installed, right credential, rate limited?
//   agent-lanes run <route|lane> "<prompt>"            run on the route's first lane that is ready
//   agent-lanes run <route|lane> --file prompt.md [--model <name>]
//   agent-lanes fix --problems problems.json [--dry-run]
//
// Every command takes --config <file> (default ./lanes.json). The run log and the fix history go in
// a state/ folder beside the config file. Exit codes: 0 done, 1 the run failed or nothing could run,
// 2 a usage or config error.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { createLanes } from "../src/cli.mjs";
import { loadConfig } from "../src/config.mjs";

const USAGE = `usage:
  agent-lanes status                                         [--config lanes.json]
  agent-lanes run <route|lane> "<prompt>" [--model <name>]   [--config lanes.json]
  agent-lanes run <route|lane> --file <prompt.md>            [--config lanes.json]
  agent-lanes fix --problems <problems.json> [--dry-run]     [--config lanes.json]`;

class UsageError extends Error {}

async function main(argv) {
  const { values: o, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      file: { type: "string" },
      model: { type: "string" },
      problems: { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (o.help || !cmd) {
    console.log(USAGE);
    return o.help ? 0 : 2;
  }
  if (!["status", "run", "fix"].includes(cmd)) throw new UsageError(`unknown command "${cmd}"`);
  const file = resolve(o.config ?? "lanes.json");
  if (!existsSync(file)) throw new UsageError(`no config at ${file} - copy lanes.example.json to lanes.json, or pass --config`);
  const lanes = createLanes({ config: loadConfig(file), stateDir: join(dirname(file), "state") });

  if (cmd === "status") {
    lanes.status();
    return 0;
  }
  if (cmd === "run") {
    const [target, ...words] = rest;
    if (!target) throw new UsageError("run needs a route or a lane");
    const prompt = o.file ? readFileSync(o.file, "utf8") : words.join(" ");
    if (!prompt.trim()) throw new UsageError("no prompt: pass it as text or with --file");
    const { res, tried, stop } = await lanes.run(target, prompt, { model: o.model });
    if (stop) console.error(`${stop.id}: ${stop.why}. Stopped here; check it with: agent-lanes status`);
    if (!res) {
      if (!stop) console.error(`No lane could run "${target}".`);
      return 1;
    }
    if (res.text) process.stdout.write(`${res.text.trimEnd()}\n`);
    const { lane, ok, sessionId, costUsd, ms, error } = res;
    console.error(JSON.stringify({ lane, tried, ok: ok && !stop, sessionId, costUsd, ms, error }));
    return ok && !stop ? 0 : 1;
  }
  if (!o.problems) throw new UsageError("fix needs --problems <file>, a JSON list of { key, subject, detail, log }");
  const problems = JSON.parse(readFileSync(o.problems, "utf8"));
  if (!Array.isArray(problems) || problems.some((p) => !p?.key)) throw new UsageError("the problems file must be a JSON list, each item with a key");
  const { ran } = await lanes.fix(problems, { dryRun: !!o["dry-run"] });
  return ran.every((r) => r.ok) ? 0 : 1;
}

// Anything thrown is a usage or config problem found before a run: a failed run is a result, not an
// exception (runner.mjs never rejects).
main(process.argv.slice(2)).then(
  (code) => (process.exitCode = code),
  (e) => {
    console.error(`agent-lanes: ${e.message}`);
    if (e instanceof UsageError) console.error(USAGE);
    process.exitCode = 2;
  },
);
