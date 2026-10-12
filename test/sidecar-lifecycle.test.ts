import {it,expect} from "bun:test";
import {mkdtempSync,writeFileSync,chmodSync,rmSync,readFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OpenCodeSidecar} from "../src/opencode-sidecar";
import {IdleEngine} from "../src/idle-engine";
it.skipIf(process.platform === "win32")("real fixture child starts lazily, stays alive with a lease, exits idle and restarts",async()=>{
 const home=mkdtempSync(join(tmpdir(),"dani-child-")),bin=join(home,"fixture"),marker=join(home,"pid");
 writeFileSync(bin,`#!/usr/bin/env python3\nimport os,time,signal\nopen(${JSON.stringify(marker)},'w').write(str(os.getpid()))\nprint('listening on http://127.0.0.1:7777',flush=True)\nsignal.signal(signal.SIGTERM,lambda *a:exit(0))\nwhile True: time.sleep(.1)\n`);chmodSync(bin,0o755);
 const sidecar=new OpenCodeSidecar({home,binary:bin,noInstall:true});const engine=new IdleEngine(()=>sidecar.start(),()=>sidecar.sleep(),15);
 try{expect(existsSync(marker)).toBe(false);const a=await engine.acquire();const first=Number(readFileSync(marker,'utf8'));await Bun.sleep(30);expect(sidecar.baseUrl).toBeDefined();process.kill(first,0);a();await Bun.sleep(60);expect(sidecar.baseUrl).toBeUndefined();expect(()=>process.kill(first,0)).toThrow();const b=await engine.acquire();expect(Number(readFileSync(marker,'utf8'))).not.toBe(first);b();await engine.stop();}finally{sidecar.stop();rmSync(home,{recursive:true,force:true})}
});
