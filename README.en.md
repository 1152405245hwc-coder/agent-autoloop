# Agent Hub

Let Agents follow up on work and ask when they need your judgment.

![Architecture](docs/architecture.svg)

An issue, an alert or a scheduled time becomes an event. Your rules choose the Agent, working directory and instructions. The Agent returns a result when finished. If it needs a decision, it sends a question through a channel and exits. Your answer starts work again.

- **Runs on one computer.** No public server is required; workers connect out to the hub.
- **Replaceable Agents, sources and channels.** Any command-line program that prints a final message can connect.
- **No Agent process while waiting for an answer.** Questions, answers and pending work persist across restarts.
- **Zero runtime dependencies.** Node 24 runs the TypeScript directly; the kernel is 942 lines.

[中文](README.md) | English

## Install

You need Node 24, git and a command-line Agent that is already signed in. Give your Agent this instruction:

> Read https://raw.githubusercontent.com/KKKKhazix/agent-hub/main/INSTALL.md and install it for me.

Or run:

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-hub/main/install.sh | sh
agent-hub try
```

`try` calls your Agent and takes it through asking, answering and continuing. Here is actual terminal output with Codex. The CLI currently speaks Chinese:

```text
事件发出去了，Agent 开始干活……

Agent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。

【等你决定】#1 试跑：选一个颜色
这是一次试跑，选哪个都行。
  1. 蓝色
  2. 绿色

选几？2

