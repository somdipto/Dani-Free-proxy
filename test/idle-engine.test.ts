import {describe,it,expect} from "bun:test";
import {IdleEngine} from "../src/idle-engine";
const wait=(n:number)=>new Promise(r=>setTimeout(r,n));
describe("lazy engine lifecycle",()=>{
 it("does not start at construction; active leases prevent idle stop; next use restarts",async()=>{
  let running=false,starts=0,stops=0;const e=new IdleEngine(async()=>{if(!running){starts++;running=true}},async()=>{stops++;running=false},10);
  expect(starts).toBe(0);const a=await e.acquire();const b=await e.acquire();await wait(20);expect(stops).toBe(0);a();a();await wait(20);expect(stops).toBe(0);b();await wait(25);expect(stops).toBe(1);const c=await e.acquire();expect(starts).toBe(2);c();await e.stop();
 });
 it("coalesces concurrent starts and cancellation cannot strand leases",async()=>{
  let starts=0;let ready!:()=>void;const gate=new Promise<void>(r=>ready=r);const e=new IdleEngine(async()=>{starts++;await gate},async()=>{},10);const abort=new AbortController();const a=e.acquire(abort.signal).catch(()=>null);const b=e.acquire();await wait(1);abort.abort();ready();expect(await a).toBe(null);const release=await b;expect(starts).toBe(1);release();await e.stop();
 });
 it("shutdown during startup forbids late acquire and future restarts",async()=>{
  let ready!:()=>void;const gate=new Promise<void>(r=>ready=r);const e=new IdleEngine(()=>gate,async()=>{},10);const a=e.acquire().catch(()=>null);const stop=e.stop();ready();await stop;expect(await a).toBe(null);await expect(e.acquire()).rejects.toThrow("shut down");
 });
 it("start failures can retry rather than poison first-use",async()=>{let count=0;const e=new IdleEngine(async()=>{if(++count===1)throw new Error("failed")},async()=>{},10);await expect(e.acquire()).rejects.toThrow("failed");const r=await e.acquire();r();await e.stop();expect(count).toBe(2)});
});
it("unconfirmed teardown blocks duplicate engines",async()=>{const e=new IdleEngine(async()=>{},async()=>{throw new Error("unconfirmed")},2);const r=await e.acquire();r();await wait(15);await expect(e.acquire()).rejects.toThrow("teardown unconfirmed");await e.stop().catch(()=>{});});
