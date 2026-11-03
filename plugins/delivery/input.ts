import type { Delivered } from "./delivery.ts";

export function subjectNumber<E extends { subject: string }>(repo: string, context: { events: E[] }) {
  const subjects = [...new Set(context.events.map(e => e.subject))];
  const suffix = subjects[0]?.slice(repo.length + 1);
  if (subjects.length !== 1 || !subjects[0].startsWith(`${repo}#`) || !/^[1-9]\d*$/.test(suffix)) throw new Error("事件没有指向规则指定仓库的同一个事项");
  const number=Number(suffix);if(!Number.isSafeInteger(number))throw new Error("事项编号不正确");return number;
}
export function question(issue: { number: number; title: string; body?: string; html_url: string }) {
  const text = (issue.body ?? "").replace(/```[\s\S]*?```/g, "").split("\n")
    .filter(line => !/\/Users\/|\/home\/|Traceback|^\s+at /.test(line)).join("\n").trim();
  return { key: `owner-${issue.number}`, title: [...issue.title].slice(0,100).join(""), text: [...(text || issue.html_url)].slice(0,1500).join(""),
    options: ["已处理", "暂不处理"], about: issue.html_url };
}
export function deliveryReceipt(number: number, result: Delivered, attended: boolean) {
  if(!result.findings?.length)return result.summary;
  const text=result.findings.map(f=>`${f.title}：${f.text}`).join("\n");
  if(attended)return `${result.summary}\n${text}`;
  return `${result.summary}\n\`\`\`agent-hub\n${JSON.stringify({notice:[{key:`review-${number}`,title:"交付前需要修复问题",text:[...text].slice(0,1500).join("")}]})}\n\`\`\``;
}
export function pendingEvents(repo: string, rows: { number: number; head: string; labelEvent: number; kind: string }[]) {
  return rows.map(row => ({ id: `${repo}#${row.number}:${row.labelEvent}:${row.head}`, type: `${row.kind}.labeled`, subject: `${repo}#${row.number}`, link: `https://github.com/${repo}/${row.kind === "pull_request" ? "pull" : "issues"}/${row.number}` }));
}
