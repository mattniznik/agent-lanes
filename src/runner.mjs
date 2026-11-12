// Starting the CLIs. The only file that spawns claude or codex; the tests replace every function here.

import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { join } from "node:path";

import { claudeStatusOf, codexStatusOf, finishSummary, newSummary, parseLine } from "./parse.mjs";

/** The CLI's executable on PATH, or null. On Windows only an .exe counts: Node will not spawn a .cmd
 * without a shell, and a shell would parse the arguments a second time. */
export function findCli(name, env, platform = process.platform) {
  const win = platform === "win32";
  const path = Object.entries(env).find(([k]) => k.toUpperCase() === "PATH")?.[1] ?? "";
  for (const dir of path.split(win ? ";" : ":").filter(Boolean)) {
    const file = join(dir, win ? `${name}.exe` : name);
    try {
      if (statSync(file).isFile()) return file;
    } catch {
      // not in this folder
    }
  }
  return null;
}

/** A lane's sign-in, from the CLI's own status command run in the lane's environment, checked
 * against the auth the lane declares. */
export function checkSignIn(lane, exe, env, timeout = 30_000) {
  const args = lane.cli === "claude" ? ["auth", "status"] : ["login", "status"];
  const r = spawnSync(exe, args, { env, encoding: "utf8", timeout, windowsHide: true });
  const seen = { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", timedOut: r.error?.code === "ETIMEDOUT" };
  return lane.cli === "claude" ? claudeStatusOf(seen, lane.auth) : codexStatusOf(seen, lane.auth);
}

/**
 * One run: `exe args` in `env`, the prompt on stdin, every stdout line read as an event with
 * `read(event, summary)`. stderr passes through. Resolves with the finished summary; never rejects.
 */
export function runProcess({ exe, args, env, cwd, prompt, read, lane }) {
  return new Promise((done) => {
    const s = newSummary(lane);
    let finished = false;
    let held = "";
    const take = (line) => {
      const ev = parseLine(line);
      if (ev) read(ev, s);
    };
    const finish = (code) => {
      if (finished) return;
      finished = true;
      done(finishSummary(s, code));
    };
    const child = spawn(exe, args, { env, cwd, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      held += chunk;
      let i;
      while ((i = held.indexOf("\n")) >= 0) {
        take(held.slice(0, i));
        held = held.slice(i + 1);
      }
    });
    child.on("error", (e) => {
      s.isError = true;
      s.error = e.message;
      finish(null);
    });
    child.on("close", (code) => {
      take(held);
      finish(code);
    });
    child.stdin.on("error", () => {}); // the CLI may exit before it reads all of the prompt
    child.stdin.end(prompt);
  });
}
