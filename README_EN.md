# codex-ocfree

**Run OpenCode's free models (`*-free` on the Zen gateway) inside Codex CLI: local protocol bridge, per-profile session isolation, and TUI model switching.**

[![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)

Full documentation (Chinese): [README.md](README.md)

## Why

- **Codex speaks the OpenAI Responses API** (`wire_api="responses"`), but the free models only answer on `/chat/completions` → a tiny local bridge converts between the two.
- **`codex --profile X` does not isolate sessions** — every profile shares `~/.codex` history by default (`sqlite_home` doesn't help). The only reliable lever is `CODEX_HOME`, so codex-ocfree gives each profile its own home under `~/.codex.d/X/` with configs symlinked back to `~/.codex`.
- **The free model pool changes** — codex-ocfree probes upstream availability and only lists models that actually answer.

## Quick start

Requirements: Node.js ≥ 22, [codex-cli](https://github.com/openai/codex) (tested on 0.157–0.158; **this profile needs no OpenAI login** — verified to work without an `auth.json`). [opencode](https://opencode.ai) is **optional**: with it the local `opencode.db` cache is used, without it metadata is fetched from [models.dev](https://models.dev) automatically.

```bash
# install (either):
bash install.sh                                 # one shot: checks + clone + link + setup
npm i -g git+https://github.com/LiuSantu123/codex-ocfree.git   # after publishing
# or manually:
git clone https://github.com/LiuSantu123/codex-ocfree.git && cd codex-ocfree && npm link
#   npm link provides both: codex-ocfree (full) / ocfree (short)
#   without npm, install.sh falls back to symlinks in ~/.local/bin

codex-ocfree setup          # one shot: profile + probe (~1 min on first run, --no-probe to skip)
                            #           + catalog + session isolation + shell wrapper
codex-ocfree up             # start the bridge
codex --profile opencode    # sessions/history isolated from plain `codex`
```

Day to day you only need `codex-ocfree up` and `codex --profile opencode`. The upstream free pool changes over time — run `codex-ocfree refresh` occasionally to update the working-model list.

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

codex-ocfree profile [add <name>] list / create isolated homes
codex-ocfree run [-p <p>] <args>  start bridge (as needed) + set CODEX_HOME + run codex
codex-ocfree shell [zsh|bash]     print the codex() wrapper snippet (defaults to $SHELL)
```

## Read before use

1. Licensed under the **[PolyForm Noncommercial License 1.0.0](LICENSE) — commercial use is not permitted.** Personal / research / hobby use, modification and redistribution are allowed with the license and Required Notice attached.
2. **Use at your own risk.** The bridge talks to OpenCode's free-model endpoint through local protocol conversion; upstream gating may change at any time. This project is not affiliated with or endorsed by OpenAI, OpenCode, or their affiliates.
3. The repository contains **no API keys or tokens**; `codex-ocfree setup` only writes files on your machine.

## License

PolyForm Noncommercial License 1.0.0 — see [LICENSE](LICENSE). The project name and logo are not covered by the license grant.

© 2026 LiuSantu123.
