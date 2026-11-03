import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { git, liveRelease, releaseRequired } from "./project.ts";
import { reviewSnapshot } from "./review.ts";
import type { DeliveryIO } from "./delivery.ts";

export function gh(args: string[], input?: object) {
  return execFileSync("gh", args, { input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 60000,
    maxBuffer: 32 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
export function github(repo: string) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("仓库要写成 owner/name");
  return async (path: string, body?: any, method = body === undefined ? "GET" : "POST") => {
    const ready = /^pulls\/(\d+)\/ready$/.exec(path);
    if (ready) { gh(["pr", "ready", ready[1], "--repo", repo]); return {}; }
    const text = gh(["api", `repos/${repo}/${path}`, "--method", method, ...(body === undefined ? [] : ["--input", "-"])], body);
    return text ? JSON.parse(text) : {};
  };
}
export function pages(repo: string, path: string): any[] {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("仓库要写成 owner/name");
  return JSON.parse(gh(["api", `repos/${repo}/${path}`, "--paginate", "--slurp"])).flat();
}
export function createIO(repo: string, folder: string): DeliveryIO {
  const api = github(repo), bare = join(folder, "objects.git"), started = Date.now();
  let initialized = false;
  const fetchObjects = (...refs: string[]) => {
    if (!initialized) {
      mkdirSync(bare, { recursive: true }); git(bare,"init","--bare","--template=");
      git(bare,"remote","add","origin",`https://github.com/${repo}.git`); initialized = true;
    }
    git(bare,"fetch","--no-tags","origin",...refs);
  };
  const ancestors = new Map<string, boolean>();
  return {
    api,
    async review(pr,s,main) {
      fetchObjects(main,pr.head.sha);
      return reviewSnapshot(bare,join(folder,`review-${pr.head.sha}`),main,pr.head.sha,s);
    },
    async merge(pr,s) {
      if (s.admin_merge.includes(pr.user.login)) gh(["pr","merge",String(pr.number),"--repo",repo,"--squash","--admin","--match-head-commit",pr.head.sha]);
      else {
        const result=await api(`pulls/${pr.number}/merge`,{sha:pr.head.sha,merge_method:"squash"},"PUT");
        if (!result.merged) throw new Error("GitHub 没有接受合并");
      }
    },
    async disableAuto(number) { gh(["pr","merge",String(number),"--repo",repo,"--disable-auto"]); },
    async contains(base,head) {
      if(base===head)return true;const key=`${base}:${head}`;
      if(!ancestors.has(key)){const result=await api(`compare/${base}...${head}`);ancestors.set(key,["ahead","identical"].includes(result.status));}
      return ancestors.get(key)!;
    },
    async releaseRequired(base,head,patterns) {
      try { fetchObjects(base,head); } catch { return true; }
      return releaseRequired(bare,base,head,patterns);
    },
    live: liveRelease,
    async wait() { if(Date.now()-started>1800000)throw new Error("等待超过半小时，保留远端状态，稍后继续核实");await setTimeout(5000); },
  };
}
