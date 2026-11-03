// The protocol's own checks, with no state behind them: the hub applies them at its door, and a worker applies them to an
// Agent's receipt before handing it in, while the Agent can still be asked to write it again.
import { InputError } from "../kernel/errors.ts";

export const EVENT_TYPE = /^[a-z][a-z0-9_.-]{0,63}$/;
export type Later = { key: string; at?: string; about?: string; cancel?: boolean };
export type Ask = { title: string; text: string; options: string[]; recommend?: number; about?: string; key?: string };
export type Notice = { title: string; text: string; key?: string };
export type Result = {
  outcome: "done" | "nothing" | "failed" | "cancelled"; summary?: string; error?: string; session?: string;
  usage?: { input?: number; output?: number; cached?: number; cost?: number };
  ask?: Ask[]; notice?: Notice[]; resolve?: { card: number; reason: string }[]; later?: Later[]; events?: EventInput[];
};
export type Rejected = { card?: number; what?: string; reason: string };

export type EventInput = { id: string; type: string; subject: string; summary: string; detail: string; link: string; hops:number };

const LIMITS = { id: 200, subject: 100, summary: 200, detail: 4000, link: 500 } as const;
const FIELDS = ["id", "type", "subject", "summary", "detail", "link", "hops"];

export function parseEvent(input: unknown): EventInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new InputError("事件要是一个 JSON 对象");
  const value = input as Record<string, unknown>;
  for (const name of Object.keys(value)) if (!FIELDS.includes(name)) throw new InputError(`不认识的字段：${name}`);
  const field = (name: keyof typeof LIMITS | "type", required = false) => {
    const v = value[name] ?? "";
    if (typeof v !== "string") throw new InputError(`${name} 要是文字`);
    if (required && !v) throw new InputError(`缺少 ${name}`);
    if (name !== "type" && [...v].length > LIMITS[name]) throw new InputError(`${name} 最多 ${LIMITS[name]} 个字`);
    return v;
  };
  const hops=value.hops===undefined?0:value.hops;
  if(!Number.isSafeInteger(hops)||(hops as number)<0)throw new InputError("hops 要是非负整数");
  const event = { id: field("id", true), type: field("type", true), subject: field("subject"), summary: field("summary"), detail: field("detail"), link: field("link"),hops:hops as number };
  if (!EVENT_TYPE.test(event.type)) throw new InputError("type 只能用小写字母、数字和 . _ -，以字母开头");
  // The subject and link go into the Agent's prompt, so neither may carry words: a subject is an identifier, a link a web
  // address in plain ASCII (anything else percent-encoded).
  if (!/^[A-Za-z0-9#._:\/@-]*$/.test(event.subject)) throw new InputError("subject 只能用字母、数字和 # . _ : / @ -");
  if (event.link && !/^https?:\/\/[\x21-\x7e]+$/.test(event.link)) throw new InputError("link 要是网址，非 ASCII 的字要先编码");
  return event;
}

const text = (v: unknown, limit: number) => typeof v === "string" && v.trim() !== "" && [...v].length <= limit;
const optional = (v: unknown, limit: number) => v === undefined || (typeof v === "string" && [...v].length <= limit);
const rows = (v: unknown, limit: number): v is Record<string, unknown>[] => v === undefined || (Array.isArray(v) && v.length <= limit && v.every((x) => typeof x === "object" && x !== null && !Array.isArray(x)));
const only = (item: object, names: string[]) => Object.keys(item).every((name) => names.includes(name));
export function dateTime(value:unknown):boolean {
  if(typeof value!=="string")return false;
  const parts=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.exec(value);
  if(!parts||!Number.isFinite(Date.parse(value)))return false;
  const [year,month,day,hour,minute,second]=parts.slice(1).map(Number),leap=year%4===0&&(year%100!==0||year%400===0);
  return month>=1&&month<=12&&day>=1&&day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1]&&hour<24&&minute<60&&second<60;
}

export function parseResult(input: unknown): Result {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new InputError("结果要是一个 JSON 对象");
  const v = { ...input } as Record<string, unknown>;
  if (!only(v, ["outcome", "summary", "error", "session", "usage", "ask", "notice", "resolve", "later", "events"])) throw new InputError("结果里有不认识的字段");
  if (!["done", "nothing", "failed", "cancelled"].includes(v.outcome as string)) throw new InputError("outcome 只能是 done、nothing、failed、cancelled");
  if (!optional(v.summary, 500) || !optional(v.error, 500) || !optional(v.session, 500)) throw new InputError("summary、error、session 最多 500 字");
  if (v.usage !== undefined && (typeof v.usage !== "object" || v.usage === null || Array.isArray(v.usage) || Object.values(v.usage).some((n) => typeof n !== "number" || !Number.isFinite(n) || n<0))) throw new InputError("usage 要是对象，里面要是有限的非负数字");
  if (!rows(v.ask, 5) || !v.ask?.every((a) => only(a, ["title", "text", "options", "recommend", "about", "key"]) && text(a.title, 200) && text(a.text, 4000) && optional(a.about, 4000) && optional(a.key, 100)
    && Array.isArray(a.options) && a.options.length >= 2 && a.options.length <= 5 && a.options.every((o) => text(o, 200))
    && (a.recommend === undefined || (Number.isInteger(a.recommend) && (a.recommend as number) >= 0 && (a.recommend as number) < (a.options as unknown[]).length))) && v.ask !== undefined) {
    throw new InputError("ask 每一项要有 title、text 和 2 到 5 个 options，recommend 是其中一个的序号，最多 5 项");
  }
  if (!rows(v.notice, 10) || !v.notice?.every((n) => only(n, ["title", "text", "key"]) && text(n.title, 200) && text(n.text, 4000) && optional(n.key, 100)) && v.notice !== undefined) {
    throw new InputError("notice 每一项要有 title 和 text，最多 10 项");
  }
  if (!rows(v.resolve, 50) || !v.resolve?.every((r) => only(r, ["card", "reason"]) && Number.isSafeInteger(r.card) && (r.card as number) > 0 && text(r.reason, 1000)) && v.resolve !== undefined) {
    throw new InputError("resolve 每一项要有卡片编号和 1000 字以内的核实依据，最多 50 项");
  }
  if (!rows(v.later, 10) || !v.later?.every((l) => only(l, ["key", "at", "about", "cancel"]) && text(l.key, 100) && (l.cancel === true
    ? l.at === undefined : dateTime(l.at) && text(l.about, 4000) && l.cancel === undefined)) && v.later !== undefined) {
    throw new InputError("later 每一项要有 key，以及带时区的 at 和 about，或者 cancel: true，最多 10 项");
  }
  if (v.events !== undefined) {
    if (!rows(v.events, 100)) throw new InputError("events 最多 100 项");
    v.events = v.events.map(parseEvent);
  }
  return v as Result;
}
