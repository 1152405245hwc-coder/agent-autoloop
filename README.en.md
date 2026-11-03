# Agent Hub

Let agents follow work through to completion, and bring you in when a decision is yours to make.

The CLI and notifications are currently in Chinese.

![Architecture](docs/architecture.en.svg)

A new issue, a production error, or nine o’clock in the morning is an **event**. Your **rules** choose the agent, its working directory, and the instructions it follows. The agent finishes a **round** and exits, leaving any follow-up actions in its final message.

When it needs your decision, it sends a **card**. Your answer starts another round, continuing the same conversation when available. Waiting keeps no agent process running, uses no tokens, and survives a restart.

- **One computer, one install command.** No server or inbound ports required.
- **No dashboard, no SDK.** The protocol is HTTP + JSON; the CLI is one of its clients.
- **Swap agents, sources, and channels.** A CLI that prints a final message can connect with one configuration entry.
- **No runtime dependencies.** Node 24 is enough.

[中文](README.md)

## Install

Works on macOS and Linux. You need Node 24, Git, GitHub CLI signed in with access to this repository, and a command-line agent you have already signed into. You can also hand the [installation guide](INSTALL.md) to your agent.

Install the program, configuration, and desktop notifications:

```bash
gh api repos/KKKKhazix/agent-hub/contents/install.sh -H 'Accept: application/vnd.github.raw+json' | sh
```

Try a complete question, answer, and continuation with your own agent:

```bash
agent-hub try
```

This is actual output from Codex in a non-interactive terminal:

```text
事件发出去了，Agent 开始干活……

Agent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。

【等你决定】#1 试跑：选一个颜色
这是一次试跑，选哪个都行。
  1. 蓝色
  2. 绿色
回答：agent-hub answer 1 <序号>
答完运行 agent-hub status，能看到它接着把活干完。
```

Run `agent-hub answer 1 2` to choose green. Then `agent-hub status` shows “你选了绿色，试跑通过” — the agent continued and finished the trial. In an interactive terminal, enter the choice directly.

## Rules

A rule says what happened, who handles it, where they work, and which instructions to follow:

