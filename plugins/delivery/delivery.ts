import { settings, type Settings, type Live } from "./project.ts";
import type { Finding } from "./review.ts";

export type DeliveryIO = {
  api(path: string, body?: any, method?: string): Promise<any>;
  review(pr: any, s: Settings, main: string): Promise<Finding[]>;
  merge(pr: any, s: Settings): Promise<void>;
  disableAuto(number: number): Promise<void>;
  contains(base: string, head: string): Promise<boolean>;
  releaseRequired(base: string, head: string, patterns: string[]): Promise<boolean>;
  live(s: Settings): Promise<Live | null>;
  wait(): Promise<void>;
};
export type Delivered = { summary: string; merged?: string; reviewOnly?: boolean; findings?: Finding[] };
const labels = (pr: any) => new Set<string>((pr.labels ?? []).map((l:any) => l.name));
export const status = (io: DeliveryIO, head: string, context: string, state: string, description: string) => io.api(`statuses/${head}`, { state, context, description: [...description].slice(0,140).join("") }, "POST");

export async function disableAuto(number: number, io: DeliveryIO) {
  for (let i = 0; i < 3; i++) {
    try { await io.disableAuto(number); } catch { /* A lost mutation response must be read back, not assumed. */ }
    try { if (!(await io.api(`pulls/${number}`)).auto_merge) return; }
    catch { /* Known failure: a failed read-back must still confirm cancellation within three attempts. */ }
    if (i < 2) await io.wait();
  }
  throw new Error("无法确认自动合并已关闭");
}
export async function fullCheck(head: string, s: Settings, io: DeliveryIO): Promise<"passed" | "waiting" | "failed"> {
  const runs = (await io.api(`actions/workflows/${s.check.workflow}/runs?head_sha=${head}&event=pull_request&per_page=100`)).workflow_runs;
  const run = runs.filter((r:any) => r.head_sha === head && r.event === "pull_request").sort((a:any,b:any) => b.id-a.id)[0];
  if (!run) return "waiting";
  const jobs = (await io.api(`actions/runs/${run.id}/jobs?filter=latest&per_page=100`)).jobs.filter((j:any) => j.name === s.check.job);
  if (!jobs.length) return "waiting";
  if (run.status === "completed" && run.conclusion !== "success") return "failed";
  return run.status === "completed" && run.conclusion === "success" && jobs.every((j:any) => j.status === "completed" && j.conclusion === "success") ? "passed" : "waiting";
}
export async function waitLive(merged: string, s: Settings, io: DeliveryIO) {
  if (!s.health) return;
  for (;;) {
    const runs = (await io.api(`actions/workflows/${s.ship.workflow}/runs?branch=main&event=push&per_page=100`)).workflow_runs.sort((a:any,b:any) => b.id-a.id);
    const covering = [];
    for (const run of runs) if (run.event === "push" && await io.contains(merged, run.head_sha)) covering.push(run);
    const live = await io.live(s);
    if (live) for (const run of covering) {
      if (run.status === "completed" && run.conclusion === "success"
        && (await io.contains(run.head_sha, live.sha) || !await io.releaseRequired(live.sha, run.head_sha, s.internal))) return;
    }
    const newest = covering[0];
    if (newest?.status === "completed" && newest.conclusion !== "success") throw new Error("已经合并，发布没有通过；修复发布后重交，不要重复提交代码");
    await io.wait();
  }
}
export async function deliver(repo: string, number: number, io: DeliveryIO, testLocalHealth = false): Promise<Delivered> {
  let pr = await io.api(`pulls/${number}`);
  if (!pr.merged_at && (pr.state !== "open" || !labels(pr).has("deliver"))) return { summary: "没有待交付的标记" };
  if (pr.head.repo?.full_name !== repo || pr.base.ref !== "main") throw new Error("只处理本仓库分支到 main 的合并请求");
  if (pr.auto_merge) await disableAuto(number, io);
  const main = (await io.api("git/ref/heads/main")).object.sha;
  const file = await io.api(`contents/ops/delivery.json?ref=${main}`);
  const s = settings(JSON.parse(Buffer.from(file.content,"base64").toString("utf8")), testLocalHealth);
  if (s.repo !== repo) throw new Error("main 的 repo 设置与交付仓库不一致");
  const head = pr.head.sha;
  await status(io, head, "delivery", "pending", "正在审查、检查和核实发布");
  if (!pr.merged_at) {
    if (!await io.contains(main, head)) {
      await io.api(`pulls/${number}/update-branch`, { expected_head_sha: head }, "PUT");
      throw new Error("已请求同步 main，稍后重新审查同步后的提交");
    }
    const findings = await io.review(pr, s, main);
    const current = await io.api(`pulls/${number}`);
    if (current.head.sha !== head) throw new Error("审查期间提交变了，等待重新交付");
    if (findings.length) {
      await status(io, head, "delivery", "failure", "审查发现问题，修复后重新交付");
      return { summary: "审查发现问题，尚未合并", findings };
    }
    if (labels(current).has("deliver-review")) {
      await status(io, head, "delivery", "success", "审查通过，未合并或发布");
      await clearLabels(number, current, io); return { summary: "审查通过，未合并或发布", reviewOnly: true };
    }
    if (current.draft) await io.api(`pulls/${number}/ready`, {}, "POST");
    for (;;) {
      const state = await fullCheck(head, s, io);
      if (state === "failed") throw new Error("完整检查没有通过");
      if (state === "passed") break;
      if ((await io.api(`pulls/${number}`)).head.sha !== head) throw new Error("检查期间提交变了");
      await io.wait();
    }
    pr = await io.api(`pulls/${number}`);
    if (pr.head.sha !== head) throw new Error("要合并的提交没有经过本轮审查");
    if (!pr.merged_at) {
    if ((await io.api("git/ref/heads/main")).object.sha !== main) throw new Error("main 已前进，稍后重新同步和检查");
    if (!labels(pr).has("deliver")) return { summary: "交付标记已撤回" };
    await status(io, head, s.review.status, "success", "此提交审查通过，完整检查通过");
    try { await io.merge(pr, s); } catch (error) {
      if (!(await io.api(`pulls/${number}`)).merged_at) throw error;
    }
    pr = await io.api(`pulls/${number}`);
    if (!pr.merged_at) throw new Error("尚未确认合并，稍后继续核实");
    }
  }
  await waitLive(pr.merge_commit_sha, s, io);
  const summary = s.health ? "已合并、发布成功，健康版本已核实" : "已合并；项目没有线上服务";
  await status(io, pr.head.sha, "delivery", "success", summary);
  await clearLabels(number, pr, io);
  return { summary, merged: pr.merge_commit_sha };
}
async function clearLabels(number: number, pr: any, io: DeliveryIO) {
  for (const label of ["deliver", "deliver-attended", "deliver-review"]) if (labels(pr).has(label)) {
    try { await io.api(`issues/${number}/labels/${label}`, undefined, "DELETE"); }
    catch (error) {
      // GitHub returned 404 after an observed labelled PR had already completed Ship; verify the desired state.
      if (labels(await io.api(`pulls/${number}`)).has(label)) throw error;
    }
  }
}
