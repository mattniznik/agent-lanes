# agent-lanes

[![CI](https://github.com/mattniznik/agent-lanes/actions/workflows/ci.yml/badge.svg)](https://github.com/mattniznik/agent-lanes/actions/workflows/ci.yml) ![Node 22+](https://img.shields.io/badge/node-22%2B-339933) ![Runtime dependencies: 0](https://img.shields.io/badge/runtime%20dependencies-0-brightgreen) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

agent-lanes runs scheduled AI agent jobs with the Claude Code and Codex CLIs. A lane is one CLI with its own config folder and the credential it is meant to use. A route says which lane does a kind of work and which lane takes over when that one is unavailable, for example a Claude lane that falls back to Codex. The rules underneath keep unattended runs safe: a run cannot pick up a different credential than its lane declares, a task that already did something is never started again on another lane, guarded routes carry deny rules that the CLI itself enforces, and automatic fix runs are capped by a history file that cannot be reset by accident. It is a small Node library with a thin CLI and no runtime dependencies. It shells out to the `claude` and `codex` CLIs you already have.

Use it with credentials you are entitled to use for unattended work; for scheduled jobs that are part of a product or service, API key auth is what [Anthropic's terms](https://code.claude.com/docs/en/legal-and-compliance) point to.

## The problems it solves

Each one below is a problem, the rule that handles it, and why the rule is that one and not the obvious one.

### A lane is unavailable

**Rule.** A route lists lanes in order: `"lane": "primary", "fallback": "codex"`. Before a lane runs it is skipped if its CLI is not installed, it is not signed in, the key variable it needs is not set, or the run log says it is rate limited until a time still ahead. A lane that is refused or rate limited when it starts hands over to the next one (see the next section). The last lane in the list always gets its try, because the limit may have lifted since.

**Why.** Starting a lane that is known to be unavailable costs a process launch and returns a refusal instead of an answer. The run log already holds the reset time from the last refusal, so it is read first. Falling back to a different CLI, not a second copy of the same one, means a job can still run when one of them cannot.

### A task half-done on one lane and redone on another

**Rule.** A run hands over to the next lane only when it reported a rate limit, or a refused login, *before it used any tool*. Once any tool has run, even a read, the run ends on that lane and reports the failure.

**Why.** The obvious rule is "if it fails, retry on the next lane". But by the time an agent is refused mid-task it may already have edited files, run a migration or sent a message, and starting the same prompt from scratch on another lane can do those things twice. Counting every tool as work keeps the rule simple and errs toward not repeating anything. A run that failed for any other reason is not retried either: that is a problem with the job, not with the lane. Codex documents no rate-limit event for `codex exec --json`, so a run that reached Codex never hands over from it.

### A run uses a different credential than its lane says

**Rule.** Each lane declares its `auth`: `subscription` (the CLI's own sign-in, kept in the lane's folder) or `apiKey`, with `keyEnv` naming the variable that holds the key. Every child process gets a copy of the environment with every credential variable removed except that lane's own `keyEnv` (the list is in `src/env.mjs`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, the cloud provider switches, `OPENAI_API_KEY` and a few more), plus the lane's folder variable, `CLAUDE_CONFIG_DIR` or `CODEX_HOME`. Before a run, the CLI's own status command (`claude auth status`, `codex login status`) must report the kind of login the lane declares. A mismatch in either direction stops the whole run. Not signed in, or a key that is not set, skips to the next lane instead.

**Why.** Claude Code's documented credential order ranks environment variables such as `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` above a signed-in login, and in print mode (`-p`) a key is used whenever it is set. One forgotten `export` in a shell profile changes who is billed and which account acts, and nothing reports an error. Removing everything but the declared credential makes the config the only thing that decides. An unavailable lane is an ordinary state, and moving on is the right call. A login of the wrong kind is a configuration mistake, and moving on would hide it, so it stops in front of a person. The default lane runs with the folder variable unset, so it behaves exactly like the CLI typed in a terminal.

### An unattended run doing something it must never do

**Rule.** A route can carry guards: a `permissionMode`, `denyCommands` (each one becomes a deny rule for both the Bash and the PowerShell tool), `denyTools` (passed as written) and `strictMcp` (no MCP servers from settings). A guarded route only ever runs on Claude lanes.

**Why.** A prompt that says "never push" is a request. A deny rule is enforced by Claude Code itself, and its docs say deny rules hold in every permission mode, `bypassPermissions` included. They match the command as written, so `git push*` does not catch `git -C . push`. The example adds `git * push*` for that reason, and the rules are a seatbelt against the run's own mistakes, not a security boundary. Codex does not read Claude Code's deny rules, so a guarded route that fell back to Codex would do the same job with no guards at all. It stays on Claude, and the config check refuses a guarded route that has no Claude lane.

### An automatic fix that loops

**Rule.** `agent-lanes fix` takes the problems a monitor found and decides, for each one, whether an agent run may try to fix it. Never for a sign-in (`signin:*`), low disk (`disk`), the fixer itself (`fixer`, `run:fix`) or a key on the `humanOnly` list. At most `capPerKey` attempts per problem and `capPerDay` in all, in a sliding 24-hour window, counted from `state/fix-history.jsonl`, which is only ever appended to. Each attempt is written down before its run starts.

**Why.** Only a person can sign in, and a fix run would be refused the same way. Freeing disk space means deleting files, which is not a call to make unattended. A fixer that fixes itself can loop. The caps live in their own append-only file because any other state file can be lost or rewritten, and that must not hand the fixer a fresh budget. A sliding window means midnight does not either. Writing the attempt first means a run that crashes or gets killed still counts.

### Notifications that leak

**Rule.** Everything `fix` prints to stdout is a fixed phrase with the problem's subject, for example `Nightly build: the automatic fix could not finish, so this one needs a person.` The run's reply and any error text go to `state/fixes/` and stay on the machine.

**Why.** stdout is what gets forwarded to a chat channel or a phone. A model's reply or a raw error message can contain anything, a token copied out of a log line included. Fixed phrases rule that out by construction instead of by filtering. The problem's detail does go to the model, in the prompt, because the fix needs it.

### A long-running session whose lane becomes unavailable

**Rule.** For a session that stays open, a chat bot for example, `decideSwitch` decides when to move it to the next lane in its route and when to move it back. When its lane's login is refused or it is rate limited, the session moves at once, without waiting for quiet, since it cannot answer anyway. At most one switch every 15 minutes. Never a switch when every other lane is unavailable too: that is said once, then nothing. Back to the first lane only after 3 quiet minutes, so a reply that is being written is not cut off.

**Why.** Two lanes that both have trouble would otherwise flap between each other and restart the session every time. The refusal is read from the session's own transcript, so it is seen at the first refused turn rather than at the next scheduled job. The CLI does not use this rule; it is exported for a supervisor that keeps a session open.

## Quick start

You need Node 22 or later, and the `claude` CLI, the `codex` CLI or both on your PATH. There is nothing to install from npm.

```sh
npm test                                  # no network, no login, no model
cp lanes.example.json lanes.json          # then edit the lanes to match your setup
node bin/agent-lanes.mjs status
```

Give each lane the credential its `auth` names. Both lanes in the example are `apiKey` lanes, so set `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` in the environment the jobs run in. The status check reads `codex login status`, so sign the Codex lane in once with the form Codex's docs give, `printenv OPENAI_API_KEY | codex login --with-api-key`. A `subscription` lane is signed in with the CLI itself, and a lane whose folder is not the CLI's usual one is signed in with `CLAUDE_CONFIG_DIR` or `CODEX_HOME` pointing at that folder.

Then run something, and look at what a fix pass would do:

```sh
node bin/agent-lanes.mjs run jobs "Read logs/nightly-build.log and explain the failure"
node bin/agent-lanes.mjs fix --dry-run --problems problems.example.json
```

## Config format

`lanes.json` (start from [lanes.example.json](lanes.example.json)):

```json
{
  "lanes": {
    "primary": { "cli": "claude", "home": "~/.claude", "auth": "apiKey", "keyEnv": "ANTHROPIC_API_KEY" },
    "codex": { "cli": "codex", "home": "~/.codex", "auth": "apiKey", "keyEnv": "OPENAI_API_KEY" }
  },
  "routes": {
    "jobs": { "lane": "primary", "fallback": "codex", "permissionMode": "acceptEdits", "sandbox": "workspace-write" },
    "review": { "lane": "codex", "sandbox": "read-only" },
    "fix": {
      "lane": "primary",
      "permissionMode": "bypassPermissions",
      "strictMcp": true,
      "denyCommands": ["git push*", "git * push*", "gh *", "npm publish*", "curl *", "wget *"],
      "denyTools": ["Read(./.env)", "Read(./secrets/**)"]
    }
  },
  "fix": { "route": "fix", "capPerKey": 3, "capPerDay": 8, "humanOnly": ["task:publish-*"] }
}
```

| Key | Meaning |
| --- | --- |
| `lanes.<id>.cli` | `claude` or `codex` |
| `lanes.<id>.home` | The lane's folder; `~` is your home folder. `~/.claude` and `~/.codex` are the CLIs' usual folders and run with no folder variable set |
| `lanes.<id>.auth` | `subscription` (the CLI's own sign-in) or `apiKey`. The status check must report the same kind of login, or the run stops |
| `lanes.<id>.keyEnv` | For `apiKey` lanes only: `ANTHROPIC_API_KEY` for Claude, `OPENAI_API_KEY` for Codex. The run keeps this variable and no other credential |
| `routes.<name>.lane` | The first lane to try |
| `routes.<name>.fallback` | One lane or a list, tried in order |
| `routes.<name>.permissionMode` | Passed to `claude --permission-mode` as is |
| `routes.<name>.denyCommands` | Command patterns, `*` for any text. Each becomes a `Bash(...)` and a `PowerShell(...)` deny rule |
| `routes.<name>.denyTools` | Claude Code permission rules, passed to `--disallowedTools` as written |
| `routes.<name>.strictMcp` | `true` passes `--strict-mcp-config`, so no MCP server from settings loads |
| `routes.<name>.sandbox` | Passed to `codex exec --sandbox`. Without it Codex uses its own default, read-only |
| `fix.route` | The route fix runs use. Default `fix` |
| `fix.capPerKey`, `fix.capPerDay` | Attempts per problem and in all, per 24 hours. Default 3 and 8 |
| `fix.humanOnly` | Problem keys that never get a fix run, `*` for any text |

The example's fix route uses `bypassPermissions`, so a fix run can run the tests without anyone there to approve each command. Claude Code's docs recommend that mode for isolated machines only, and the deny rules are what stays in force under it, so keep it to a machine set aside for these jobs.

## CLI

```text
agent-lanes status
agent-lanes run <route|lane> "<prompt>" [--model <name>]
agent-lanes run <route|lane> --file prompt.md
agent-lanes fix --problems problems.json [--dry-run]
```

Run it as `node bin/agent-lanes.mjs`, or as `agent-lanes` after `npm link`. Every command takes `--config <file>` (default `./lanes.json`).

- **status** lists each lane (installed, its declared auth, whether the login matches it, rate limited by the run log), the routes, and a note when a credential variable is set in your shell.
- **run** passes the prompt to the CLI on stdin. The reply goes to stdout, one JSON summary line to stderr (`lane`, `tried`, `ok`, `sessionId`, `costUsd`, `ms`, `error`), and every change of lane is explained on stderr.
- **fix** reads a JSON list of `{ key, subject, detail, log }`. Keys look like `task:<name>`, `run:<route>`, `signin:<lane>`, `disk` or `fixer`, or anything your monitor uses. stdout gets one fixed phrase per problem and one per finished run. Pass the problems that are new: the caps are the backstop, not the schedule.

Exit codes: 0 done, 1 the run failed or no lane could run, 2 a usage or config error.

State goes in `state/` beside the config file, and is gitignored:

- `runs.jsonl` holds one row per lane run: lane, outcome, cost, duration. Never the prompt.
- `fix-history.jsonl` holds one row per fix attempt. Append-only; the caps read it.
- `fixes/` holds each fix run's reply.

## Code layout

Every rule is a pure function that takes its data and the time and returns a decision. Only `runner.mjs` starts processes; files are read and written in `store.mjs`, `cli.mjs` and `loadConfig`.

| File | What it does |
| --- | --- |
| `src/parse.mjs` | Reads stream-json events and status output into plain data |
| `src/routing.mjs` | Route order, `pickLane`, the before and after rules, the CLI arguments |
| `src/env.mjs` | The child environment: one declared credential per lane |
| `src/fix.mjs` | Which problems get a fix run, the caps, the notices, the fix prompt |
| `src/failover.mjs` | Moving a long-running session to the next lane in its route, and back |
| `src/config.mjs` | Checking `lanes.json` |
| `src/runner.mjs`, `src/store.mjs` | Starting the CLIs; reading and appending JSON Lines |
| `src/cli.mjs`, `bin/agent-lanes.mjs` | The three commands |

`src/index.mjs` exports all of it for use as a library.

## Running tests

```sh
npm test          # the same as: node --test
```

The tests never start `claude` or `codex` and need no network and no login. The event streams in `test/fixtures/` are fabricated in the shape of the CLIs' output. The command tests swap the process launcher for a fake, and the end-to-end tests start `bin/agent-lanes.mjs` with an empty PATH, so no CLI can be found. CI runs the suite on Linux and Windows with Node 22.

A note on the formats. Some of the fields this reads are documented: the `result` message, the `error` values on assistant messages, `system/api_retry`, and `claude auth status`. Two are not. The fields of `rate_limit_event`, and the transcript fields in `src/failover.mjs`, are what real runs showed. If a CLI release changes them, `src/parse.mjs` and `src/failover.mjs` are the two places to update.

## Where this came from

I took this out of the system that runs my own scheduled work. These are the parts of it that apply to anyone running AI agents unattended; everything specific to my setup is left out.

## License

MIT
