import { appendFileSync } from "node:fs";
import { git, readMainSettings, liveRelease, releaseRequired, type Live } from "./project.ts";

export function decideShip(target: string, main: string, live: Live | null, required: (base: string, head: string) => boolean) {
  return { release: !live || required(live.sha,target), superseded: main !== target && required(target,main) };
}
if (import.meta.main) {
  const root = process.cwd(), target = process.env.INPUT_TARGET || process.env.GITHUB_SHA;
  if (!target || !/^[a-f0-9]{40}$/.test(target)) throw new Error("发布目标要是完整提交编号");
  git(root,"fetch","origin","main");
  const main = git(root,"rev-parse","origin/main"), s = readMainSettings(root, process.env.INPUT_TEST_LOCAL_HEALTH === "true", target);
  const live = await liveRelease(s);
  const decision = decideShip(target,main,live,(base,head)=>releaseRequired(root,base,head,s.internal));
  const output = Object.entries(decision).map(([key,value])=>`${key}=${value}\n`).join("");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output); else process.stdout.write(output);
}
