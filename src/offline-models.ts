import type {BackendModel} from "./types";
/** Public registry metadata only. No engine process, local history or inference. */
export async function discoverOpenCodeModels(signal?:AbortSignal):Promise<BackendModel[]>{
 const response=await fetch("https://models.dev/api.json",{signal:AbortSignal.any([AbortSignal.timeout(10_000),...(signal?[signal]:[])])});
 if(!response.ok)throw new Error("Model registry unavailable");
 const reader=response.body?.getReader();if(!reader)throw new Error("Empty model registry");
 const chunks:Uint8Array[]=[];let size=0;try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>16*1024*1024)throw new Error("Model registry exceeds discovery budget");chunks.push(next.value);}}finally{await reader.cancel();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 const payload=JSON.parse(new TextDecoder().decode(bytes)) as any;
 return modelsFromRegistry(payload);
}
export function modelsFromRegistry(payload:any):BackendModel[]{
 return Object.values(payload?.opencode?.models??{}).flatMap((r:any)=>{
  if(!r||typeof r.id!=="string"||!(r.id.endsWith("-free")||r.id==="big-pickle")||r.cost?.input!==0||r.cost?.output!==0||!r.modalities?.input?.includes("text")||!r.modalities?.output?.includes("text")||!Number.isFinite(r.limit?.context)||!Number.isFinite(r.limit?.output)||!(r.limit?.context>0)||!(r.limit?.output>0))return [];
  // Reject any advertised nonzero charge; absent optional cache charges are not inferred.
  if(Object.values(r.cost).some(v=>typeof v!=="number"||!Number.isFinite(v)||v!==0))return [];
  const capabilities:BackendModel["capabilities"]=["text"];
  if(r.modalities.input.includes("image"))capabilities.push("image");
  if(r.tool_call===true&&process.env.DANI_FREE_OPENCODE_TOOLS==="1")capabilities.push("tools");
  if(r.reasoning===true)capabilities.push("reasoning");
  return [{id:`opencode/${r.id}`,backend:"opencode",name:r.name??r.id,capabilities,contextWindow:r.limit.context,maxTokens:r.limit.output,healthy:true,source:"discovered"}];
 });
}
