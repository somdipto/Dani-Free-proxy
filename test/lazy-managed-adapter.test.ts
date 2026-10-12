import {it,expect} from "bun:test";
import {OpenCodeAdapter} from "../src/adapters/opencode";
import {IdleEngine} from "../src/idle-engine";
import {createRouter} from "../src/router";
import {ModelCatalog} from "../src/catalog";
const model={id:"opencode/fixture-free",backend:"opencode" as const,name:"fixture",capabilities:["text" as const],contextWindow:8192,maxTokens:1024,healthy:true,source:"discovered" as const};
it("managed health, listing, refresh and recovery never start or infer",async()=>{
 let acquire=0;const adapter=new OpenCodeAdapter({resolveBaseUrl:()=>undefined,managed:{discover:async()=>[model],acquire:async()=>{acquire++;return()=>{}}}});
 expect(await adapter.listModels()).toEqual([model]);expect((await adapter.health()).reason).toContain("sleeping");
 const router=createRouter({adapters:[adapter],catalog:new ModelCatalog(),probeOnRefresh:true});await router.refreshCatalog();await router.probeRecovery();expect(acquire).toBe(0);
});
it("lease survives delayed native message and session deletion; idle stops only after cleanup",async()=>{
 let stops=0,starts=0;let messageDone!:()=>void;let deleteDone!:()=>void;
 const message=new Promise<void>(r=>messageDone=r);const deleted=new Promise<void>(r=>deleteDone=r);
 const engine=new IdleEngine(async()=>{starts++},async()=>{stops++},5);
 const adapter=new OpenCodeAdapter({baseUrl:"http://127.0.0.1:1111",managed:{discover:async()=>[model],acquire:s=>engine.acquire(s)},fetch:(async(input:any,init:any)=>{
 const url=String(input);if(url.endsWith("/session"))return Response.json({id:"fixture"});
 if(url.endsWith("/message")){await message;return Response.json({info:{},parts:[{type:"text",text:"fixture answer"}]});}
 if(init?.method==="DELETE"){await deleted;return Response.json({ok:true});}
 return Response.json([]);
 }) as unknown as typeof fetch});
 const completion=adapter.complete({model:model.id,messages:[{role:"user",content:"fixture"}]},model,new AbortController().signal);
 await Bun.sleep(15);expect(starts).toBe(1);expect(stops).toBe(0);messageDone();await Bun.sleep(15);expect(stops).toBe(0);deleteDone();expect((await completion).status).toBe(200);await Bun.sleep(20);expect(stops).toBe(1);await engine.stop();
});