收到，Agent 接着干……
它把活干完了：你选了绿色，试跑通过
```

## Rules

A rule specifies what happened, who handles it, where and with which instructions.

```json
{
  "name": "handle issues",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

Schedules are rules too:

```json
{ "name": "morning brief", "when": { "cron": "0 9 * * *" }, "to": "codex", "cwd": "~/notes", "prompt": "Write today's brief." }
```

Edits to `~/.agent-hub/rules.json` apply within seconds. Invalid edits leave the previous rules running and report the error. Event text cannot choose the working directory, Agent or permissions.

## All an Agent has to do

Print its final message. The first line is the conclusion; requests for the hub go in an `agent-hub` block:

````text
The order is checked and stock is available.

```agent-hub
{ "ask": [{ "title": "How should we deliver?", "text": "Both options are available.", "options": ["Courier", "Pickup"], "key": "shipping" }] }
```
````

The block is optional. A receipt can also send notices, resolve questions, schedule a follow-up or emit events. Malformed receipts are rewritten without repeating the business work. The Agent needs neither an SDK nor a hub key.

## Why it works this way

**One log.** Events, rules, claims, results and answers are recorded as facts. State is computed from the log and can be rebuilt. To see why something happened, read its timeline:

```bash
agent-hub why 1
```

Actual output from the `try` session above:

```text
第 1 轮 · 试一下
2026-11-03 07:48:10 UTC  规则版本 #1
2026-11-03 07:48:11 UTC  触发事件：来源 shop · 类型 try.start · 对象 #1793692091615
2026-11-03 07:48:11 UTC  mac-mini 领取（Codex）
2026-11-03 07:48:11 UTC  开始处理
2026-11-03 07:48:12 UTC  会话：codex://threads/01a1a061-454d-76e3-b6ca-ae8730d4f096
2026-11-03 07:48:26 UTC  结束：问了一个问题
2026-11-03 07:48:26 UTC  提问：试跑：选一个颜色
  这是一次试跑，选哪个都行。
  选项：蓝色 / 绿色
2026-11-03 07:48:55 UTC  本人回答「试跑：选一个颜色」：绿色
2026-11-03 07:48:55 UTC  回答后继续：第 2 轮
```

Add `--json` for raw facts. The default output does not print the full rules file.

Run the following scripts from the engine directory, `~/.agent-hub/app`.

**A deterministic kernel.** Time and external input are explicit, so the same input produces the same result. The simulator duplicates requests, drops responses and disconnects workers, then checks events, cards and the log. A fixed seed reproduces the same faults:

```bash
node sim/random.ts 24301 200000
```

**One timer.** Schedules, follow-ups, retries and leases share a due table. The process waits for the nearest deadline. That table can also be rebuilt from the log. This `kill -9` test kills real SQLite processes 1000 times and checks acknowledged facts and recovered state:

```bash
node sim/crash.ts 1000 12648430
```

**One protocol.** Sources, workers, channels and the CLI use HTTP + JSON. Run the [curl and jq channel](examples/channel.sh) with an existing channel key to receive cards, print them and acknowledge delivery:

```bash
AGENT_HUB_URL=http://127.0.0.1:3350 AGENT_HUB_KEY="$CHANNEL_KEY" sh examples/channel.sh
```

Measured on **Apple M5 Pro, 24 GB, Node 24.21.0**. Writes use one HTTP request per event, acknowledged only after its transaction is durable.

| Metric | Measured |
|---|---:|
| Cold start (ms) | 82.74 |
| Idle RSS (MB) | 59.71 |
| RSS with 1000 long polls (MB) | 169.98 |
| Durable writes (events/s) | 2411 |
| Dispatch p99 (ms) | 1.18 |
| Concurrent / completed long polls | 1000 / 1000 |
| Fault simulation (steps/s) | 33131 |
| Seeded simulation (steps) | 200000 |
| Enumerated orders / transitions | 40320 / 654920 |
| SIGKILLs | 1000 |
| Executable mutations detected | 25 / 25 |

Run `npm run benchmark` to reproduce the performance measurements.

## Three plug points

**Sources turn changes into events.**

| Source | Connection |
|---|---|
| Your system | `POST /v1/events` with its own source key |
| GitHub webhook | Built-in signature verification and event conversion |
| Schedules | `cron` in a rule; catches up on the latest missed occurrence |
| Systems that cannot push | A [polling script](examples/watch-github-issues.sh); no model call without new events |

**Agents tested end to end.**

| Agent | Connection | Tested |
|---|---|---|
| Claude Code | `use: "claude"` | Haiku 5.5, two-turn question/answer loop and resume |
| Codex | `use: "codex"` | Two-turn question/answer loop and resume |
| ACP | `use: "acp"`, server command in `command` | Official Codex ACP adapter, two turns restored across processes |

**One-command connections from official documentation; we have not run these.**

| Agent | Command |
|---|---|
| [Hermes](https://github.com/NousResearch/hermes-agent) | `hermes chat -Q -q {prompt}` |
| [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/overview) | `codebuddy -p {prompt}` |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `dsh --profile headless {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |

Use `use: "command"` and split a plain command into a `command` array. `{prompt}` is one argument, without a shell. Dedicated adapters provide session resume and usage reporting; ACP uses v1. Built-in and third-party plugins share the same loader. `agent-hub add <git URL>` installs a plugin without automatic updates. See the [configuration guide](skills/agent-hub/SKILL.md).

**Channels bring questions to you.**

| Channel | How to answer |
|---|---|
| Feishu | Card buttons with sender and message verification |
| DingTalk, WeCom, Slack, Discord | Built-in group-bot templates with text and an answer link |
| CLI | `agent-hub status` to view, `agent-hub answer` to answer |
| Other channels | Receive cards, send them, report delivery and relay answers through the protocol |

Feishu has run for real: sending, button clicks and card updates. The group robot templates have only been tested against fake services so far. `agent-hub mcp` also connects stdio MCP 2025-11-25 clients to view, trace, answer and manage work.

## Delivery pipeline

Label a PR `deliver`. The delivery plugin reviews it read-only, waits for the full check, merges it, waits for Ship and verifies the deployed version from the health endpoint. It uses the hub's queue, concurrency, retries and result notifications.

You need a GitHub repository, authenticated `gh`, a review command and a health endpoint that reports the deployed version. Project settings live in main's `ops/delivery.json`. PR code and settings are never executed on the worker computer. The review status defaults to `agent-review` and is configurable. Ship uses this repository's GitHub Action.

[Configure delivery](skills/agent-hub/SKILL.md#交付流水线)

## No interface

There is no bundled dashboard. Channels deliver questions when your judgment is needed; `agent-hub status` shows current work. Card links open a plain form.

Build your own client with `GET /v1/state` and `GET /v1/stream`, using the same protocol as the CLI.

## Six principles

1. **Attention comes first.** Stay quiet without news; ask when a decision is needed.
2. **Everything is an event.** External changes, time, follow-ups and answers use the same mechanism.
3. **Everything connects inward.** The kernel makes no outbound requests; credentials stay with the plugins that use them.
4. **An Agent is a process.** Give it a prompt and read its final message.
5. **A run does not wait for a person.** Exit after asking; start again when the answer arrives.
6. **Rules are instructions.** Event text is data and cannot choose the working directory, Agent or permissions.

## Usage and terms

The hub starts command-line tools you installed and authenticated yourself. It does not read or copy their login credentials. Model usage counts against your account; each provider sets its quotas and permitted uses. Check the applicable CLI and model-service terms before use.

For automation, vendors recommend API keys, and personal plans assume ordinary individual use: see [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) and [OpenAI](https://learn.chatgpt.com/docs/auth). If you offer a service to others with it, use API keys.

This project is not a product of those vendors and is not endorsed by them.

## Documentation

- [Installation](INSTALL.md)
- [Configuration guide](skills/agent-hub/SKILL.md)
- [Full protocol](docs/protocol.md)
- [Security boundaries](SECURITY.md)
- [Development conventions](AGENTS.md)

[MIT](LICENSE)
