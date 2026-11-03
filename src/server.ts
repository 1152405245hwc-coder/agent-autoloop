import { watch } from "node:fs";
import { dirname } from "node:path";
import { RULES_FILE } from "./home.ts";
import { loadPlugin } from "./plugins.ts";
import { createHandler } from "../kernel/http.ts";
import { AuthError, NotFound } from "../kernel/errors.ts";
import * as hub from "./runtime.ts";

export function makeHandler(commit="dev") {
  let timer:NodeJS.Timeout|undefined, closed=false;
  const waiting=new Set<{until:number;done:()=>void}>();
  const wake=()=>{for(const w of [...waiting])w.done();};
  const arm=()=>{
    clearTimeout(timer);if(closed)return;
    const dates=Object.values(hub.getView().tables.due).map(d=>d.at as number);
    const at=Math.min(...dates,...[...waiting].map(w=>w.until));
    if(Number.isFinite(at))timer=setTimeout(()=>{hub.tick();wake();arm();},Math.max(0,Math.min(2147483647,at-Date.now())));
  };
  const unlisten=hub.onChange((type,facts)=>{if(type!=="heartbeat" && type!=="channelSeen" || facts.some(f=>f.changes.some(c=>c.table==="cards")))wake();arm();});
  const watcher=watch(dirname(RULES_FILE),(_event,file)=>{if(file===RULES_FILE.split("/").at(-1)){hub.tick();arm();}});
  const handle=createHandler({
    commit,now:Date.now,view:hub.getView,environment:hub.environment,dispatch:hub.execute,state:hub.stateOf,why:hub.why,
    wait(until,signal){return new Promise(resolve=>{
      const w={until,done:()=>{waiting.delete(w);signal.removeEventListener("abort",w.done);resolve();}};
      waiting.add(w);signal.addEventListener("abort",w.done,{once:true});if(signal.aborted)w.done();arm();
    });},
    stream(after,signal,key){
      let off=()=>{},stop=()=>{};
      const detach=()=>{off();signal.removeEventListener("abort",stop);};
      return new ReadableStream({start(controller){
        stop=()=>{detach();controller.close();};
        const send=()=>{if(!hub.whose("owner",key)){stop();return;}for(const f of hub.logAfter(after)){after=f.seq;controller.enqueue(new TextEncoder().encode(`id: ${f.seq}\nevent: fact\ndata: ${JSON.stringify(f)}\n\n`));}};
        off=hub.onChange(send);signal.addEventListener("abort",stop,{once:true});if(signal.aborted)stop();else send();
      },cancel:detach});
    },
    async adapt(source,headers,body){
      const adapter=hub.rules.sources[source]?.adapter;if(!adapter||!/^[a-z][a-z0-9-]*$/.test(adapter))throw new NotFound("这个来源不收 Webhook");
      const translate=await loadPlugin(adapter,"source");
      try {const events=translate({headers:Object.fromEntries(headers),body,secret:process.env[`AGENT_HUB_SECRET_${source.toUpperCase().replaceAll("-","_")}`] ?? ""});return Array.isArray(events) ? events : [];}
      catch{throw new AuthError("验签没过");}
    },
  });
  hub.tick();arm();
  return {handle,close(){closed=true;clearTimeout(timer);watcher.close();unlisten();wake();}};
}
