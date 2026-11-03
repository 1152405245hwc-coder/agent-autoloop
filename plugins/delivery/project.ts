import { execFileSync, spawnSync } from "node:child_process";

export type Settings = {
  repo: string; internal: string[]; admin_merge: string[];
  check: { workflow: string; job: string }; ship: { workflow: string };
  review: { points: string; xhigh: string[]; status: string; command?: string[] };
  health?: { url: string; require: Record<string, unknown>; field: string; pattern: string };
};
export type Live = { sha: string; release: string };
const words = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === "string" && x.length > 0);
const paths = (v: unknown) => words(v) && v.every(p => !p.startsWith("/") && !p.split("/").includes(".."));
export function settings(value: any, testLocalHealth = false): Settings {
  const bad = () => { throw new Error("ops/delivery.json 的设置不正确"); };
  if (!value || !/^[\w.-]+\/[\w.-]+$/.test(value.repo ?? "") || !paths(value.internal)
    || Object.keys(value).some(k => !["repo", "internal", "admin_merge", "check", "ship", "review", "health"].includes(k))) bad();
  const r = value.review;
  if (!r || !paths([r.points]) || r.xhigh !== undefined && !paths(r.xhigh)
    || r.command !== undefined && (!words(r.command) || !r.command.length)
    || r.status !== undefined && (typeof r.status !== "string" || !r.status.trim())) bad();
  if (value.admin_merge !== undefined && !words(value.admin_merge)) bad();
  for (const w of [value.check?.workflow, value.ship?.workflow]) if (w !== undefined && !/^[\w.-]+\.ya?ml$/.test(w)) bad();
  if (value.check?.job !== undefined && (typeof value.check.job !== "string" || !value.check.job)) bad();
  if (value.health) {
    const h = value.health, url = new URL(h.url);
    if (!(url.protocol === "https:" || testLocalHealth && url.protocol === "http:" && url.hostname === "127.0.0.1") || url.username || url.password) bad();
    if (typeof h.field !== "string" || typeof h.pattern !== "string" || !/\(\?(?:P)?<sha>/.test(h.pattern)) bad();
    new RegExp(h.pattern.replace("(?P<sha>", "(?<sha>"));
    if (h.require !== undefined && (!h.require || typeof h.require !== "object" || Array.isArray(h.require))) bad();
  }
  return { ...value, admin_merge: value.admin_merge ?? [], check: { workflow: "check.yml", job: "check", ...value.check },
    ship: { workflow: "ship.yml", ...value.ship }, review: { xhigh: [], status: "agent-review", ...r },
    ...(value.health && { health: { require: {}, ...value.health } }) };
}

export function git(root: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args], { cwd: root, encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
}
export function readMainSettings(root: string, testLocalHealth = false, ref = "origin/main") {
  return settings(JSON.parse(git(root, "show", `${ref}:ops/delivery.json`)), testLocalHealth);
}
export function matches(name: string, patterns: string[]) {
  return patterns.some(pattern => new RegExp("^" + pattern.split(/(\*\*\/|\*)/).map(part => part === "**/" ? "(?:.*/)?" : part === "*" ? "[^/]*" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$").test(name));
}
export function releaseRequired(root: string, base: string, head: string, patterns: string[]) {
  if (spawnSync("git", ["merge-base", "--is-ancestor", base, head], { cwd: root, stdio: "ignore" }).status !== 0) return true;
  const records = git(root, "diff", "--raw", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", base, head, "--").split("\0");
  for (let i = 0; i + 1 < records.length; i += 2) {
    const modes = records[i].replace(/^:/, "").split(" ").slice(0, 2);
    if (modes.some(m => !["000000", "100644"].includes(m)) || !matches(records[i + 1], patterns)) return true;
  }
  return false;
}
export async function liveRelease(s: Settings, request: typeof fetch = fetch): Promise<Live | null> {
  if (!s.health) return null;
  try {
    const h = s.health, response = await request(h.url, { signal: AbortSignal.timeout(15000), redirect: "error", headers: { "cache-control": "no-cache" } });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body || Object.entries(h.require).some(([k,v]) => body[k] !== v) || typeof body[h.field] !== "string") return null;
    const release = body[h.field], match = new RegExp(`^(?:${h.pattern.replace("(?P<sha>", "(?<sha>")})$`).exec(release);
    const sha = match?.groups?.sha;
    return sha && /^[a-f0-9]{7,40}$/.test(sha) ? { sha, release } : null;
  } catch { return null; }
}
