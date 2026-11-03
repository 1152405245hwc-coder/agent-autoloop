import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, basename } from "node:path";
import { createInterface } from "node:readline";
import type { Turn } from "../../worker/agents.ts";

function resolved(file: string): string {
  if (existsSync(file)) return realpathSync(file);
  return resolve(resolved(dirname(file)), basename(file));
}

export function permission(turn: Pick<Turn, "access" | "cwd">, params: any) {
  const tool = params.toolCall ?? {};
  const inside = (location: any) => {
    if (typeof location.path !== "string" || !isAbsolute(location.path)) return false;
    const path = relative(realpathSync(turn.cwd), resolved(location.path));
    return path !== ".." && !path.startsWith("../") && !isAbsolute(path);
  };
  const allowed = turn.access === "full" || tool.kind === "read" || tool.kind === "search"
    || (turn.access === "edit" && tool.kind === "edit" && tool.locations?.length > 0 && tool.locations.every(inside));
  const option = params.options?.find((o: any) => o.kind === (allowed ? "allow_once" : "reject_once"));
  return option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" };
}

export async function bridge(turn: Turn) {
  if (!turn.command?.length) throw new Error("ACP 要在 command 写启动命令");
  const child = spawn(turn.command[0], turn.command.slice(1), { cwd: turn.cwd, stdio: ["pipe", "pipe", "inherit"] });
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let next = 0, session = "", collecting = false, text = "", message: string | undefined, boundary = false;
  const send = (body: object) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...body }) + "\n");
  const fail = (error: Error) => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  child.on("error", fail);
  child.on("exit", (code) => fail(new Error(`ACP 在交回结果前退出：${code}`)));
  child.stdin.on("error", fail);
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const m = JSON.parse(line);
      if (m.method === "session/update" && collecting && m.params?.sessionId === session) {
        const u = m.params.update;
        if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
          if (boundary || (u.messageId && u.messageId !== message)) text = "";
          message = u.messageId; boundary = false; text += u.content.text;
        } else if (["tool_call", "agent_thought_chunk", "user_message_chunk"].includes(u.sessionUpdate)) boundary = true;
      } else if (m.method && m.id !== undefined) {
        if (m.method === "session/request_permission" && m.params?.sessionId === session)
          send({ id: m.id, result: { outcome: permission(turn, m.params) } });
        else send({ id: m.id, error: { code: -32601, message: "不支持这个方法" } });
      } else if (pending.has(m.id)) {
        const p = pending.get(m.id)!; pending.delete(m.id);
        if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result);
      }
    } catch (error) { fail(error as Error); }
  });
  const rpc = (method: string, params: object) => new Promise<any>((resolve, reject) => {
    const id = ++next; pending.set(id, { resolve, reject }); send({ id, method, params });
  });
  const stop = () => child.kill("SIGTERM");
  process.on("SIGTERM", stop);
  try {
    const init = await rpc("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "agent-hub", version: "0.1.0" } });
    if (init.protocolVersion !== 1) throw new Error(`不支持 ACP 版本 ${init.protocolVersion}`);
    if (turn.resume) {
      if (!init.agentCapabilities?.loadSession) throw new Error("这个 ACP Agent 不支持恢复会话");
      session = turn.resume;
      await rpc("session/load", { sessionId: session, cwd: turn.cwd, mcpServers: [] });
    } else session = (await rpc("session/new", { cwd: turn.cwd, mcpServers: [] })).sessionId;
    if (typeof session !== "string" || !session) throw new Error("ACP 没有返回会话编号");
    console.log(JSON.stringify({ session }));
    collecting = true;
    const result = await rpc("session/prompt", { sessionId: session, prompt: [{ type: "text", text: turn.prompt }] });
    if (result.stopReason !== "end_turn" || !text.trim()) throw new Error(`ACP 没有完成这一轮：${result.stopReason}`);
    console.log(JSON.stringify({ session, text, finished: true }));
  } finally {
    process.removeListener("SIGTERM", stop); lines.close(); child.stdin.end(); child.kill("SIGTERM");
  }
}

if (import.meta.main) bridge(JSON.parse(process.argv[2])).catch(error => { console.error(error.message); process.exitCode = 1; });
