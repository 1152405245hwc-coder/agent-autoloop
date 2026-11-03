// rules.json: the sources that may send events, the agents that do the work, the channels that reach the owner, and the
// rules between them; and, only to be shown, the scheduled tasks that run elsewhere. The owner changes it by asking an
// Agent. A mistake is caught here with a message saying where: at start it stops the hub, later it leaves the old rules
// running and the owner is told (schedule.ts).
import { nextRun, parseCron } from "./cron.ts";

export type Access = "read" | "edit" | "full";
export type Source = { name: string; adapter?: string };
export type Agent = { name: string; worker: string; use: string; model?: string; effort?: string; access: Access; command?: string[]; timeout?: number };
export type Channel = { name: string; answerers?: string[]; links?: boolean };
export type Tell = "always" | "needed" | "never";
/** Without parallel a rule's group runs one at a time; with it, each subject is its own thread, that many at once at most. */
export type Rule = {
  name: string; when: { source: string; types: string[] } | { cron: string }; to: string; cwd: string; skill?: string; prompt?: string;
  group: string; parallel?: number; tell: Tell; emits?: { source: string; types: string[] };
};
/** A scheduled task that runs elsewhere (say, in the Claude app): the hub neither starts nor records it. */
export type Elsewhere = { name: string; source: string; to: string; cron: string; where: string };
export type Rules = {
  timezone: string; askFirst: string[]; sources: Record<string, Source>; agents: Record<string, Agent>;
  channels: Record<string, Channel>; rules: Rule[]; elsewhere: Elsewhere[];
};

export class RulesError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`rules.json 有问题：\n${issues.join("\n")}`);
    this.issues = issues;
  }
}

/** The source of what the clock makes happen. */
export const SCHEDULE = "schedule";
const ACCESS = ["read", "edit", "full"];
const TELLS = ["always", "needed", "never"];
const ID = /^[a-z][a-z0-9-]*$/;
const TYPE_PATTERN = /^(\*|[a-z][a-z0-9_.-]{0,63}(\.\*)?)$/;
const ASK_FIRST = ["删数据", "停服", "花钱", "对外发消息", "改产品方向", "新建或轮换密钥", "修改权限"];

type Field = [name: string, check: (value: unknown) => boolean, problem: string, optional?: boolean];
const text = (v: unknown) => typeof v === "string" && v.trim() !== "";
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const words = (v: unknown) => Array.isArray(v) && v.every(text);
const list = (v: unknown) => words(v) && (v as string[]).length > 0;

/** Each field present and well formed, and no others: a misspelt field would otherwise be silently ignored. */
function fields(where: string, value: unknown, spec: Field[], issues: string[]) {
  if (!object(value)) return void issues.push(`${where}要是一个对象`);
  for (const [name, check, problem, optional] of spec) {
    if (!(name in value)) {
      if (!optional) issues.push(`${where}缺少 ${name}`);
    } else if (!check(value[name])) issues.push(`${where}的 ${name} ${problem}`);
  }
  for (const name of Object.keys(value)) if (!spec.some(([known]) => known === name)) issues.push(`${where}有不认识的字段 ${name}`);
}

function validZone(zone: unknown) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone as string });
    return text(zone);
  } catch {
    return false;
  }
}

