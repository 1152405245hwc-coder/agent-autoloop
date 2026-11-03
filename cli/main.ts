// The command line: what a person, or their Agent, types.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { hubClient } from "../src/client.ts";
import { CONFIG_FILE, readConfig, writeConfig, type Config } from "../src/config.ts";
import { HOME, RULES_FILE } from "../src/home.ts";
import { installService, removeService, serviceRunning } from "../src/service.ts";

const HELP = `Agent 自动化中台

  agent-hub init [--agent claude|codex] [--command '某个命令 {prompt}'] [--port 3350] [--no-service]
                                    在这台电脑上装好：一个人一台电脑就够
  agent-hub try                     用你的 Agent 跑一遍完整流程
  agent-hub why <第几轮> [--json]  查看时间线；--json 输出原始事实
  agent-hub conformance <地址> --config <测试凭据文件>
                                    在测试中台上检查协议
  agent-hub status                  现在什么情况：谁在线、等你什么、在做什么、做过什么
  agent-hub answer <卡片> [序号] [--text 别的想法]
                                    回答一张卡片；通知不用写序号
  agent-hub resolve <卡片> <结果>   这件事不用决定了，写一句结果
  agent-hub doctor                  查哪里没配好
  agent-hub check                   检查 rules.json
  agent-hub emit <类型> [--subject x] [--summary x] [--detail x] [--link x] [--id x] [--key 来源密钥]
                                    发一条事件
  agent-hub tell <编号> [--task 定时任务名]
                                    直接告诉你一件事，内容从标准输入读
  agent-hub stop <第几轮>           停掉一轮
  agent-hub key new <source|worker|channel|owner> <名字>
                                    新建一把密钥（只显示这一次）
  agent-hub key list                有哪些密钥
  agent-hub key remove <种类> <名字>  立即收回一把密钥
  agent-hub add <git 地址>           安装插件，不自动更新
  agent-hub mcp                      用标准输入输出连接 MCP 客户端
  agent-hub join <中台地址> --worker <名字> --key <密钥>
                                    另一台电脑只接活时用
  agent-hub update                  更新到最新版
  agent-hub up                      启动（平时由系统服务调用）
  agent-hub service install|remove  系统服务

配置和数据在 ${HOME}。规则在 ${RULES_FILE}，改了自动生效。`;

function flags(args: string[]) {
  const named: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) { rest.push(args[i]); continue; }
    const name = args[i].slice(2);
    if (args[i + 1] !== undefined && !args[i + 1].startsWith("--")) named[name] = args[++i];
    else named[name] = true;
  }
  return { named, rest };
}
const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);
const fail = (words: string): never => { console.error(words); process.exit(1); };

const client = (key: string, config = readConfig()) => hubClient(config.url, key);
const ownerClient = (config = readConfig()) => client(config.owner ?? fail("这台电脑上没有本人的密钥（只接活的电脑看不了）"), config);

/** The first rules of a new install: its agents and one rule to try the whole loop with. */
function starterRules(agents: Record<string, object>, first: string) {
  return {
    sources: { local: { name: "本机" } },
    agents,
    channels: {},
    rules: [{
      name: "试一下",
      when: { source: "local", types: ["try.*"] },
      to: first,
      cwd: path.join(HOME, "try"),
      prompt: "这是 agent-hub try 的试跑，不要改任何文件，不要做别的事。读资料文件。如果 answers 是空的，就问一个问题：title 写“试跑：选一个颜色”，text 写“这是一次试跑，选哪个都行。”，options 写 [\"蓝色\",\"绿色\"]，key 写 try-color，第一行结论写“问了一个问题”。如果 answers 不是空的，第一行结论写“你选了某某，试跑通过”，把某某换成 answers 里选的那一项，不附回执。",
    }],
    elsewhere: [],
  };
}

