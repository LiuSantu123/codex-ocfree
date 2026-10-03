# codex-ocfree

**Run OpenCode's free models (`*-free` on the Zen gateway) inside Codex CLI and other mainstream agents: local protocol bridge (three protocol endpoints), per-profile session isolation, a helper console, and TUI model switching.**

[![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![release](https://img.shields.io/github/v/release/LiuSantu123/codex-ocfree)](https://github.com/LiuSantu123/codex-ocfree/releases)

Full documentation (Chinese): [README.md](README.md)

## Why

- **Codex speaks the OpenAI Responses API** (`wire_api="responses"`), but the free models only answer on `/chat/completions` → a tiny local bridge converts between the two. The same port also speaks **OpenAI Chat** (`/v1/chat/completions`) and **Anthropic Messages** (`/v1/messages` + `count_tokens`), so any compatible client connects directly — all with the upstream gate headers/body handled and local usage accounting.
- **Other agents can share the bridge too** — `codex-ocfree helper configure <agent>` points codex / Claude Code / dsh / opencode at the local bridge (original values snapshotted and restorable via `helper reset`); trae / zcode get GUI instruction cards; seven more agents are detect-only.
- **`codex --profile X` does not isolate sessions** — every profile shares `~/.codex` history by default (`sqlite_home` doesn't help). The only reliable lever is `CODEX_HOME`, so codex-ocfree gives each profile its own home under `~/.codex.d/X/` with configs symlinked back to `~/.codex`.
- **The free model pool changes** — codex-ocfree probes upstream availability and only lists models that actually answer.
- **No official quota numbers exist** — the upstream returns no rate-limit headers, so `codex-ocfree quota` shows an honest local estimate (requests/tokens today, 5h window vs a community-measured ~200/5h reference, 429 hits), and the bridge injects the same figures into the system message so you can just ask the model “how much quota is left” in chat.

## Quick start

Requirements: Node.js ≥ 22, [codex-cli](https://github.com/openai/codex) (tested on 0.157–0.158; **this profile needs no OpenAI login** — verified to work without an `auth.json`). [opencode](https://opencode.ai) is **optional**: with it the local `opencode.db` cache is used, without it metadata is fetched from [models.dev](https://models.dev) automatically.

```bash
# install (pick one; A recommended)
# A. clone + one shot: environment checks + link commands + setup
git clone https://github.com/LiuSantu123/codex-ocfree.git && cd codex-ocfree && bash install.sh

# B. release asset: no clone, no npm registry (tgz attached to the release)
npm i -g --allow-remote=all https://github.com/LiuSantu123/codex-ocfree/releases/download/v0.3.0/codex-ocfree-0.3.0.tgz && codex-ocfree setup

# C. straight from npm, GitHub source
npm i -g --allow-git=all git+https://github.com/LiuSantu123/codex-ocfree.git && codex-ocfree setup
#   B/C give you both commands: codex-ocfree (full) / ocfree (short)

codex-ocfree up             # start the bridge
codex --profile opencode    # sessions/history isolated from plain `codex`
```

`setup` = write the profile + probe available models (~1 min first run, `--no-probe` to skip) + build the catalog + install session isolation + shell wrapper; `install.sh` (A) already runs it. Machines without npm fall back to `~/.local/bin` symlinks.

> npm ≥ 12 disables git sources and remote tarballs by default (`allow-git` / `allow-remote` = `none`, supply-chain hardening) — hence the `--allow-*` flags on B/C (unneeded on npm ≤ 11). Alternatively download the tgz and install the local file: `npm i -g ./codex-ocfree-0.3.0.tgz` (local files need no flags).

Day to day you only need `codex-ocfree up` and `codex --profile opencode`. The upstream free pool changes over time — run `codex-ocfree refresh` occasionally to update the working-model list. For other agents, use the helper console:

```bash
codex-ocfree helper list                 # what's installed / configured on this machine
codex-ocfree helper configure opencode   # point an agent at the local bridge (auto-backup first)
```

Then open a new terminal (or `source ~/.bashrc` / `source ~/.zshrc`) so the injected `codex()` wrapper can switch `CODEX_HOME` automatically. The wrapper is installed into the rc file matching `$SHELL` — **both bash and zsh are supported** (each with its own array-indexing syntax); use `--shell bash|zsh` to force one.

## Commands

```
codex-ocfree setup [profile]      one-shot install (default profile: opencode)
codex-ocfree init [profile]       install session isolation only (bash/zsh wrapper, idempotent)
codex-ocfree doctor               health checks

codex-ocfree up|down|status       manage the bridge (pid/log in ~/.codex-ocfree/)
codex-ocfree serve                run the bridge in the foreground

codex-ocfree models               TUI picker for the default model
codex-ocfree use <slug> [-p <p>]  set the default model
codex-ocfree refresh [--all]      re-probe availability + rebuild the catalog
codex-ocfree quota [usage]        approximate free-tier usage (local counts + ~200 req/5h reference + 429 hits)

codex-ocfree profile [add <name>] list / create isolated homes
codex-ocfree run [-p <p>] <args>  start bridge (as needed) + set CODEX_HOME + run codex
codex-ocfree shell [zsh|bash]     print the codex() wrapper snippet (defaults to $SHELL)

codex-ocfree helper               interactive wizard (TTY; equals list otherwise)
codex-ocfree helper list [--json] detect 13 agents: installed / configured / config path / protocol
codex-ocfree helper configure <a> point at the bridge: codex claude-code dsh opencode (trae/zcode print GUI cards)
codex-ocfree helper reset <a>     remove only what we injected, restore prior values
```

### Helper console (multi-agent)

| agent | support | what `configure` does |
|---|---|---|
| **codex** | full | writes the `opencode.config.toml` profile + session isolation |
| **claude-code** | full, surgical | touches exactly three `env` keys in `~/.claude/settings.json` (`ANTHROPIC_BASE_URL` → local bridge, `ANTHROPIC_AUTH_TOKEN` placeholder, `ANTHROPIC_MODEL` → current free slug); everything else untouched |
| **dsh** | full | injects `llm-pi-ai.providers.ocfree` + `agent-default-model` into `~/.dsh/cordis.patch.yml` (loader patch **array** — the format dsh 0.2.0-rc.2 actually reads; `settings.yaml` is ignored by the boot path) and writes the `OCFREE_API_KEY` credential to `~/.dsh/.env` |
| **opencode** | full | adds `provider.ocfree` to `~/.config/opencode/opencode.json` (your default model is **not** changed; pick it via `/models` or `-m ocfree/<id>`) |
| **trae** | guide card | config lives in encrypted `state.vscdb` → GUI-only; prints URL/key/model steps |
| **zcode** | guide card | schema drifts across versions and isn't installed locally → prints a paste-ready JSON snippet, never writes files |
| 7 more (cursor, grok, …) | detect-only | reported by `helper list`; `configure` refuses them |

Safety: every configure snapshots the original file into `~/.codex-ocfree/backups/` and records per-key prior values in `helper-state.json`; `reset` removes only the injected entries and restores those values; re-running `configure` is idempotent. Verified in isolated homes: full claude-code change→restore→idempotent cycles, three dsh file shapes, opencode/codex inject+restore, and that guide cards never touch the filesystem.

### Daily quota display

The upstream sends **no rate-limit headers** (verified: only `x-opencode-*` metadata) and publishes no official numbers, so every figure is a local estimate:

- Each request that reaches upstream (chat + probes) is appended to `~/.codex-ocfree/usage.jsonl` (30-day retention).
- `codex-ocfree quota` shows today / 5h-window / yesterday counts, tokens, per-model mix and quota-hit events (429 `FreeUsageLimitError`).
- The bridge injects a one-line `[free-tier usage — local estimate] …` note into the system message, so you can ask the model directly in codex (the note appears once at least one request has been recorded).
- The `~200 requests / 5h` reference is community-measured ([opencode#33495](https://github.com/anomalyco/opencode/issues/33495)), not official — tune with `OC2C_LIMIT_5H=<n>` or `0` to hide the bars.

## Read before use

1. Licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE) — commercial use is not permitted.** Personal / research / hobby use, modification and redistribution are allowed with the license and Required Notice attached.
2. **Use at your own risk.** The bridge talks to OpenCode's free-model endpoint through local protocol conversion; upstream gating may change at any time. This project is not affiliated with or endorsed by OpenAI, OpenCode, or their affiliates.
3. The repository contains **no API keys or tokens**; `codex-ocfree setup` only writes files on your machine.

## License

PolyForm Noncommercial License 1.0.0 — see [LICENSE](LICENSE). The project name and logo are not covered by the license grant.

© 2026 LiuSantu123.
