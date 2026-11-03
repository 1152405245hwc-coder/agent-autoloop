import { AuthError, Conflict, InputError, NotFound } from "./errors.ts";
import { cardPage, PAGE_HEADERS, wordsPage } from "./card-page.ts";
import { agentsOf, configuration, whose, cancels, credential, cardView, type Environment } from "./query.ts";
import type { View, Row } from "./evolve.ts";

export type Services = {
  now():number; view():View; environment:Environment; commit:string;
  dispatch(type:string,args:any[],now:number):any;
  state(now:number,before?:number):unknown; why(id:number):unknown;
  wait(until:number,signal:AbortSignal):Promise<void>; stream(after:number,signal:AbortSignal,key:string):ReadableStream;
  adapt(source:string,headers:Headers,body:string):Promise<unknown[]>;
};
const MAX=1024*1024;
class TooLarge extends Error {}
async function raw(req:Request) {
  if(!req.body) return "";
  const reader=req.body.getReader(), chunks:Uint8Array[]=[];let size=0;
  for(;;) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size<=MAX)chunks.push(value);if(size>8*MAX)throw new TooLarge();}
  if(size>MAX)throw new TooLarge();return Buffer.concat(chunks).toString("utf8");
}
async function body(req:Request) {const text=await raw(req);try{return JSON.parse(text);}catch{throw new InputError("不是 JSON");}}
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const statusOf=(e:unknown)=>e instanceof TooLarge ? 413 : e instanceof InputError ? 400 : e instanceof AuthError ? 401 : e instanceof Conflict ? 409 : e instanceof NotFound ? 404 : 500;
export function createHandler(s:Services) {
  return async function handle(req:Request):Promise<Response> {
    const url=new URL(req.url), path=url.pathname, method=req.method, token=req.headers.get("authorization")?.replace(/^Bearer /,"") ?? "";
    const now=s.now(), v=s.view(), rules=configuration(v);
    const door=(kind:string)=>whose(v,kind,token);
    const requireDoor=(kind:string)=>{const who=door(kind);if(!who)throw new AuthError(`要${kind==="owner" ? "本人" : kind==="worker" ? "接单程序" : kind==="channel" ? "通道" : "来源"}自己的密钥`);return who;};
    const act=(type:string,...args:any[])=>s.dispatch(type,args,s.now());
    const waitMs=()=>Math.min(Math.max(Number(url.searchParams.get("wait") ?? 50)||0,0),50)*1000;
    const cardLink=/^\/c\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    try {
      if(method==="GET" && path==="/healthz")return json({ok:true,commit:s.commit});
      const remove=/^\/v1\/keys\/(source|worker|channel|owner)\/([a-z][a-z0-9-]*)$/.exec(path);
      if(method==="DELETE"&&remove){requireDoor("owner");act("removeKey",remove[1],remove[2]);return json({ok:true});}
      if(cardLink && ["GET","POST"].includes(method)) {
        const card=Object.values(v.tables.cards).find(c=>credential(s.environment,"card",c.id,c.created_at)===cardLink[1]);
        if(!card || !Object.values(rules.channels).some(c=>c.links))throw new NotFound("没有这张卡片");
        if(method==="GET")return new Response(cardPage(cardView(card,s.environment)),{headers:PAGE_HEADERS});
        if(now-Date.parse(card.created_at)>7*86400_000)throw new AuthError(`这个链接过期了。在装它的电脑上运行 agent-hub answer ${card.id} 回答`);
        const form=new URLSearchParams(await raw(req));
        act("answer",card.id,{...(form.has("choice")&&{choice:Number(form.get("choice"))}),text:form.get("text") ?? undefined,by:"链接"});
        return new Response(null,{status:303,headers:{location:path,"cache-control":"no-store"}});
      }
      const hook=/^\/v1\/in\/([a-z][a-z0-9-]*)$/.exec(path);
      if(method==="POST" && hook) {
        if(!rules.sources[hook[1]]?.adapter)throw new NotFound("这个来源不收 Webhook");
        const events=await s.adapt(hook[1],req.headers,await raw(req));
        return json({events:events.map(e=>act("ingest",hook[1],e))});
      }
      if(method==="POST" && path==="/v1/events") {const source=requireDoor("source");return json(act("ingest",source,await body(req)));}
      if(method==="POST" && path==="/v1/tell") {
        const source=door("source"),worker=source ? null : door("worker");if(!source&&!worker)throw new AuthError("要来源或接单程序的密钥");
        const input=await body(req),names=source ? ["key","text"] : ["key","task","text"],text=typeof input?.text==="string" ? input.text.trim() : "";
        if(!input||typeof input!=="object"||Object.keys(input).sort().join()!==names.join()||typeof input.key!=="string"||!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(input.key)||!text||[...text].length>20_000)throw new InputError("要有正确的 key 和 text，接单程序还要写 task，text 最多 20000 字");
        if(source)return json(act("tell",`source:${source}:${input.key}`,rules.sources[source]?.name ?? source,text));
        const task=rules.elsewhere.find(t=>t.name===input.task&&agentsOf(v,worker!).includes(t.to));if(!task)throw new AuthError("这台接单程序没有这个定时任务");
        return json(act("tell",`elsewhere:${task.name}:${input.key}`,task.name,text));
      }
      if(method==="GET" && path==="/v1/work") {
        const worker=requireDoor("worker"),claim=url.searchParams.get("claim") ?? "";
        if(!claim||claim.length>200)throw new InputError("claim 是这次领活的编号，最多 200 字");
        const running=(url.searchParams.get("running") ?? "").split(",").filter(n=>/^[1-9][0-9]*$/.test(n)).map(Number);
        act("heartbeat",worker,running);const until=now+waitMs();
        for(;;) {
          if(!whose(s.view(),"worker",token))throw new AuthError("密钥已失效");
          const job=!req.signal.aborted&&url.searchParams.get("capacity")!=="0" ? act("claimNext",worker,claim) : null;
          const cancel=cancels(s.view(),worker);
          if(job||cancel.length||s.now()>=until||req.signal.aborted)return json({job,cancel});
          await s.wait(until,req.signal);
        }
      }
      const run=/^\/v1\/runs\/([1-9][0-9]*)\/(started|result|cancel|why)$/.exec(path);
      if(run) {
        const id=Number(run[1]);
        if(method==="GET"&&run[2]==="why"){requireDoor("owner");return json(s.why(id));}
        if(method==="POST") {
          if(run[2]==="cancel"){requireDoor("owner");act("cancel",id);return json({ok:true});}
          if(run[2]==="started"){act("started",id,token,await body(req));return json({ok:true});}
          if(run[2]==="result")return json(act("finish",id,token,await body(req)));
        }
      }
      if(method==="GET" && path==="/v1/cards/next") {
        const channel=requireDoor("channel"),until=now+waitMs();act("channelSeen",channel);
        for(;;) {
          if(!whose(s.view(),"channel",token))throw new AuthError("密钥已失效");
          const card=req.signal.aborted ? null : act("nextCard",channel);
          if(card||s.now()>=until||req.signal.aborted)return json({card});
          await s.wait(until,req.signal);
        }
      }
      const card=/^\/v1\/cards\/([1-9][0-9]*)\/(delivered|failed|answer|resolve)$/.exec(path);
      if(method==="POST" && card) {
        const id=Number(card[1]),channel=door("channel");
        if(card[2]==="resolve") {
          requireDoor("owner");const reason=(await body(req))?.reason;
          if(typeof reason!=="string"||!reason.trim()||reason.length>1000)throw new InputError("写一句处理结果，最多 1000 字");
          return json({changed:act("resolve",id,reason.trim(),"本人")});
        }
        if(card[2]==="answer"&&!channel){requireDoor("owner");const x=await body(req);return json(act("answer",id,{choice:x?.choice,text:x?.text,by:"本人"}));}
        requireDoor("channel");const x=await body(req);
        if(card[2]==="answer")return json(act("answer",id,{choice:x?.choice,text:x?.text,by:x?.by,ref:x?.ref,channel}));
        if(!Number.isInteger(x?.version))throw new InputError("要说明是哪个版本");
        act(card[2],channel,id,x.version,card[2]==="delivered" ? typeof x.ref==="string" ? x.ref : null : String(x.error ?? ""));return json({ok:true});
      }
      if(method==="GET" && path==="/v1/state") {
        requireDoor("owner");const before=url.searchParams.get("before");if(before!==null&&!/^[1-9][0-9]*$/.test(before))throw new InputError("编号不正确");
        return json(s.state(now,before===null ? undefined : Number(before)));
      }
      if(method==="GET" && path==="/v1/stream") {
        requireDoor("owner");const after=url.searchParams.get("after") ?? req.headers.get("last-event-id") ?? "0";
        if(!/^\d+$/.test(after)||!Number.isSafeInteger(Number(after)))throw new InputError("日志序号不正确");
        return new Response(s.stream(Number(after),req.signal,token),{headers:{"content-type":"text/event-stream","cache-control":"no-store","x-accel-buffering":"no"}});
      }
      return json({error:"没有这个地址"},404);
    } catch(error) {
      const status=statusOf(error);if(status===500)throw error;
      const message=error instanceof TooLarge ? "请求最多 1024 KB" : (error as Error).message;
      return cardLink ? new Response(wordsPage(message),{status,headers:PAGE_HEADERS}) : json({error:message},status);
    }
  };
}
