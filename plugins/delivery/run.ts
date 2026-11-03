import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createIO } from "./github.ts";
import { deliver, disableAuto, status } from "./delivery.ts";
import { question, subjectNumber, deliveryReceipt } from "./input.ts";

const fence="```";
export async function run(repo: string, context: any, testLocalHealth = false) {
  const number=subjectNumber(repo,context), folder=mkdtempSync(join(tmpdir(),"agent-hub-delivery-")),io=createIO(repo,folder);
  try {
    const issue=await io.api(`issues/${number}`);
    if(!issue.pull_request){
      if(issue.state!=="open"||!issue.labels.some((l:any)=>l.name==="ask-owner"))return "没事可做：没有待处理的问题";
      if(context.answers?.length){await io.api(`issues/${number}/labels/ask-owner`,undefined,"DELETE");return "已记录处理结果";}
      return `有一件事需要你处理\n${fence}agent-hub\n${JSON.stringify({ask:[question(issue)]})}\n${fence}`;
    }
    const result=await deliver(repo,number,io,testLocalHealth);
    return deliveryReceipt(number,result,issue.labels.some((l:any)=>l.name==="deliver-attended"));
  } catch(error) {
    const pr=await io.api(`pulls/${number}`);
    if(pr.auto_merge)await disableAuto(number,io);
    await status(io,pr.head.sha,"delivery","failure",(error as Error).message);
    throw error;
  } finally {rmSync(folder,{recursive:true,force:true});}
}
if(import.meta.main){
  const [repo,...args]=process.argv.slice(2);
  run(repo,JSON.parse(readFileSync(process.env.AGENT_HUB_CONTEXT!,"utf8")),args.includes("--test-local-health"))
    .then(text=>console.log(text)).catch(error=>{console.error((error as Error).message);process.exitCode=1;});
}