export function parseRules(json: string, now: number, timezone: string): Rules {
  const issues: string[] = [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new RulesError([`不是 JSON：${(error as Error).message}`]);
  }
  fields("rules.json ", parsed, [
    ["timezone", validZone, "不是有效的时区", true], ["askFirst", words, "要是文字的列表", true],
    ["sources", object, "要是一个对象"], ["agents", object, "要是一个对象"], ["channels", object, "要是一个对象", true],
    ["rules", Array.isArray, "要是一个列表"], ["elsewhere", Array.isArray, "要是一个列表", true],
  ], issues);
  if (issues.length) throw new RulesError(issues);
  const r = parsed as Rules;
  r.timezone ??= timezone;
  r.askFirst ??= ASK_FIRST;
  r.channels ??= {};
  r.elsewhere ??= [];
  if (SCHEDULE in r.sources) issues.push(`来源 ${SCHEDULE} 是保留的，定时用规则的 cron`);
  for (const [id, source] of Object.entries(r.sources)) {
    if (!ID.test(id)) issues.push(`来源的编号只能用小写字母、数字和 -：${id}`);
    fields(`来源 ${id} `, source, [["name", text, "不能为空"], ["adapter", text, "不能为空", true]], issues);
  }
  r.sources[SCHEDULE] = { name: "定时" };
  for (const [id, channel] of Object.entries(r.channels)) {
    if (!ID.test(id)) issues.push(`通道的编号只能用小写字母、数字和 -：${id}`);
    fields(`通道 ${id} `, channel, [["name", text, "不能为空"], ["answerers", words, "要是文字的列表", true], ["links", (v) => typeof v === "boolean", "要是 true 或 false", true]], issues);
  }
  for (const [id, agent] of Object.entries(r.agents)) {
    if (!ID.test(id)) issues.push(`Agent 的编号只能用小写字母、数字和 -：${id}`);
    const a: Record<string, unknown> = object(agent) ? agent : {};
    fields(`Agent ${id} `, agent, [
      ["name", text, "不能为空"],
      ["worker", (v) => typeof v === "string" && ID.test(v), "只能用小写字母、数字和 -"],
      ["use", (v) => typeof v === "string" && ID.test(v), "只能用小写字母、数字和 -"],
      ["model", text, "不能为空", true], ["effort", text, "不能为空", true],
      ["access", (v) => ACCESS.includes(v as string), `只能是 ${ACCESS.join("、")}`, true],
      ["command", list, "要是命令行的列表", a.use !== "command"],
      ["timeout", (v) => Number.isInteger(v) && (v as number) > 0, "要是正整数（分钟）", true],
    ], issues);
    if (object(agent)) (agent as Agent).access ??= "edit";
  }
  const names = new Set<string>();
  for (const rule of r.rules) {
    const name = object(rule) && typeof rule.name === "string" ? rule.name : "";
    const where = `规则「${name}」`;
    if (names.has(name)) issues.push(`规则名「${name}」重复了`);
    names.add(name);
    const when = object(rule) ? rule.when : undefined;
    const typed = object(when) && "source" in when;
    fields(where, rule, [
      ["name", text, "不能为空"],
      ["when", object, "要是一个对象"],
      ["to", (v) => typeof v === "string" && v in r.agents, `不是已登记的 Agent：${object(rule) ? rule.to : ""}`],
      ["cwd", (v) => typeof v === "string" && /^(~\/|\/)/.test(v), "要是以 ~/ 或 / 开头的目录"],
      ["skill", text, "不能为空", true], ["prompt", text, "不能为空", true],
      ["group", text, "不能为空", true],
      ["parallel", (v) => Number.isInteger(v) && (v as number) > 0, "要是正整数", true],
      ["tell", (v) => TELLS.includes(v as string), `只能是 ${TELLS.join("、")}`, true],
      ["emits", object, "要是一个对象", true],
    ], issues);
    if (object(when)) {
      if (typed) fields(`${where}的 when `, when, [
        ["source", (v) => typeof v === "string" && v in r.sources, `不是已登记的来源：${when.source}`],
        ["types", (v) => list(v) && (v as string[]).every((t) => TYPE_PATTERN.test(t)), "要是事件类型的列表，可以用 x.* 或 *"],
      ], issues);
      else fields(`${where}的 when `, when, [["cron", (v) => {
        const cron = typeof v === "string" ? parseCron(v) : null;
        if (!cron) return false;
        if (nextRun(cron, now, r.timezone) === null) issues.push(`${where}的定时永远不会到来：${v}`);
        return true;
      }, "不是有效的 cron"]], issues);
    }
    if (object(rule)) {
      // A plain command needs no words: a script that polls something is an agent too.
      if (!rule.skill && !rule.prompt && r.agents[rule.to]?.use !== "command") issues.push(`${where}的 skill 和 prompt 至少写一个`);
      if (object(rule.emits)) fields(`${where}的 emits `, rule.emits, [
        ["source", (v) => typeof v === "string" && v !== SCHEDULE && v in r.sources, `不是已登记的来源：${rule.emits.source}`],
        ["types", (v) => list(v) && (v as string[]).every((t) => TYPE_PATTERN.test(t)), "要是事件类型的列表"],
      ], issues);
      rule.group ??= rule.name;
      rule.tell ??= "needed";
    }
  }
  const limits = new Map<string, number | undefined>();
  for (const rule of r.rules) {
    if (limits.has(rule.group) && limits.get(rule.group) !== rule.parallel) issues.push(`组「${rule.group}」里的规则 parallel 要一致`);
    limits.set(rule.group, rule.parallel);
  }
  for (const task of r.elsewhere) {
    const name = object(task) && typeof task.name === "string" ? task.name : "";
    const where = `定时任务「${name}」`;
    if (names.has(name)) issues.push(`${where}和别的规则或定时任务重名`);
    names.add(name);
    fields(where, task, [
      ["name", text, "不能为空"],
      ["source", (v) => typeof v === "string" && v in r.sources, "不是已登记的来源"],
      ["to", (v) => typeof v === "string" && v in r.agents, "不是已登记的 Agent"],
      ["cron", (v) => typeof v === "string" && parseCron(v) !== null, "不是有效的 cron"],
      ["where", text, "不能为空"],
    ], issues);
  }
  if (issues.length) throw new RulesError(issues);
  return r;
}

export const typeMatches = (types: string[], type: string) => types.some(t => t === "*" || t === type || (t.endsWith(".*") && type.startsWith(t.slice(0, -1))));
export const eventRule = (rule: Rule): rule is Rule & { when: { source: string; types: string[] } } => "source" in rule.when;
export const cronOf = (rule: Rule) => (rule.when as { cron: string }).cron;
