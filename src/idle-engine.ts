/** Owns one lazily started engine. Discovery never acquires a lease. */
export class IdleEngine {
 private starting?:Promise<void>;
 private stopping?:Promise<void>;
 private leases=0;
 private timer?:ReturnType<typeof setTimeout>;
 private disposed=false;
 private stopFailure?:unknown;
 constructor(private startEngine:()=>Promise<unknown>,private stopEngine:()=>Promise<void>,private idleMs=60_000){}
 async acquire(signal?:AbortSignal):Promise<()=>void>{
  if(this.disposed)throw new Error("Engine is shut down");
  if(this.stopFailure)throw new Error("Engine teardown unconfirmed; restart blocked");
  clearTimeout(this.timer);this.leases++;
  try{
   if(this.stopping)await this.stopping;
   if(this.stopFailure)throw new Error("Engine teardown unconfirmed; restart blocked");
   if(this.disposed||signal?.aborted)throw new Error("Engine request cancelled");
   this.starting??=this.startEngine().then(()=>undefined).catch(error=>{this.starting=undefined;throw error;});
   // Shared start belongs to the engine, not an individual caller's abort.
   const start=this.starting;await start;
   if(this.starting===start)this.starting=undefined;
   if(this.disposed||signal?.aborted)throw new Error("Engine request cancelled");
  }catch(error){this.release();throw error;}
  let released=false;return()=>{if(!released){released=true;this.release();}};
 }
 private release(){this.leases--;if(this.leases===0&&!this.disposed)this.timer=setTimeout(()=>void this.idleStop(),this.idleMs);}
 private async idleStop(){if(this.leases||this.disposed)return;this.starting=undefined;this.stopping=this.stopEngine();try{await this.stopping;}catch(error){this.stopFailure=error;}finally{this.stopping=undefined;}}
 async stop(){this.disposed=true;clearTimeout(this.timer);await this.starting?.catch(()=>undefined);await this.stopping;await this.stopEngine();}
}