/** Shows the user's Agents how to set it up. Only for the install in its usual place, and never over something of theirs. */
function linkSkill() {
  if (process.env.AGENT_HUB_HOME) return;
  for (const agent of [".claude", ".codex"]) {
    if (!existsSync(path.join(homedir(), agent))) continue;
    const link = path.join(homedir(), agent, "skills", "agent-hub");
    if (lstatSync(link, { throwIfNoEntry: false })) continue;
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(path.join(import.meta.dirname, "..", "skills", "agent-hub"), link);
  }
}

async function init(args: string[]) {
  const { named } = flags(args);
  if (existsSync(CONFIG_FILE)) return fail(`已经装过了：${CONFIG_FILE}`);
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  mkdirSync(path.join(HOME, "try"), { recursive: true });
  const worker = hostname().toLowerCase().replace(/\.local$/, "").replace(/[^a-z0-9-]/g, "-").replace(/^[^a-z]+/, "") || "this-machine";
  const agents: Record<string, object> = {};
  const command = text(named.command);
  if (command) agents.agent = { name: "Agent", worker, use: "command", command: command.split(/\s+/) };
  else {
    const wanted = text(named.agent);
    for (const name of ["claude", "codex"]) {
      if (wanted && wanted !== name) continue;
      const adapter = await (await import("../worker/agents.ts")).adapterFor(name);
      let installed = false;
      try {
        adapter.command({ prompt: "", session: "", resume: null, cwd: "", access: "edit", contextFile: "", folder: "" });
        installed = true;
      } catch {}
      if (installed) agents[name] = { name: name === "claude" ? "Claude Code" : "Codex", worker, use: name };
    }
    if (!Object.keys(agents).length) return fail("这台电脑上没找到 Claude Code 或 Codex。先装好并登录，或者用 --command 指定别的命令行 Agent，比如 --command 'hermes chat -Q -q {prompt}'");
  }
  const port = text(named.port) ?? "3350";
  const url = `http://127.0.0.1:${port}`;
  if (!existsSync(RULES_FILE)) writeFileSync(RULES_FILE, `${JSON.stringify(starterRules(agents, Object.keys(agents)[0]), null, 2)}\n`);
  const { addKey } = await import("../src/runtime.ts");
  const config: Config = {
    url,
    hub: { listen: `127.0.0.1:${port}`, publicUrl: url },
    worker: { name: worker, key: addKey("worker", worker) },
    source: { name: "local", key: addKey("source", "local") },
    owner: addKey("owner", "owner"),
  };
  writeConfig(config);
  linkSkill();
  if (!named["no-service"]) installService();
  console.log(`装好了。\n  Agent：${Object.values(agents).map((a) => (a as { name: string }).name).join("、")}\n  规则：${RULES_FILE}\n\n运行 agent-hub try 跑一遍完整流程。`);
}