```json
{
  "name": "Handle issues",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

Schedules use the same rules file:

```json
{ "name": "Morning brief", "when": { "cron": "0 9 * * *" }, "to": "codex", "cwd": "~/notes", "prompt": "Write today's brief." }
```

Edit `~/.agent-hub/rules.json` and run `agent-hub check`. Changes take effect within seconds; invalid edits leave the previous rules running and tell you what needs fixing.

## The agent has one job

Print a final message. Put the conclusion on its first line and any actions for the hub in an `agent-hub` block:

````text
Order checked. There is enough stock.

```agent-hub
{ "ask": [{ "title": "How should we deliver it?", "text": "Both options are available.", "options": ["Courier", "Pickup"], "key": "shipping" }] }
```
````

Omit the block when no follow-up is needed. A receipt can also notify you, close a card, schedule a check, or emit an event; a malformed receipt gets rewritten without repeating the business operation.

## Why it works this way

**One log.** Accepted changes are recorded as append-only facts, and current state is rebuilt from that log. Run `agent-hub why 1` to trace a round from its trigger to its result:

```text
第 1 轮 · 演示
11-03 20:47:25  规则版本 #1
11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
11-03 20:47:25  local 领取（演示程序）
11-03 20:47:25  结束：演示完成
```

Run the reproduction commands below from the program directory, `~/.agent-hub/app`.

**One deterministic kernel.** It makes no outbound requests, reads no clock, and uses no randomness. The same inputs produce the same result, so network loss, crashes, and duplicate requests can be simulated in memory and reproduced from a seed:

```bash
node sim/random.ts 24301 200000
```

**One timer.** Cron, follow-up checks, and retries share a deadline table; the host waits for its earliest entry. This test kills the process a thousand times and verifies that acknowledged facts survive:

```bash
node sim/crash.ts 1000 12648430
```

**One protocol.** Sources, workers, channels, and the CLI all speak HTTP + JSON. A channel using only curl and jq fits in a few dozen lines: [examples/channel.sh](examples/channel.sh).

## Measurements

HTTP hub process on Apple M5 Pro, 24 GB, Node 24.21.0; reproduce with `npm run benchmark`. Each write is a separate HTTP request, acknowledged after its transaction is durable.

| Metric | Measured |
|---|---:|
| Cold start | 78.12 ms |
| Idle memory | 59.97 MB RSS |
| Durable writes | 3,262 events/s |
| Dispatch p99 | 1.10 ms |
| Kernel lines | 1,405 |
| Runtime dependencies | 0 |

Idle memory and memory under a thousand concurrent connections are measured separately. See the [measurement scope](docs/protocol.md#结构与预算); kernel line counts include TypeScript comments and blank lines.

## Three connections

**Sources turn changes into events.** Your system can post to `/v1/events`, GitHub can send signed webhooks, and schedules use `cron`. Systems without webhooks can use the [polling script](examples/watch-github-issues.sh); no new events means no model call.

**Agents do the work. Tested end to end:**

- Claude Code: `use: "claude"`, including a question, answer, and resumed conversation.
- Codex: `use: "codex"`, including a question, answer, and resumed conversation.
- ACP: `use: "acp"`, using the official Codex ACP adapter with conversation recovery across processes.

**One-line connections from official documentation; we have not run these yet:**

| Agent | Command |
|---|---|
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -q {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) | `dsh --profile headless {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |

Use `use: "command"` and split the command into a `command` array; `{prompt}` stays a single argument, never shell source. Write an [agent plugin](docs/plugins.md#agent-插件) when you need conversation recovery, usage reporting, or a permission mapping.

**Channels bring decisions to you.** Desktop notifications are enabled by default. Feishu uses card buttons; DingTalk, WeCom, Slack, and Discord use text with an answer link. The CLI also works on its own through `agent-hub status` and `agent-hub answer`.

Feishu has been verified with real sends, button clicks, and card updates; the group webhook templates have only been tested against fake services. Clients supporting stdio MCP 2025-11-25 can use `agent-hub mcp` to inspect, trace, answer, and manage work.

## Start with a recipe

- [Morning brief](examples/recipes/morning-brief): summarize local notes and commits on a schedule.
- [GitHub issues](examples/recipes/github-issues): poll new issues, make local changes, and ask you to review them.
- [Production alerts](examples/recipes/ops-alerts): investigate against local code and ask before requesting a restart.

## Delivery pipeline

Add the `deliver` label to a PR. The delivery plugin reviews it, waits for checks, merges, waits for Ship, and verifies the deployed version at the health endpoint. Configuration comes from main; PR code, tests, and configuration are never executed on the worker.

It uses the hub's queue, concurrency, and retries. See [delivery configuration](skills/agent-hub/SKILL.md#交付流水线).

## No dashboard

The hub has no overview page. Cards bring you decisions, and the CLI shows current status; a card link is a plain form with no scripts.

Build your own client with `GET /v1/state` and `GET /v1/stream`. It uses the same protocol as the CLI.

## Six principles

1. **Attention is scarce.** Stay quiet unless a decision needs you.
2. **Everything is an event.** External changes, time, follow-ups, and answers use one path.
3. **Connections belong outside the kernel.** Credentials stay with the plugins that use them.
4. **An agent is a process.** Give it a prompt and read its final message.
5. **A round never waits for a person.** Exit after asking; start again when the answer arrives.
6. **Rules carry authority.** Event text is data; it cannot select an agent, directory, or permissions.

## Usage and terms

The hub starts command-line tools you have installed and signed into. It does not read or copy their login credentials. Model usage belongs to your own account and is governed by each provider's quotas and terms.

For automation, providers recommend API keys; personal subscription quotas are designed around ordinary individual use. See the guidance from [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) and [OpenAI](https://learn.chatgpt.com/docs/auth). Use API keys when offering a service to other people.

This is not a product of those providers and is not endorsed by them.

## Documentation

- [Installation](INSTALL.md)
- [Configuration](skills/agent-hub/SKILL.md)
- [Writing plugins](docs/plugins.md)
- [Protocol](docs/protocol.md)
- [Security boundaries](SECURITY.md)
- [Development guide](AGENTS.md)

[MIT](LICENSE)
