# Agent 自动化中台

让 Agent 自己跟进每一件事，只在需要你判断的时候问你一句。

![架构图](docs/architecture.svg)

有人提了 issue、线上报错了、早上九点到了，这些都是**事件**。你写的**规则**决定交给哪个 Agent、在哪个目录、照哪份手册做。Agent 跑完**一轮**就退出，想让中台做的事都写在它的最后一条消息里。能自己做完的就做完，要你拍板时发一张**卡片**给你。你选了之后，下一轮接着原来的会话往下干。

等你回答的这段时间不占进程、不花 Token，电脑重启也不丢。

- **一台电脑一条命令就能跑。** 不用服务器，不用开放任何端口。
- **没有界面，没有 SDK。** 协议就是 HTTP + JSON，命令行只是它的一个客户端。
- **Agent、来源、通道都能换。** 能打印最后一条消息的命令行 Agent，一行配置就能接。
- **没有运行时依赖。** Node 24 自带的就够。

[English](README.en.md)

## 装

支持 macOS、Linux。需要 Node 24、git、已登录且能访问本仓库的 GitHub CLI，以及一个已经登录的命令行 Agent；也可以把[安装说明](INSTALL.md)交给你的 Agent。

一条命令装好程序、配置和桌面通知：

```bash
gh api repos/KKKKhazix/agent-hub/contents/install.sh -H 'Accept: application/vnd.github.raw+json' | sh
```

用自己的 Agent 走一遍提问、回答和继续处理：

```bash
agent-hub try
```

下面是 Codex 在非交互终端里的真实输出：

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

运行 `agent-hub answer 1 2` 选择绿色，`agent-hub status` 会显示“你选了绿色，试跑通过”。在交互终端里，直接输入序号就行。

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

定时任务也写在同一份规则里：

```json
{ "name": "早报", "when": { "cron": "0 9 * * *" }, "to": "codex", "cwd": "~/notes", "prompt": "写今天的早报。" }
```

改 `~/.agent-hub/rules.json` 后几秒内生效，运行 `agent-hub check` 检查。写错时保留原规则，并告诉你哪里不对。

## Agent 只需要做一件事

打印最后一条消息。第一行写结论，需要中台继续处理的事放进 `agent-hub` 代码块：

````text
订单已经核对，库存充足。

```agent-hub
{ "ask": [{ "title": "怎么发货？", "text": "两种方式都能送达。", "options": ["快递", "自提"], "key": "shipping" }] }
```
````

没有后续动作就不用代码块。回执还可以发通知、结案、约时间复查和发出新事件；格式错了，只让 Agent 重写回执，不重做业务。

## 为什么这样设计

**一条日志。** 被中台接受的变化都记成只追加的事实，当前状态全部从日志算出来。所以任何一轮都能追出前因后果，运行 `agent-hub why 1`：

```text
第 1 轮 · 演示
11-03 20:47:25  规则版本 #1
11-03 20:47:25  触发事件：来源 local · 类型 demo.start · 对象 example
11-03 20:47:25  local 领取（演示程序）
11-03 20:47:25  结束：演示完成
```

下面的复现命令在程序目录 `~/.agent-hub/app` 运行。

**一个确定性内核。** 内核不发请求、不读时钟、不用随机数。同样的输入永远得到同样的结果，所以能在内存里模拟断网、崩溃和重复请求，出错时一个种子就能复现：

```bash
node sim/random.ts 24301 200000
```

**一个定时器。** cron、复查、重试都在一张到期表里，外壳只等最近的那一个。强杀一千次，确认过的事实一条不丢：

```bash
node sim/crash.ts 1000 12648430
```

**一份协议。** 来源、接单程序、通道、命令行说的是同一套 HTTP + JSON。一个只用 curl 和 jq 写的通道，几十行就够：[examples/channel.sh](examples/channel.sh)。

## 实测

Apple M5 Pro、24 GB、Node 24.21.0，运行 `npm run benchmark` 复现；写入逐条提交，事务落盘后才应答。

| 指标 | 实测 |
|---|---:|
| 冷启动 | 81.42 ms |
| 空闲内存 | 59.77 MB RSS |
| 持久化写入 | 3177 条/秒 |
| 派活 p99 | 1.14 ms |
| 内核行数 | 1405 |
| 运行时依赖 | 0 |

