import {it,expect} from "bun:test";
import {modelsFromRegistry} from "../src/offline-models";
it("registry admission requires explicit finite zero tariff, valid limits and text IO",()=>{
 const good={id:"fixture-free",cost:{input:0,output:0},limit:{context:1024,output:512},modalities:{input:["text"],output:["text"]}};
 const models={good,paid:{...good,id:"paid-free",cost:{input:0,output:.1}},unknown:{...good,id:"unknown-free",cost:{input:0}},cache:{...good,id:"cache-free",cost:{input:0,output:0,cache_read:.1}},nan:{...good,id:"nan-free",limit:{context:Infinity,output:1}},notFree:{...good,id:"fixture-paid"},nonText:{...good,id:"image-free",modalities:{input:["image"],output:["image"]}}};
 expect(modelsFromRegistry({opencode:{models}}).map(m=>m.id)).toEqual(["opencode/fixture-free"]);expect(modelsFromRegistry(null)).toEqual([]);
});
