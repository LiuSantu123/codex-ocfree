# codex-ocfree

**把 OpenCode 的免费模型（Zen 网关 `*-free`）接进 Codex CLI 与主流 Agent：本地协议桥（三协议端点）+ 按 profile 隔离会话 + helper 中控台 + 终端 TUI 切模型。**

[![license](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen.svg)](https://nodejs.org)
[![platform](https://img.shields.io/badge/platform-Linux%20%7C%20macOS-lightgrey.svg)](#)
[![release](https://img.shields.io/github/v/release/LiuSantu123/codex-ocfree)](https://github.com/LiuSantu123/codex-ocfree/releases)

> English: [README_EN.md](README_EN.md)

```
codex --profile opencode
   │  OpenAI Responses API (wire_api="responses", SSE)
   ▼
本地桥  127.0.0.1:8973/v1/responses          ← codex-ocfree up
        ├─ /v1/chat/completions   OpenAI 兼容（dsh / opencode / 其它客户端）
        ├─ /v1/messages           Anthropic 兼容（Claude Code / zcode 等）
        │    └─ /v1/messages/count_tokens
        └─ /v1/models             双格式模型列表
   │  chat/completions (SSE) + 网关门禁 headers/body
   ▼
https://opencode.ai/inference/openai/v1/chat/completions   ← OpenCode Zen 免费模型
```

## ⚠️ 使用前必读

1. **本项目以 [PolyForm Noncommercial 1.0.0](LICENSE) 授权：禁止任何商业用途**；个人学习 / 研究 / 爱好项目可自由使用、修改、分发（保留许可证与 Required Notice）。详见[许可](#许可)。
2. **上游风险自担**：桥通过本地转换访问 OpenCode 的免费模型端点，上游随时可能调整门禁或收紧访问。本项目与 OpenAI、OpenCode 及其关联方**无任何从属或背书关系**。
3. **仓库不含任何 API key / token**；`codex-ocfree setup` 只在你的机器本地生成配置文件。
4. 免费模型池会变（实测：34 个 `*-free` 中当时只有 6 个真正可用），目录会随 `codex-ocfree refresh` 更新。

## 功能

| | 说明 |
|---|---|
| **协议桥** | Codex 只认 `wire_api="responses"`，免费模型只认 `/chat/completions` — 本地无依赖桥做双向转换（Node ≥22，零第三方包） |
| **三协议端点** | 同一端口同时说三种协议：`/v1/responses`（Codex）、`/v1/chat/completions`（OpenAI 兼容）、`/v1/messages` + `count_tokens`（Anthropic / Claude Code），`/v1/models` 双格式 — 任何 OpenAI / Anthropic 兼容客户端都能直连 |
| **helper 中控台** | `codex-ocfree helper configure/reset <agent>` 一键把 codex / claude-code / dsh / opencode / traework-cn 指向本地桥（原值逐键备份、可还原）；trae / zcode 打印 GUI 指引卡；其余 7 个 agent 仅检测 |
| **会话隔离** | `codex --profile X` 默认与裸 `codex` 共享全部会话/历史；codex-ocfree 给每个 profile 一份独立 `CODEX_HOME`（`~/.codex.d/X/`），配置和 skills 仍 symlink 共享 |
| **模型切换** | `codex-ocfree models` 终端 TUI 一键切默认模型；`codex-ocfree refresh` 探测上游真实可用性，只列能用的 |
| **额度显示** | `codex-ocfree quota` 本地统计今日/5h 窗口用量与触顶记录；对话里直接问模型“额度还剩多少”也能答（所有端点的请求都记账） |
| **一键体检** | `codex-ocfree doctor` 检查运行时、桥、profile 配置、模型目录、隔离 home、shell 集成 |

### 和 cc-switch 的关系

[cc-switch](https://github.com/farion1231/cc-switch) 是优秀的桌面 GUI，管理多家 API 供应商；本项目是**命令行工具**，专注三件它没覆盖的事：① OpenCode 免费模型协议桥；② 按 profile 隔离会话历史；③ 模型可用性探测与 TUI 切换。灵感来自 cc-switch，致谢。

## 快速开始

前置条件：

- Node.js **≥ 22**（用到 `node:sqlite` / `fetch`）
- [codex-cli](https://github.com/openai/codex)（实测 0.157–0.158；本 profile **不需要 OpenAI 登录**，实测无 `auth.json` 也能跑）
- ~~opencode~~ **可选**：有它就用本地 `opencode.db` 缓存；没有则自动改从 [models.dev](https://models.dev) 在线获取模型元数据

```bash
# 安装（三选一，A 推荐）
# A. clone 一键装：检查环境 + 链接命令 + setup 全自动
git clone https://github.com/LiuSantu123/codex-ocfree.git && cd codex-ocfree && bash install.sh

# B. Release 离线包：不 clone、不经 npm registry（tgz 是 release 附件）
npm i -g --allow-remote=all https://github.com/LiuSantu123/codex-ocfree/releases/download/v0.3.1/codex-ocfree-0.3.1.tgz && codex-ocfree setup

# C. npm 直装（走 GitHub 源）
npm i -g --allow-git=all git+https://github.com/LiuSantu123/codex-ocfree.git && codex-ocfree setup
#   B/C 装完两个命令都可用：codex-ocfree（全名）/ ocfree（短别名）

codex-ocfree up               # 起协议桥
codex --profile opencode      # 开聊；会话历史与裸 codex 完全隔离
```

`setup` = 写 profile + 探测可用模型（首次约 1 分钟，`--no-probe` 跳过）+ 生成模型目录 + 会话隔离 + shell 包装；方式 A 的 `install.sh` 已包含 setup。无 npm 的机器上 `install.sh` 自动降级为 `~/.local/bin` 软链。

> npm ≥ 12 出于供应链安全默认 `allow-git=none` / `allow-remote=none`（禁用 git 源与远程 tarball 直装），所以 B/C 需要 `--allow-*` 放行（npm ≤ 11 可省略）。也可以把 tgz 下载到本地后安装：`npm i -g ./codex-ocfree-0.3.1.tgz`（本地文件不触发白名单）。

之后日常只需要两条命令：`codex-ocfree up`（桥常驻即可）和 `codex --profile opencode`。上游免费池会变，隔段时间跑一次 `codex-ocfree refresh` 更新可用模型。**其它 Agent（Claude Code / dsh / opencode…）用 helper 接入**：

```bash
codex-ocfree helper list                 # 看本机装了哪些 agent、接入状态与配置路径
codex-ocfree helper configure opencode   # 例：把 opencode 指向本地桥（改前自动备份）
```

`setup` 之后需要 `source ~/.bashrc` / `source ~/.zshrc` 或**开一个新终端**，让 `codex()` 包装函数生效（它负责在看到 `--profile X` 时切换 `CODEX_HOME`）。包装写进哪个 rc 由 `$SHELL` 自动判断（**bash / zsh 均支持**，两者数组下标不同所以片段不同），也可 `--shell bash|zsh` 显式指定。

## 命令

```
codex-ocfree setup [profile]           一键安装（默认 profile: opencode）
codex-ocfree init [profile]            只装会话隔离（~/.codex.d/<profile> + codex() 包装，按 $SHELL 选 bash/zsh，幂等）
codex-ocfree doctor                    体检

codex-ocfree up / down / status        协议桥：起 / 停 / 查（pid、日志在 ~/.codex-ocfree/）
codex-ocfree serve                     桥前台运行（排障看日志）

codex-ocfree models                    TUI 选择默认模型
codex-ocfree use <slug> [-p <p>]       直接设置默认模型
codex-ocfree refresh [--all]           重新探测可用性 + 重建模型目录（--all 含不可用模型）
codex-ocfree probe [id ...]            只探测可用性
codex-ocfree catalog                   只重建模型目录
codex-ocfree quota [usage]             免费额度估计（本地统计 + ~200次/5h 参考 + 触顶记录）

codex-ocfree profile                   列出隔离 home 与启动方式
codex-ocfree profile add <name>        新建一个隔离 home
codex-ocfree run [-p <p>] <codex args> 起桥(按需) + 设 CODEX_HOME + 代跑 codex（脚本/CI 环境用）
codex-ocfree shell [zsh|bash]          打印 codex() 包装片段（默认按 $SHELL，自己贴到对应 rc）

codex-ocfree helper                    交互向导（TTY；非 TTY 等价 list）
codex-ocfree helper list [--json]      检测 14 个 agent：安装/配置状态/配置路径/协议
codex-ocfree helper configure <agent>   指向本地桥：codex claude-code dsh opencode traework-cn（trae/zcode 打印 GUI 指引卡）
codex-ocfree helper reset <agent>       只移除注入项、还原原值（其余设置保留）
```

常用组合：

```bash
codex --profile opencode -m <slug>      # 本次会话临时换模型
codex-ocfree use <slug>                     # 改默认模型（下次启动生效）
codex-ocfree run -p opencode exec --skip-git-repo-check "..."   # 一条命令：桥 + 隔离 + 非交互执行
```

## 三协议端点

桥在同一个端口上同时说三种协议，任何 OpenAI / Anthropic 兼容客户端都能直连：

| 端点 | 协议 | 典型客户端 |
|---|---|---|
| `POST /v1/responses` | OpenAI Responses（SSE） | codex（`wire_api="responses"`） |
| `POST /v1/chat/completions` | OpenAI Chat（流式/非流式） | dsh、opencode、OpenAI 兼容客户端 |
| `POST /v1/messages`、`/v1/messages/count_tokens` | Anthropic Messages | Claude Code、zcode 等 Anthropic 兼容客户端 |
| `GET /v1/models` | 双格式（`object:"list"` + `type:"list"`，条目含 `display_name`） | 各家模型列表 UI |

- 三种协议最终都落到上游 `chat/completions`；请求里的模型不在免费目录时**自动回退到当前默认免费模型**，响应里回显客户端原名。
- Chat / Anthropic 端点同样补齐上游门禁：UA、`x-opencode-session`、`stream:true`、tools 含 `read`+`shell`；客户端没带工具时自动注入等价工具（按客户端工具克隆 schema，响应侧按原名映射回去，参数无损）。
- 客户端要非流式就本地聚合；用量照常记进 `usage.jsonl`（`kind:"chat"`），`codex-ocfree quota` 覆盖所有客户端。
- 第一版 Anthropic 端点**不透传 thinking/reasoning 块**（双向都丢弃）；图片输入降级为 `[image omitted]`；错误码映射（上游 429 → `rate_limit_error` 等）。

## helper 中控台：把免费桥接到其它 Agent

形态对标 `arkcli helper`：`helper`（TTY 交互向导）/ `helper list [--json]` / `helper configure <agent>` / `helper reset <agent>`。

| agent | 支持级别 | `configure` 做什么 |
|---|---|---|
| **codex** | 自动 | 写 `~/.codex/opencode.config.toml` profile + 会话隔离（即 setup/init 路径） |
| **claude-code** | 自动（外科手术式） | `~/.claude/settings.json` 只动三把 `env` 键：`ANTHROPIC_BASE_URL`→本地桥、`ANTHROPIC_AUTH_TOKEN`→占位、`ANTHROPIC_MODEL`→当前免费模型；**其余键原样保留** |
| **dsh**（DeepSeek Harness） | 自动 | `~/.dsh/cordis.patch.yml`（loader patch **数组**）注入 `llm-pi-ai.providers.ocfree` + `agent-default-model`；凭据写 `~/.dsh/.env` 的 `OCFREE_API_KEY`（实测 `settings.yaml` 不被启动路径读取，故写 patch 文件） |
| **opencode** | 自动 | `~/.config/opencode/opencode.json` 注入 `provider.ocfree`（**不改你的默认模型**，用 `/models` 或 `-m ocfree/<id>` 选） |
| **traework-cn**（TraeCode CLI） | 自动 | `~/.trae/trae_cli.yaml` 的 `models:` 列表合并两条协议条目：`ocfree-local`（`open_ai`，`base_url` 带 `/v1`）+ `ocfree-local-claude`（`claude`，`base_url` 根路径）；已存在则原地替换（换端口/换模型不产生重复条目），reset 只删我们的条目。**chat 需先登录 TRAE 账号**（登录与套餐校验是 TRAE 自家门槛）；TraeWork 桌面版仅 GUI，配置打印到指引卡 |
| **trae** | 仅指引卡 | 配置存在加密 `state.vscdb`，只能 GUI 填 — 打印带 URL / key / model 的步骤卡 |
| **zcode** | 仅指引卡 | 配置 schema 随版本漂移且本机无安装 — 打印可粘贴 JSON 片段（`kind:"anthropic"`、`baseURL` 不带 `/v1`），**不代写文件** |
| workbuddy / cursor / grok / kimi-code / openclaw / hermes / pi | 仅检测 | `helper list` 报告安装与配置状态（未适配，configure 会拒绝） |

**安全与还原**：

- 每次 configure **先把原文件整份快照**进 `~/.codex-ocfree/backups/`，并把**逐键原值**记进 `helper-state.json`；
- `helper reset <agent>` 只删注入项（marker 段 / 逐键），你的其它设置原样保留、原值逐键还原；重复 configure **幂等**（不会用桥的值覆盖原值记录）；
- 实测覆盖：claude-code 隔离 HOME 全流程（改 → 还原 → 幂等 → 二次 reset 无副作用）、dsh 三种文件形态（全新 / 已有同名 entry / 已有自己的默认模型）、opencode 与 codex 的注入与还原、traework-cn 全流程（真 `trae-cli models`/`doctor` 验收 + 双协议经桥 live chat、换端口/换模型原地替换、legacy 1.0 路径偏好、合并与外科 reset）、trae/zcode 指引卡只打印不落盘。

### Claude Code：切换与还原（按需执行）

`helper configure claude-code` 能力已实现并通过隔离测试，**是否在本机执行由你决定**——若 `~/.claude/settings.json` 已被其它工具占用（例如 arkcli），就不要动它：

```bash
codex-ocfree helper configure claude-code   # 注入三键（先整份备份）
claude -p "..."                             # 走免费桥
codex-ocfree helper reset claude-code       # 逐键还原（含删除我们新增的键）
```

手动等价操作（不依赖本工具）：在 `settings.json` 的 `env` 里设
`ANTHROPIC_BASE_URL=http://127.0.0.1:8973`、`ANTHROPIC_AUTH_TOKEN=ocfree-local`、`ANTHROPIC_MODEL=<免费slug>`；
还原即把三键改回原值或删掉。**改前先备份原文件。**

真实客户端实测：`claude -p`（默认 `claude-opus-5-5`）与 `claude --model sonnet`（`claude-sonnet-5`）都被桥回退到免费模型正常作答，23 个工具场景下门禁注入与用量记录均正常。

### dsh / opencode 真实 E2E 实测

- **dsh**：`helper configure dsh` 产出的 `cordis.patch.yml` 过 `dsh web --dump-config` schema 验收（exit 0、ocfree 进入组合配置）；`dsh headless "<任务>"` 不带任何 export 直接把 2 个请求打到桥并拿到真实回复（凭据纯靠 `~/.dsh/.env`）。
- **opencode**：隔离 HOME 下 `helper configure opencode` 后 `opencode run -m ocfree/<model>` 两次都拿到真实回复，桥日志与 `usage.jsonl` 记录齐全。

## 会话 / 历史按 profile 隔离

- `--profile` **本身只叠加配置**：所有 profile 默认共享 `~/.codex` 的会话存储（rollout jsonl、`state_5.sqlite`、`thread_history_1.sqlite`、`history.jsonl`）。配置里写 `sqlite_home` 也没用（实测：rollout 仍进 `~/.codex/sessions`，新库启动还会把旧会话回灌）。
- **唯一可靠的隔离杠杆是 `CODEX_HOME`**。`codex-ocfree init` 会：
  1. 建 `~/.codex.d/<name>/`，把 `config.toml`、`<name>.config.toml`、`skills/`、`rules/`、`MEMORY.md` symlink 到 `~/.codex/`（改配置仍然一处生效）；
  2. 往 `~/.bashrc` 或 `~/.zshrc`（按 `$SHELL` 选择）追加 marker 包裹的 `codex()` 函数（幂等，bash/zsh 各用各自正确的数组下标语法）：检测到 `--profile X` 且存在 `~/.codex.d/X` 时自动 `CODEX_HOME=~/.codex.d/X`。裸 `codex` 仍用默认 `~/.codex`。
- 实测效果：隔离 home 的 `codex resume` 只列出自己的会话，与默认 home 互不可见。
- **限制**：
  - 包装函数对 **bash / zsh 交互 shell** 生效（fish 等请用 `codex-ocfree run -p X ...` 或手动 `export CODEX_HOME=...`）；脚本/CI 里同样建议用 `run`。
  - 新 HOME 第一次在某目录启动 TUI 会弹一次 "Trust this folder?"，信任一次即可（每个 home 各记各的）。
  - rc 文件里已有自己的 `codex()` 函数时，codex-ocfree **不会**覆盖，会提示你手动处理。

## 模型目录与可用性

上游免费池是动态的。codex-ocfree 的做法：

1. `codex-ocfree probe` —— 对每个 `*-free` 模型发一次最小请求，记录到 `~/.codex-ocfree/availability.json`（`ok` / `http4xx` / `ERR`）；
2. `codex-ocfree catalog` —— 模型元数据**优先读 `opencode.db` 的本地缓存，缺失时自动回退到 `https://models.dev/api.json`**（无需安装 opencode），**只把 `ok` 的模型**写进 `~/.codex/opencode.models.json`（即 Codex 的 `model_catalog_json`），并过滤掉 Codex 不认的 `video` 等 modality 枚举。

改了模型目录**不需要重启桥**；桥只管转发，`GET /v1/models` 每次实时读目录。

## 每日额度显示

上游**不回传任何 rate-limit / 余量响应头**（实测只有 `x-opencode-*` 元数据头），官方也没公布免费额度数字，所以 codex-ocfree 只能也只应给“**大概**”：

- **本地统计**：桥把每次真正打到上游的请求（对话 + `probe` 探测）追加到 `~/.codex-ocfree/usage.jsonl`（状态、token 数、耗时、429 触顶），保留 30 天。
- **`codex-ocfree quota`**：今日/5 小时窗口/昨日请求次数与 token、模型分布、触顶（429 `FreeUsageLimitError`）记录，附参考进度条。
- **对话内可问**：桥会把一行 `[free-tier usage — local estimate] …` 注入系统消息，所以直接在 codex 里问“额度还剩多少”，模型会引用本地数字回答（有记录才注入，全新安装首条请求不带）。
- **参考上限**：社区实测约 **200 次 / 5 小时**（[opencode#33495](https://github.com/anomalyco/opencode/issues/33495) 的 429 报错），非官方数字；`OC2C_LIMIT_5H=<n>` 改参考值，`0` 关闭进度条，天数参考值按 `24/5h` 窗口推算。
- 真触顶时上游直接回 429，codex 会看到错误正文——等滑动窗口过期（约 5 小时尺度）再继续。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OC2C_PORT` | `8973` | 桥监听端口（改了要同步改 profile 的 `base_url`） |
| `OC2C_HOST` | `127.0.0.1` | 桥监听地址 |
| `OC2C_UPSTREAM` | `https://opencode.ai/inference/openai/v1` | 上游端点 |
| `OC2C_UA` | `opencode/2.0.18/cli` | 上游门禁要求的 User-Agent |
| `OC2C_DB` | `~/.local/share/opencode/opencode.db` | 模型元数据 / OAuth token 来源 |
| `OC2C_CATALOG` | `~/.codex/opencode.models.json` | 模型目录路径 |
| `OC2C_TIMEOUT_MS` | `600000` | 上游请求超时 |
| `OC2C_STATE` | `~/.codex-ocfree` | pid / 日志 / availability / 用量记录（`usage.jsonl`）存放处 |
| `OC2C_LIMIT_5H` | `200` | 额度参考上限（次/5h），`0` 关闭 quota 进度条 |
| `OC2C_ALL` | — | 设 `1` 时目录包含未探测可用的模型 |
| `PROBE_TIMEOUT_MS` | `15000` | 单模型探测超时（死模型快速判定） |
| `PROBE_CONCURRENCY` | `4` | 探测并发数 |
| `OCSW_HOME` 等 | — | 主要用于测试（改 HOME / CODEX_HOME / rc 文件位置） |

## 故障排查

| 症状 | 原因 / 处理 |
|---|---|
| codex 报 `Model is unavailable` | 上游模型下线（不是桥的问题）。跑 `codex-ocfree refresh` |
| `ModelProtocolUnsupported` | 请求打到了 `/responses`：检查 profile `base_url = "http://127.0.0.1:8973/v1"`、`wire_api = "responses"`、桥在跑（`codex-ocfree status`） |
| 403 / `FreeTierError` | 上游门禁变了：UA 需 `opencode/<semver>/cli`、session 需 `ses_`+12hex+14 位、body 需 `stream:true` 且 tools 含 `read`+`shell`。改 `src/bridge.mjs` 的 `gateHeaders()` |
| 429 / `FreeUsageLimitError` | 免费额度触顶（约 200 次/5h 窗口，社区实测值）。等窗口滑过；`codex-ocfree quota` 看本地进度与触顶记录 |
| 401 | 过期 OAuth token；桥会自动降级为匿名重试，仍持续就 `codex-ocfree down && codex-ocfree up` |
| codex 警告 `Model metadata not found` | `model_catalog_json` 路径不对，或 JSON 含 Codex 不认的枚举 — 用 `codex-ocfree catalog` 重新生成 |
| `codex --profile X` 没隔离会话 | shell 包装没装/没重载 — `codex-ocfree doctor` 看那一行（bash/zsh 都检查），或用 `codex-ocfree run -p X` |
| 端口被占 | 换 `OC2C_PORT`，并同步改 profile 里的 `base_url` |
| `helper configure claude-code` 后 claude 没走桥 | claude 读 `settings.json` 的 `env`：`helper list` 看 configured 状态、确认桥在跑（`codex-ocfree status`）、重启 claude；改完没重启不生效 |
| dsh 报 `MISSING_CREDENTIAL` / `No API key for provider` | pi-ai 强制要凭据：重跑 `helper configure dsh` 补 `~/.dsh/.env`（`OCFREE_API_KEY`，实测该文件会被读取，无需 export） |
| dsh 报 `cordis.patch.yml must be a top-level YAML array` | 该文件必须是 loader patch 数组格式（helper 写的就是）；手工编辑破坏了格式就按 `helper configure dsh` 输出的形状改回 |
| opencode 报 `Managed service port ... already in use` | 机器上已有 opencode 服务占了默认托管端口（与本项目无关）：`opencode service set port <其他端口>` |
| Anthropic 客户端没看到 thinking 内容 | v0.3.0 第一版有意丢弃 reasoning/thinking 块（双向），文本与工具不受影响 |

## 项目结构

```
codex-ocfree/
├── bin/codex-ocfree.mjs        入口
├── src/
│   ├── cli.mjs             命令分发 / setup / run
│   ├── bridge.mjs          协议桥（responses / chat / anthropic 三端点 → chat/completions，零依赖）
│   ├── gate.mjs            网关门禁的工具注入与别名映射（read/shell 按客户端工具克隆）
│   ├── anthropic.mjs       Anthropic Messages ⇄ chat 双向转换（SSE 事件流、非流式聚合）
│   ├── helper.mjs          helper 中控台（14 agent 检测 / configure / reset / 指引卡）
│   ├── bridgectl.mjs       桥控制（start/stop/health）
│   ├── profiles.mjs        CODEX_HOME 隔离 + bash/zsh codex() 包装
│   ├── probe.mjs           上游可用性探测
│   ├── catalog.mjs         模型目录生成（model_catalog_json）
│   ├── usage.mjs           本地额度用量记录与聚合（usage.jsonl）
│   ├── quota.mjs           codex-ocfree quota 展示
│   ├── doctor.mjs          体检
│   ├── tui.mjs             终端选择器（方向键 / j-k / Enter）
│   └── config.mjs          路径与共享工具
├── templates/
│   ├── opencode.config.toml.example   setup 渲染的 profile 模板
│   └── base.config.toml.example       基础配置参考
├── install.sh                     一键安装（clone + 链接命令 + setup，无 npm 时降级软链）
└── LICENSE  README.md  README_EN.md  package.json
```

## 许可

**PolyForm Noncommercial License 1.0.0** — 见 [LICENSE](LICENSE)。

- ✅ 个人学习、研究、实验、爱好项目：使用 / 修改 / 分发均可（须随附许可证与 `Required Notice`）
- ❌ 商业用途（出售、商业服务、商业组织内部商用等）：**未授权**
- 项目名称、Logo、域名的商标权不在本许可证授权范围内
- 上游第三方（OpenCode、codex-cli 等）各有自己的许可证与服务条款，本项目不授予任何关于它们的权利

版权所有 © 2026 LiuSantu123。
