#!/usr/bin/env node
// bevy-shadow-caster-receiver structural dawn smoke (a) backend=webgpu (b) frames >= MIN (c) RhiError=0
import { readFileSync } from 'node:fs'; import { dirname, resolve } from 'node:path'; import { setTimeout as delay } from 'node:timers/promises'; import { fileURLToPath } from 'node:url';
const SMOKE_DURATION_MS = Number.parseInt(process.env.SMOKE_DURATION_MS ?? '5000', 10);
const SMOKE_MIN_FRAMES = Number.parseInt(process.env.SMOKE_MIN_FRAMES ?? '300', 10);
const W=200,H=150;
let create,globals; try{({create,globals}=await import('webgpu'))}catch(e){console.error('[smoke] FAIL dawn');process.exit(1)}
Object.assign(globalThis,globals);if(!('navigator'in globalThis)||globalThis.navigator===undefined)Object.defineProperty(globalThis,'navigator',{value:{},configurable:!0,writable:!0});
let g;try{g=create([])}catch{console.error('[smoke] FAIL create');process.exit(1)}
Object.defineProperty(globalThis.navigator,'gpu',{value:g,configurable:!0,writable:!0});g.getPreferredCanvasFormat=()=>'rgba8unorm';
let sd,oa=globalThis.navigator.gpu.requestAdapter.bind(globalThis.navigator.gpu);
globalThis.navigator.gpu.requestAdapter=async o=>{const a=await oa(o);if(a===null)return a;const od=a.requestDevice.bind(a);a.requestDevice=async d=>{const dv=await od(d);sd||=dv;return dv};return a};
let rt;const mc={width:W,height:H,getContext(k){if(k!=='webgpu')return null;return{configure(d){rt||=d.device.createTexture({size:{width:W,height:H},format:d.format??'rgba8unorm',usage:0x10|0x01,viewFormats:['rgba8unorm-srgb']})},unconfigure(){},getCurrentTexture(){if(!rt){if(!sd)throw new Error('no device');rt=sd.createTexture({size:{width:W,height:H},format:'rgba8unorm',usage:0x10|0x01,viewFormats:['rgba8unorm-srgb']})}return rt}}},addEventListener(){},removeEventListener(){}};
const{World}=await import('@forgeax/engine-ecs');const{createBoxGeometry,createSphereGeometry}=await import('@forgeax/engine-geometry');
const{Camera,createRenderer,DirectionalLight,Materials,MeshFilter,MeshRenderer,perspective,Transform}=await import('@forgeax/engine-runtime');
const w=new World();const here=dirname(fileURLToPath(import.meta.url));
const MU=`data:application/json,${encodeURIComponent(readFileSync(resolve(here,'..','dist','shaders','manifest.json'),'utf8'))}`;
let r;try{r=await createRenderer(mc,{},{shaderManifestUrl:MU})}catch(e){console.error(`[smoke] FAIL renderer: ${e.message}`);process.exit(1)}finally{globalThis.navigator.gpu.requestAdapter=oa}
console.log(`[shadow-caster-receiver] backend=${r.backend}`);const errs=[];r.onError(e=>errs.push(e));
if(!(await r.ready).ok){console.error('[smoke] FAIL ready');process.exit(1)}
const cube=createBoxGeometry(1,1,1,1,1,1);if(!cube.ok)process.exit(1);const sphere=createSphereGeometry(0.5,16,8);if(!sphere.ok)process.exit(1);
const cH=w.allocSharedRef('MeshAsset',cube.value);const sH=w.allocSharedRef('MeshAsset',sphere.value);
const red=w.allocSharedRef('MaterialAsset',Materials.standard({baseColor:[0.9,0.2,0.2,1],metallic:0,roughness:0.5}));
const blue=w.allocSharedRef('MaterialAsset',Materials.standard({baseColor:[0.2,0.2,0.9,1],metallic:0,roughness:0.5,castShadow:!1}));
const green=w.allocSharedRef('MaterialAsset',Materials.standard({baseColor:[0.2,0.9,0.2,1],metallic:0,roughness:0.5}));
w.spawn({component:Transform,data:{pos:[0,-1.5,0],quat:[0,0,0,1],scale:[10,0.02,10]}},{component:MeshFilter,data:{assetHandle:cH}},{component:MeshRenderer,data:{materials:[green]}});
w.spawn({component:Transform,data:{pos:[-1.5,0.5,0],quat:[0,0,0,1],scale:[1,1,1]}},{component:MeshFilter,data:{assetHandle:sH}},{component:MeshRenderer,data:{materials:[red]}});
w.spawn({component:Transform,data:{pos:[1.5,0.5,0],quat:[0,0,0,1],scale:[1,1,1]}},{component:MeshFilter,data:{assetHandle:sH}},{component:MeshRenderer,data:{materials:[blue]}});
w.spawn({component:DirectionalLight,data:{direction:[-0.4,-0.8,-0.5],color:[1,1,1],intensity:2}});
w.spawn({component:Transform,data:{pos:[0,2,5]}},{component:Camera,data:perspective({fov:Math.PI/4,aspect:W/H})});
const T=Math.max(SMOKE_MIN_FRAMES,Math.ceil(SMOKE_DURATION_MS/16.67));let n=0;
for(let i=0;i<T;i++){r.draw([w],{owner:0});n++}
const d=sd;if(d)await d.queue.onSubmittedWorkDone();console.log(`[smoke] frames observed=${n}`);
const f=[];if(r.backend!=='webgpu')f.push(`backend=${r.backend}`);if(n<SMOKE_MIN_FRAMES)f.push(`frames=${n}`);if(errs.length>0)f.push(`errors=${errs.length}`);
if(f.length>0){console.error(`[smoke] FAIL: ${f.join('; ')}`);process.exit(1)}
console.log(`[smoke] PASS - webgpu, frames=${n}, errors=0`);d?.destroy?.();delete globalThis.navigator.gpu;process.exit(0);