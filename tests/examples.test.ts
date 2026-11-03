// Failure modes: shell examples cross credential boundaries, drop a receipt or forget the delivered version; answering a
// card does not resume its matter; the example exits successfully after an HTTP error. Only curl, jq and shell builtins run.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test,after } from "node:test";
import { setup } from "./helpers.ts";
import { conformance } from "../protocol/conformance.ts";
setup("examples");
const hub=await import("../src/runtime.ts"),{serve}=await import("../src/http.ts");
const keys={source:hub.addKey("source","app"),worker:hub.addKey("worker","w1"),channel:hub.addKey("channel","chat"),owner:hub.addKey("owner","me")};
const server=serve(0);await new Promise(resolve=>server.once("listening",resolve));after(()=>{server.closeAllConnections();server.close();});
const url=`http://127.0.0.1:${(server.address() as any).port}`;
const shell=(file:string,key:string,extra:Record<string,string>={})=>new Promise<{code:number|null,out:string,err:string}>(resolve=>{
 const child=spawn("sh",[`examples/${file}.sh`],{cwd: new URL("..",import.meta.url),env:{...process.env,AGENT_HUB_URL:url,AGENT_HUB_KEY:key,AGENT_HUB_ONCE:"1",...extra},stdio:["ignore","pipe","pipe"]});
 let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);child.on("close",code=>resolve({code,out,err}));
});
test("curl and jq examples run against a conforming hub and complete the answer loop",async()=>{
 const result=await conformance(url,{keys,eventType:"feedback.new",answerer:"me"});assert.ok(result.passed);
 for(const table of ["events","runs","run_events","cards","deliveries","timers","seen"] as const)hub.fixtureClear(table);
 hub.ingest("app",{id:"shell",type:"feedback.new",subject:"shell"});
 const receipt={outcome:"done",summary:"问了",ask:[{title:"选一个",text:"测试",options:["甲","乙"]}]};
 const worker=await shell("worker",keys.worker,{AGENT_HUB_RECEIPT:JSON.stringify(receipt),AGENT_HUB_CLAIM:"shell-1"});assert.equal(worker.code,0,worker.err);
 const channel=await shell("channel",keys.channel);assert.equal(channel.code,0,channel.err);
 const card=JSON.parse(channel.out);assert.equal(card.title,"选一个");
 const answer=await fetch(`${url}/v1/cards/${card.id}/answer`,{method:"POST",headers:{authorization:`Bearer ${keys.channel}`,"content-type":"application/json"},body:JSON.stringify({choice:0,by:"me",ref:`curl-${card.id}`})});assert.equal(answer.status,200);
 assert.equal((await shell("worker",keys.worker,{AGENT_HUB_CLAIM:"shell-2"})).code,0);
 assert.notEqual((await shell("worker",keys.channel)).code,0);
 assert.notEqual((await shell("channel",keys.worker)).code,0);
});