空闲内存与千连接负载分开测量，完整口径见[协议](docs/protocol.md#结构与预算)。内核行数包含 TypeScript 的空行和注释。

## 三个口子

**来源把变化变成事件。** 系统直接发 `POST /v1/events`，GitHub 用验签 Webhook，定时任务写 `cron`。不能推送的系统用[轮询脚本](examples/watch-github-issues.sh)，没新事件就不调用模型。

**Agent 接活。实测跑通：**

- Claude Code：`use: "claude"`，两轮问答和会话恢复。
- Codex：`use: "codex"`，两轮问答和会话恢复。
- ACP：`use: "acp"`，官方 Codex ACP 适配器完成两轮跨进程恢复。

**一行接入，命令来自官方文档，我们还没跑过：**

| Agent | 命令 |
|---|---|
| [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/cli) | `hermes chat -q {prompt}` |
| [pi](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli.md) | `pi --print {prompt}` |
| [OpenClaw](https://docs.openclaw.ai/cli/agent) | `openclaw agent exec {prompt}` |
| [WorkBuddy / CodeBuddy](https://www.codebuddy.ai/docs/cli/headless) | `codebuddy -p {prompt}` |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cli-help.md#dsh-headless) | `dsh --profile headless {prompt}` |
| [Cursor](https://cursor.com/docs/cli/reference/parameters) | `agent -p --trust {prompt}` |

普通命令用 `use: "command"`，把命令拆成 `command` 数组；`{prompt}` 是单个参数，不作为 shell 代码执行。需要会话恢复、用量统计或自己的权限映射时，写一个[Agent 插件](docs/plugins.md#agent-插件)。

**通道把问题送到你面前。** 默认桌面通知；飞书用卡片按钮，钉钉、企微、Slack、Discord 用文字和回答链接。也可以只用 `agent-hub status` 和 `agent-hub answer`。

飞书已经真实跑通发送、点击和更新卡片；群机器人模板只用假服务测过。支持 stdio MCP 2025-11-25 的客户端可用 `agent-hub mcp` 查看、追溯、回答和处理事项。

## 拿来就用

- [每日早报](examples/recipes/morning-brief)：定时整理本地笔记和提交。
- [跟进 GitHub issue](examples/recipes/github-issues)：轮询新 issue，在本地改好后告诉你。
- [跟进线上报错](examples/recipes/ops-alerts)：对照代码查原因，需要重启时问你。

## 交付流水线

给 PR 打 `deliver` 标签，交付插件会审查、等检查、合并、等 Ship，再核对健康接口里的版本。配置只读 main，PR 的代码、测试和配置不在接单电脑上执行。

队列、并发和重试沿用中台。[配置交付流水线](skills/agent-hub/SKILL.md#交付流水线)。

## 没有界面

中台没有总览页；需要你判断时发卡片，平时用命令行看状态。卡片链接只是一个不跑脚本的表单。

需要自己的页面，可以用 `GET /v1/state` 和 `GET /v1/stream` 做客户端，和命令行使用同一份协议。

## 六条原则

1. **注意力最贵。** 没事不打扰，需要你判断时才提问。
2. **一切都是事件。** 外部变化、时间、复查和回答使用同一套处理方式。
3. **一切都连进来。** 内核不发对外请求，凭据留在使用它的插件里。
4. **Agent 就是一个进程。** 给它提示词，读取最后一条消息。
5. **一轮不等人。** 提问后结束进程，收到回答后再启动。
6. **规则才是指令。** 事件里的文字是资料，不能决定目录、Agent 和权限。

## 用量和条款

中台启动你已经安装和登录的命令行工具，不读取或转存它们的登录凭据。模型调用计入你自己的账号，额度和允许的使用方式由各家服务条款决定。

自动化场景下，各家都更推荐用 API Key，个人订阅的额度是按普通个人使用设计的：见 [Anthropic](https://code.claude.com/docs/en/legal-and-compliance) 和 [OpenAI](https://learn.chatgpt.com/docs/auth) 的说明。要拿它给别人提供服务，请用 API Key。

本项目不是这些厂商的产品，也没有得到它们的背书。

## 文档

- [安装说明](INSTALL.md)
- [配置手册](skills/agent-hub/SKILL.md)
- [写插件](docs/plugins.md)
- [完整协议](docs/protocol.md)
- [安全边界](SECURITY.md)
- [开发约定](AGENTS.md)

[MIT](LICENSE)