async function join(args: string[]) {
  const { named, rest } = flags(args);
  const [url] = rest;
  const name = text(named.worker), key = text(named.key);
  if (!url || !name || !key) return fail("用法：agent-hub join <中台地址> --worker <名字> --key <密钥>");
  writeConfig({ url, worker: { name, key } });
  if (!named["no-service"]) installService();
  console.log(`这台电脑以 ${name} 的身份接活了。`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Card = { id: number; kind: string; title: string; text: string; options: string[]; recommend: number | null };

function showCard(card: Card) {
  console.log(`\n【${card.kind === "ask" ? "等你决定" : "要你留意"}】#${card.id} ${card.title}`);
  if (card.text) console.log(card.text);
  if (card.kind === "ask") card.options.forEach((option, i) => console.log(`  ${i + 1}. ${option}${i === card.recommend ? "（推荐）" : ""}`));
}

const howToAnswer = (card: Card) => (card.kind === "ask"
  ? `回答：agent-hub answer ${card.id} <序号>，或者 agent-hub answer ${card.id} --text '别的想法'`
  : `处理完了：agent-hub answer ${card.id}`);

async function chooseAt(terminal: ReturnType<typeof createInterface>, card: Card) {
  for (;;) {
    const choice = Number(await terminal.question("\n选几？"));
    if (Number.isInteger(choice) && choice >= 1 && choice <= card.options.length) return choice - 1;
    console.log(`输入 1 到 ${card.options.length}。`);
  }
}

async function tryIt() {
  const config = readConfig();
  if (!config.source) return fail("这台电脑上没有来源的密钥。");
  const owner = ownerClient(config);
  const stamp = Date.now();
  await client(config.source.key, config).event({ id: `try-${stamp}`, type: "try.start", subject: `#${stamp}` }).catch((error) => fail(`连不上中台（${error.message}）：先 agent-hub up 或 agent-hub service install`));
  console.log("事件发出去了，Agent 开始干活……");
  let asked: number | null = null;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    const state = await owner.state();
    const failed = state.runs.find((r: { rule: string; state: string; attempts: number; error: string }) => r.rule === "试一下" && r.state === "queued" && r.attempts > 0);
    if (failed) return fail(`Agent 没跑成：${failed.error}\n运行 agent-hub doctor 看看。`);
    if (asked === null) {
      const card: Card | undefined = state.cards.find((c: Card) => c.kind === "ask" && c.title.startsWith("试跑"));
      if (!card) continue;
      asked = card.id;
      console.log("\nAgent 结束了这一轮，问了你一个问题。它现在不占进程、不花 Token。");
      showCard(card);
      if (!process.stdin.isTTY) {
        console.log(`${howToAnswer(card)}\n答完运行 agent-hub status，能看到它接着把活干完。`);
        return;
      }
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      const choice = await chooseAt(terminal, card);
      terminal.close();
      await owner.answer(card.id, { choice });
      console.log("收到，Agent 接着干……");
      continue;
    }
    const done = state.recentCards.find((c: { id: number; state: string }) => c.id === asked && c.state === "done");
    if (done) {
      console.log(`它把活干完了：${done.result}\n\n通了。接下来把 ${RULES_FILE} 改成你自己的规则，或者跟你的 Agent 说一句。`);
      return;
    }
  }
  fail("十分钟没等到结果。运行 agent-hub doctor 看看。");
}

const RUN_STATES: Record<string, string> = { claimed: "在跑", queued: "排队", done: "做完了", nothing: "没事可做", unknown: "不确定", cancelled: "停了" };

async function status() {
  const state = await ownerClient().state();
  const t = state.totals;
  const at = (iso: string) => new Date(iso).toLocaleString("zh-CN", { timeZone: state.timezone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  console.log(`在跑 ${t.running} · 排队 ${t.queued} · 今天做完 ${t.doneToday} · 等你 ${state.cards.length}\n`);
  for (const a of state.agents) console.log(`${a.online ? "●" : "○"} ${a.name}（${a.worker}）`);
  for (const c of state.channels) console.log(`${c.online ? "●" : "○"} ${c.name}`);
  for (const c of state.cards) {
    showCard(c);
    console.log(howToAnswer(c));
  }
  const timed = [...state.lines.filter((l: { every: string | null }) => l.every), ...state.elsewhere];
  if (timed.length) console.log("\n定时");
  for (const line of timed) console.log(`  ${line.name}${line.where ? `（在别处：${line.where}）` : ""}：${line.every}，下次 ${at(line.next)}`);
  if (state.recentCards.length) console.log("\n最近的卡片");
  for (const c of state.recentCards.slice(0, 5)) {
    const chosen = c.choice !== null ? c.options[c.choice] : c.answer;
    console.log(`  #${c.id} ${c.title}：${[chosen, c.result].filter(Boolean).join("。") || c.text}`);
  }
  if (state.runs.length) console.log("\n最近几轮");
  for (const r of state.runs.slice(0, 8)) console.log(`  #${r.id} ${r.rule} ${r.state === "queued" && r.attempts > 0 ? "等重派" : (RUN_STATES[r.state] ?? r.state)}${r.summary || r.error ? `：${r.summary || r.error}` : ""}`);
  if (state.unrouted.length) console.log("\n没有规则接的事件");
  for (const e of state.unrouted.slice(0, 5)) console.log(`  ${e.source} ${e.type} ${e.subject}${e.summary ? `：${e.summary}` : ""}`);
}

async function answer(args: string[]) {
  const { named, rest } = flags(args);
  const card = Number(rest[0]);
  if (!Number.isInteger(card) || card < 1) return fail("用法：agent-hub answer <卡片> [序号] [--text 别的想法]");
  const words = text(named.text);
  const done = await ownerClient().answer(card, { ...(rest[1] !== undefined && { choice: Number(rest[1]) - 1 }), ...(words && { text: words }) });
  console.log(!done.changed ? "这张卡片已经处理过了，这次没有改动。" : done.state === "closed" ? "结案了。" : "收到，Agent 接着干。");
}

async function resolve(args: string[]) {
  const [id, ...words] = args;
  const card = Number(id);
  if (!Number.isInteger(card) || card < 1 || !words.length) return fail("用法：agent-hub resolve <卡片> <结果>");
  const { changed } = await ownerClient().resolve(card, words.join(" "));
  console.log(changed ? "结案了。" : "这张卡片已经处理过了，这次没有改动。");
}

async function doctor() {
  let bad = 0;
  const say = (ok: boolean, words: string) => {
    console.log(`${ok ? "✓" : "✗"} ${words}`);
    if (!ok) bad += 1;
  };
  say(Number(process.versions.node.split(".")[0]) >= 24, `Node ${process.versions.node}`);
  if (!existsSync(CONFIG_FILE)) return say(false, "还没装好：运行 agent-hub init");
  const config = readConfig();
  if (config.hub) {
    const { parseRules } = await importRules();
    try {
      parseRules(readFileSync(RULES_FILE, "utf8"));
      say(true, `规则 ${RULES_FILE}`);
    } catch (error) {
      say(false, (error as Error).message);
    }
  }
  say(serviceRunning(), serviceRunning() ? "系统服务在跑" : "系统服务没在跑：agent-hub service install");
  try {
    const health = await (await fetch(`${config.url}/healthz`, { signal: AbortSignal.timeout(5000) })).json();
    say(health.ok === true, `中台 ${config.url}（${String(health.commit).slice(0, 12)}）`);
  } catch (error) {
    say(false, `连不上中台 ${config.url}：${(error as Error).message}`);
  }
  if (config.owner) {
    try {
      const state = await ownerClient(config).state();
      for (const agent of state.agents) {
        say(agent.online, `${agent.name}（${agent.worker}）${agent.online ? "在线" : "不在线"}`);
        if (agent.worker === config.worker?.name) {
          const { adapterFor } = await import("../worker/agents.ts");
          const problem = await adapterFor(agent.use).then((adapter) => adapter.check?.() ?? null, (error) => String(error.message));
          say(!problem, problem ?? `${agent.name} 可以用`);
        }
      }
      for (const channel of state.channels) say(channel.online, `${channel.name}${channel.online ? "在线" : "不在线"}`);
      if (!state.channels.length) console.log("· 还没接通道：Agent 问你时不会主动告诉你，要自己运行 agent-hub status 看。接法见 skills/agent-hub/SKILL.md");
    } catch (error) {
      say(false, `读不到中台状态：${(error as Error).message}`);
    }
  }
  if (bad) process.exit(1);
}

/** The rules module reads the rules file as it loads; the checks here need to survive a bad one. */
async function importRules() {
  try {
    return await import("../src/runtime.ts");
  } catch (error) {
    fail((error as Error).message);
    throw error;
  }
}

async function check() {
  const { parseRules } = await importRules();
  parseRules(readFileSync(RULES_FILE, "utf8"));
  console.log("规则没问题。");
}

async function key(args: string[]) {
  const [action, kind, name] = args;
  if(action==="remove"){await ownerClient().removeKey(kind,name);console.log("密钥已失效。");return;}
  const { addKey, listKeys } = await import("../src/runtime.ts");
  if (action === "list") {
    for (const row of listKeys()) console.log(`${row.kind} ${row.name} ${row.created_at}`);
    return;
  }
  if (action !== "new" || !["source", "worker", "channel", "owner"].includes(kind) || !name) return fail("用法：agent-hub key new <source|worker|channel|owner> <名字>");
  console.log(addKey(kind as "source", name));
}

async function emit(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const type = rest[0] ?? fail("用法：agent-hub emit <类型>");
  const secret = text(named.key) ?? config.source?.key ?? fail("这台电脑上没有来源的密钥：用 --key");
  const answer = await client(secret, config).event({
    id: text(named.id) ?? randomUUID(), type,
    ...(text(named.subject) && { subject: text(named.subject) }), ...(text(named.summary) && { summary: text(named.summary) }),
    ...(text(named.detail) && { detail: text(named.detail) }), ...(text(named.link) && { link: text(named.link) }),
  });
  console.log(answer.routed.length ? `交给了：${answer.routed.join("、")}` : "记下了，没有规则接它。");
}

async function tell(args: string[]) {
  const { named, rest } = flags(args);
  const config = readConfig();
  const matter = rest[0] ?? fail("用法：agent-hub tell <编号> [--task 定时任务名]，内容从标准输入读");
  const words = readFileSync(0, "utf8").trim();
  if (!words) return fail("要说的话从标准输入传，不能为空。");
  const task = text(named.task);
  const secret = task ? config.worker?.key : config.source?.key;
  if (!secret) return fail(task ? "这台电脑不是接单程序" : "这台电脑上没有来源的密钥");
  const answer = await client(secret, config).tell({ key: matter, text: words, ...(task && { task }) });
  console.log(answer.duplicate ? "这件事已经说过了，这次没再发。" : "说了。");
}

async function update() {
  const root = path.join(import.meta.dirname, "..");
  const pulled = spawnSync("git", ["-C", root, "pull", "--ff-only"], { stdio: "inherit" });
  if (pulled.status !== 0) return fail("更新失败。");
  if (serviceRunning()) installService();
  console.log("更新好了。");
}

const [command, ...args] = process.argv.slice(2);
const commands: Record<string, () => unknown> = {
  mcp: async () => (await import("./mcp.ts")).mcp(),
  add:()=>{const url=args[0]??fail("用法：agent-hub add <git 地址>"),name=url.replace(/\/$/,"").split(/[/:]/).at(-1)!.replace(/\.git$/,"").toLowerCase();if(!/^[a-z][a-z0-9-]*$/.test(name))fail("插件仓库名要用小写字母、数字和 -");mkdirSync(path.join(HOME,"plugins"),{recursive:true});const clone=spawnSync("git",["clone","--",url,path.join(HOME,"plugins",name)],{stdio:"inherit"});if(clone.status!==0)fail("安装失败。");console.log(`已安装 ${name}。`);},
  init: () => init(args),
  join: () => join(args),
  up: async () => (await import("../src/up.ts")).up(),
  try: tryIt,
  status,
  why: async () => {
    const id=Number(args[0]),facts=await ownerClient().why(id);
    console.log(args.includes("--json") ? JSON.stringify(facts,null,2) : (await import("./why.ts")).formatWhy(id,facts));
  },
  conformance: async () => {const {named,rest}=flags(args);const file=text(named.config)??process.env.AGENT_HUB_CONFORMANCE;if(!rest[0]||!file)fail("用法：agent-hub conformance <测试中台地址> --config <测试凭据文件>");console.log(JSON.stringify(await (await import("../protocol/conformance.ts")).conformance(rest[0],JSON.parse(readFileSync(file!,"utf8"))),null,2));},
  answer: () => answer(args),
  resolve: () => resolve(args),
  doctor,
  check,
  key: () => key(args),
  emit: () => emit(args),
  tell: () => tell(args),
  stop: async () => { await ownerClient().cancel(Number(args[0])); console.log("通知它停了。"); },
  update,
  service: () => (args[0] === "install" ? installService() : args[0] === "remove" ? removeService() : fail("用法：agent-hub service install|remove")),
  help: () => console.log(HELP),
};
if (!command || !commands[command]) {
  console.log(HELP);
  if (command) process.exit(1);
} else {
  Promise.resolve().then(commands[command]).catch((error) => fail(error.message ?? String(error)));
}
