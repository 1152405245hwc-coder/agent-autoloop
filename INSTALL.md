# 安装说明（写给 Agent）

你是用户的 Agent，用户请你装好 Agent 自动化中台。照下面做，能自己做的不要问用户。

## 1. 装

要有 Node.js 24 或更新、git，以及至少一个已经登录的命令行 Agent（Claude Code、Codex，或任何能打印最后一条消息的 CLI）。缺 Node 或 git 就用这台电脑的包管理器装好。

```bash
curl -fsSL https://raw.githubusercontent.com/KKKKhazix/agent-hub/main/install.sh | sh
```

它会把程序克隆到 `~/.agent-hub/app`，建好配置、密钥和第一条规则，装成系统服务。不会改用户的任何项目，也不会碰 Claude Code 或 Codex 的登录。

只有别的 CLI 时：`sh install.sh --command 'hermes chat -Q -q {prompt}'`。

## 2. 验

```bash
agent-hub doctor
agent-hub try
```

不方便交互时让 Agent 代为运行命令和读状态。`try` 用用户自己的 Agent 跑一遍完整流程：Agent 干活、问一个问题、等回答、接着把活干完。用量很小。

你不是在用户的终端里运行时，它把问题打印出来就退出。把问题转给用户，用它打印的 `agent-hub answer` 回答，过一会儿运行 `agent-hub status`，看到“试跑通过”就是通了。

## 3. 问用户想让什么事自己发生

问一句：“有什么事你希望它发生时 Agent 自己去处理？比如每天早上做一件事、有人提 issue、线上报错。”然后照 `skills/agent-hub/SKILL.md` 写规则，用 `agent-hub check` 检查。规则文件改了几秒内生效。

再问一句：Agent 有事问他时发到哪？飞书，或者钉钉、企微、Slack、Discord 这类能往群里发消息的地方，接法见 `skills/agent-hub/SKILL.md`。不接通道也能用，只是要他自己运行 `agent-hub status` 才看得到。要接外部 Webhook 或多台电脑，就把中台放到一台服务器上（同一节）。

## 不要做的事

- 不要替用户登录 Claude Code、Codex 或别的账号，不要读、不要复制它们的凭据。
- 不要把 `access` 设成 `full`，除非用户明确要求：那是完整权限、不审批。

## 日志与恢复

开发测试用 `npm test`、`npm run typecheck`、`npm run format:check`；完整故障与预算检查用 `npm run test:nightly`。这些命令自己建临时目录和随机端口，不需要装系统服务。检查其他实现时，用 `agent-hub conformance <测试地址> --config <测试凭据文件>`，格式见协议。

`kernel/` 不读时钟、不取随机数。`evolve` 更新视图，`commit` 在 WAL + FULL 事务里追加事实，提交后才应答。`agent-hub why 42` 查一轮的事件、规则和回执；`GET /v1/stream?after=42` 供本人客户端按序号续读。备份要一起保留 `hub.db` 和权限为 0600 的 `master.key`；后者推导轮次和卡片链接的 token。普通访问密钥只保存哈希。

## 可选接入

内置 Agent 是 `claude`、`codex`、`command`、`acp`，交付另用 `delivery`。其他 CLI 的命令和实测支持范围见 README。第三方插件用 `agent-hub add <git 地址>` 安装，根目录放对应的 `agent.ts`、`channel.ts`、`source.ts`。

`agent-hub mcp` 供支持 stdio 2025-11-25 的客户端使用；启动参数和现有密钥的使用方式见配置手册。`agent-hub key remove <种类> <名字>` 会立即撤销访问。

要自动交付 PR，按配置手册的「交付流水线」设置 `ops/delivery.json` 和中台规则；先确认用户已经授权该项目的审查、合并、发布。不要在接单电脑执行 PR 的代码或设置。Ship 使用本仓库发布后固定到完整提交的 Action。
