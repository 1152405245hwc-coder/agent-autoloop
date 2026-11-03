import { createInterface } from "node:readline";
import { readConfig } from "../src/config.ts";
import { hubClient } from "../src/client.ts";

const number = { type: "integer", minimum: 1 };
const string = { type: "string", minLength: 1 };
const specs = [
  ["status", "查看现在的事项和卡片", {}, []],
  ["why", "查看一轮的事件、规则和结果", { run: number }, ["run"]],
  ["answer", "回答卡片；选项从 0 开始，也可以写自己的答案", { card: number, choice: { type: "integer", minimum: 0 }, text: string }, ["card"]],
  ["resolve", "将卡片结案，写明已核实的结果", { card: number, reason: string }, ["card", "reason"]],
  ["stop", "停止一轮", { run: number }, ["run"]],
  ["emit", "用本机来源发送事件；相同编号只记一次", { id: string, type: string, subject: string, summary: string, detail: string, link: string }, ["id", "type"]],
  ["tell", "用本机来源发送通知；相同编号只发一次", { key: string, text: string }, ["key", "text"]],
] as const;

export async function mcp() {
  const config = readConfig();
  const tools = specs.filter(([name]) => ["emit", "tell"].includes(name) ? config.source : config.owner)
    .map(([name, description, properties, required]) => ({ name, description, inputSchema: { type: "object", properties, required, additionalProperties: false }, annotations: { readOnlyHint: ["status", "why"].includes(name), destructiveHint: name === "stop" } }));
  let initialized = false, ready = false;
  const reply = (id: unknown, body: object) => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...body }));
  for await (const line of createInterface({ input: process.stdin })) {
    let request: any;
    try { request = JSON.parse(line); } catch { reply(null, { error: { code: -32700, message: "不是 JSON" } }); continue; }
    if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") { reply(request?.id ?? null, { error: { code: -32600, message: "请求格式不正确" } }); continue; }
    if (request.id === undefined) {
      if (request.method === "notifications/initialized" && initialized) ready = true;
      continue;
    }
    const { id, method, params } = request;
    if (method === "initialize") {
      if (!params?.protocolVersion || !params?.capabilities || !params?.clientInfo) { reply(id, { error: { code: -32602, message: "缺少初始化参数" } }); continue; }
      initialized = true;
      reply(id, { result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "agent-hub", version: "0.1.0" } } }); continue;
    }
    if (method === "ping") { reply(id, { result: {} }); continue; }
    if (!ready) { reply(id, { error: { code: -32600, message: "先完成 initialize" } }); continue; }
    if (method === "tools/list") { reply(id, { result: { tools } }); continue; }
    if (method !== "tools/call") { reply(id, { error: { code: -32601, message: "没有这个方法" } }); continue; }
    const tool = tools.find(t => t.name === params?.name), args = params?.arguments ?? {};
    const valid = tool && args && typeof args === "object" && !Array.isArray(args)
      && tool.inputSchema.required.every(key => Object.hasOwn(args, key))
      && Object.entries(args).every(([key, value]) => {
        const schema = (tool.inputSchema.properties as Record<string, any>)[key];
        return schema && (schema.type === "integer" ? Number.isSafeInteger(value) && (value as number) >= schema.minimum : typeof value === "string" && value.trim().length > 0);
      }) && (tool.name !== "answer" || (args.choice !== undefined) !== (args.text !== undefined));
    if (!valid) { reply(id, { error: { code: -32602, message: "工具名或参数不正确" } }); continue; }
    const hub = hubClient(config.url, ["emit", "tell"].includes(tool.name) ? config.source!.key : config.owner!);
    try {
      let result: unknown;
      switch (tool.name) {
        case "status": result = await hub.state(); break;
        case "why": result = await hub.why(args.run); break;
        case "answer": { const { card, ...answer } = args; result = await hub.answer(card, answer); break; }
        case "resolve": result = await hub.resolve(args.card, args.reason); break;
        case "stop": result = await hub.cancel(args.run); break;
        case "emit": result = await hub.event(args); break;
        case "tell": result = await hub.tell(args); break;
      }
      reply(id, { result: { content: [{ type: "text", text: JSON.stringify(result) }] } });
    } catch (error) { reply(id, { result: { isError: true, content: [{ type: "text", text: (error as Error).message }] } }); }
  }
}
