# Agent 自动化中台

让 Agent 自动跟进事情，需要你判断时再问你。

![架构图](docs/architecture.svg)

有人提了 issue、系统报错、到了约定时间，都可以成为一个事件。你写规则，决定交给哪个 Agent、在哪个目录、照什么要求做。Agent 完成工作就交回结果；需要你选择时，把问题送到通道，结束进程。你回答后，它继续处理。

- **一台电脑就能跑。** 不需要公网服务器，接单电脑只向中台发起连接。
- **Agent、来源、通道都能换。** 能打印最后一条消息的命令行程序就能接入。
- **等待回答不占 Agent 进程。** 问题、回答和待办保存在本机，重启后继续。
- **0 个运行时依赖。** Node 24 直接运行 TypeScript，内核 1598 行。

中文 | [English](README.en.md)

## 装

需要 Node 24、git 和一个已经登录的命令行 Agent。把这句话交给你的 Agent：

> 读 https://raw.githubusercontent.com/KKKKhazix/agent-hub/main/INSTALL.md ，帮我装好。

也可以自己运行：

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-hub/main/install.sh | sh
agent-hub try
```

`try` 会实际调用你的 Agent，走完提问、回答和继续处理。下面是 Codex 的实际终端输出：

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

## 规则

一条规则写清：什么事，交给谁，在哪，照什么做。

```json
{
  "name": "处理 issue",
  "when": { "source": "github", "types": ["issues.opened"] },
  "to": "codex",
  "cwd": "~/code/app",
  "skill": "handle-issue",
  "parallel": 3
}
```

定时任务也是规则：

```json
{ "name": "早报", "when": { "cron": "0 9 * * *" }, "to": "codex", "cwd": "~/notes", "prompt": "写今天的早报。" }
```

改 `~/.agent-hub/rules.json` 后几秒内生效。写错时保留原规则，并告诉你哪里不对。事件里的文字不能改变执行目录、Agent 或权限。

## Agent 只需要做一件事

打印最后一条消息。第一行是结论，需要中台继续处理的事写进 `agent-hub` 代码块：

````text
订单已经核对，库存充足。

```agent-hub
{ "ask": [{ "title": "怎么发货？", "text": "两种方式都能送达。", "options": ["快递", "自提"], "key": "shipping" }] }
```
````

代码块可省略。回执还可以发通知、结掉已解决的问题、约时间复查、发出新事件。格式写错时只让 Agent 重写回执，不重做业务。Agent 不需要 SDK，也不需要拿到中台密钥。

## 为什么这样设计

**一条日志。** 收到事件、采用规则、领取任务、交回结果、回答问题，都记成事实。状态从日志中计算，随时可以重建。想知道一件事为什么这样处理，直接看时间线：

```bash
agent-hub why 1
```

上面这次 `try` 留下的真实输出：

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

加 `--json` 可以读取原始事实；默认不打印整份规则。

以下脚本在引擎目录 `~/.agent-hub/app` 运行。

**确定性内核。** 时间和外部输入明确传入，同样的输入得到同样的结果。模拟会重复请求、丢弃响应、让接单程序失联，再检查事件、卡片和日志是否一致。固定种子可以复现同一组故障：

```bash
node sim/random.ts 24301 200000
```

**一个定时器。** 定时任务、复查、重试和租约共用一张到期表，进程只等最近的到期点。到期表也能从日志恢复。下面的 `kill -9` 测试会强杀真实 SQLite 进程 1000 次，检查确认过的事实和恢复后的状态：

```bash
node sim/crash.ts 1000 12648430
```

**一份协议。** 来源、接单程序、通道和命令行都用 HTTP + JSON。你可以直接运行[只用 curl 和 jq 写的通道](examples/channel.sh)，用已配置的通道密钥领卡片、打印到终端并报告送达：

```bash
AGENT_HUB_URL=http://127.0.0.1:3350 AGENT_HUB_KEY="$CHANNEL_KEY" sh examples/channel.sh
```

测试机器：**Apple M5 Pro、24 GB、Node 24.21.0**。写入采用逐条 HTTP 请求，每条事务落盘后才返回。

| 指标 | 实测 |
|---|---:|
| 冷启动（ms） | 82.74 |
| 空闲 RSS（MB） | 59.71 |
| 1000 个长轮询时 RSS（MB） | 169.98 |
| 持久化写入（条/秒） | 2411 |
| 派活 p99（ms） | 1.18 |
| 同时等待／完成的长轮询 | 1000 / 1000 |
| 故障模拟（步/秒） | 33131 |
| 固定种子模拟（步） | 200000 |
| 穷举顺序／状态转换 | 40320 / 654920 |
| SIGKILL（次） | 1000 |
| 可执行变异检出 | 25 / 25 |

运行 `npm run benchmark` 可复现性能测量。

## 三个口子

**来源：把外部变化变成事件。**

| 来源 | 怎么接 |
|---|---|
| 你的系统 | `POST /v1/events`，使用自己的来源密钥 |
| GitHub Webhook | 自带验签和事件转换插件 |
| 定时 | 在规则里写 `cron`，错过后只补最近一次 |
| 不能推送的系统 | 定时运行[轮询脚本](examples/watch-github-issues.sh)，没新事件就不调用模型 |

**Agent：实测跑通。**

| Agent | 怎么接 | 已跑通 |
|---|---|---|
| Claude Code | `use: "claude"` | Haiku 5.5，两轮问答和会话恢复 |
| Codex | `use: "codex"` | 两轮问答和会话恢复 |
| ACP | `use: "acp"`，`command` 指定 ACP 程序 | 官方 Codex ACP 适配器，两轮跨进程恢复 |

**一行接入，命令来自官方文档，我们还没跑过。**

| Agent | 命令 |
|---|---|
| [Hermes](https://github.com/NousResearch/hermes-agent) | `hermes chat -Q -q {prompt}` |
| [pi](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/overview) | `codebuddy -p {prompt}` |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | `dsh --profile headless {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |

普通命令用 `use: "command"`，把命令拆成 `command` 数组；`{prompt}` 是单个参数，不经过 shell。专用插件提供会话恢复和用量读取，ACP 使用 v1。内置和第三方插件走同一条加载路径，`agent-hub add <git 地址>` 安装插件，不自动更新。接法见[配置手册](skills/agent-hub/SKILL.md)。

**通道：把问题送到你常看的地方。**

| 通道 | 怎么回答 |
|---|---|
| 飞书 | 卡片按钮，核对回答者和原消息 |
| 钉钉、企微、Slack、Discord | 自带群机器人模板，文字加回答链接 |
| 命令行 | `agent-hub status` 查看，`agent-hub answer` 回答 |
| 其他通道 | 按协议领卡片、发送、报告、转交回答 |

飞书已经在真实应用里跑通发送、点击和更新卡片；群机器人模板目前只用假服务测过。你也可以用 `agent-hub mcp` 接入支持 stdio MCP 2025-11-25 的客户端，查看、追溯、回答和处理事项。

## 交付流水线

给 PR 打 `deliver` 标签，交付插件会只读审查、等待完整检查、合并、等待 Ship，再核对健康接口里的版本。队列、并发、重试和结果通知使用中台已有能力。

需要 GitHub 仓库、已登录的 `gh`、审查命令，以及能报告部署版本的健康检查。项目设置放在 main 的 `ops/delivery.json`；PR 的代码和设置不会在接单电脑上执行。审查状态默认 `agent-review`，可自行修改。Ship 使用本仓库的 GitHub Action。

[配置交付流水线](skills/agent-hub/SKILL.md#交付流水线)

## 没有界面

中台不带总览页。要你判断时，通道把卡片送来；平时用 `agent-hub status` 看状态。卡片链接是一个普通表单。

需要自己的页面，可以用 `GET /v1/state` 和 `GET /v1/stream` 做客户端，和命令行使用同一份协议。

## 六条原则

1. **注意力最贵。** 没事不打扰，需要你判断时才提问。
2. **一切都是事件。** 外部变化、时间、复查和回答使用同一套处理方式。
3. **一切都连进来。** 内核不发对外请求，凭据留在使用它的插件里。
4. **Agent 就是一个进程。** 给它提示词，读取最后一条消息。
5. **一轮不等人。** 提问后结束进程，收到回答后再启动。
6. **规则才是指令。** 事件里的文字是资料，不能决定执行目录、Agent 和权限。

## 用量和条款

中台启动你已经安装和登录的命令行工具，不读取或转存它们的登录凭据。模型调用计入你自己的账号，额度和允许的使用方式由各家服务条款决定。使用前查看对应 CLI 和模型服务的条款。

自动化场景下，各家都更推荐用 API Key，个人订阅的额度是按普通个人使用设计的：见 [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) 和 [OpenAI](https://learn.chatgpt.com/docs/auth) 的说明。要拿它给别人提供服务，请用 API Key。

本项目不是这些厂商的产品，也没有得到它们的背书。

## 文档

- [安装说明](INSTALL.md)
- [配置手册](skills/agent-hub/SKILL.md)
- [完整协议](docs/protocol.md)
- [安全边界](SECURITY.md)
- [开发约定](AGENTS.md)

[MIT](LICENSE)
