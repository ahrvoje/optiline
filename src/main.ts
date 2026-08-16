import "./styles.css";
import "./profile-overrides.css";
import "./ui-overrides.css";

import {
  DEFAULT_VEHICLE,
  profileColor,
  type CertificateReportJson,
  type CertifierCommand,
  type CertifierEvent,
  type CompiledTrackJson,
  type OptimizerCommand,
  type OptimizerEvent,
  type ProfileNodeJson,
  type SavedProfileJson,
  type VehicleSettings,
} from "@/model/contracts";
import { BUILT_IN_TRACKS } from "@/model/catalog";
import { trackFingerprint } from "@/model/fingerprint";
import { evaluateProfile, type EvaluatedProfile } from "@/optimizer/profile";
import { nextOptimizerSeed } from "@/optimizer/run-seed";
import { deleteProfile, getProfilesForTrack, saveProfileTransaction } from "@/persistence/db";
import { boundsOfPoints, fitAllCamera, zoomedCamera } from "@/renderer/camera";
import { Canvas2DRenderer } from "@/renderer/canvas2d";
import {
  drawProfileChart,
  profileTimeAtCanvasX,
  type ProfileXAxis,
} from "@/renderer/profile-chart";
import {
  centerlineSpec,
  evaluateLineFrame,
  flattenPairs,
  lineDistancesAtParameters,
  racingLineFromPreimage,
  tessellateLine,
  type LineSpec,
} from "@/renderer/ph-tessellate";
import { emptyScene } from "@/renderer/scene";

const $=<T extends HTMLElement>(id:string):T=>document.getElementById(id) as T;
const canvas=$("track-canvas") as HTMLCanvasElement,chart=$("profile-canvas") as HTMLCanvasElement;
const renderer=new Canvas2DRenderer(canvas),scene=emptyScene();
let track=BUILT_IN_TRACKS[0]!,fingerprint="",vehicle:VehicleSettings={...DEFAULT_VEHICLE};
let deterministicRun=false,activeSeedLo=0x12345678,activeSeedHi=0x9abcdef0;
let currentLine:LineSpec=centerlineSpec(track),currentGenotype=new Float64Array(64);
let currentCertificate:CertificateReportJson|null=null;
let currentProfile:EvaluatedProfile=evaluateProfile(currentLine,vehicle),saved:SavedProfileJson[]=[],selected=new Set<string>();
let optimizer:Worker|null=null,runVersion=0,optimizing=false,stoppingRequested=false,totalCandidates=0,runStarted=0;
let certifier:Worker|null=null,certifierReady:Promise<void>|null=null,resolveCertifier:(()=>void)|null=null,rejectCertifier:((reason:unknown)=>void)|null=null;
let certifying=false,certificationId=0;
interface CertificationJob{candidateId:number;kind:"baseline"|"optimizer"|"polish";genotype:Float64Array;warmPreimage?:Float64Array;provisionalLapTime:number;}
let certificationQueue:CertificationJob[]=[],activeCertification:CertificationJob|null=null;
let optimizerStopped=false,runCertifiedImprovement=false,runRawBestLap=Infinity;
let runRawBestGenotype:Float64Array|null=null,runRawBestPreimage:Float64Array|null=null;
let playing=false,zoomed=false,playStart=0,pausedRaceTime=0,playbackRate=1,focusId="current";
let profileXAxis:ProfileXAxis="time",profileCursorTime=0,profileMarkActive=false;
let profileDragging=false;
let toastTimer=0;

interface SettingSpec { key:keyof VehicleSettings; label:string; unit:string; step:string; min?:number; max?:number; comment:string; }
const SETTINGS:SettingSpec[]=[
  {key:"massKg",label:"Vehicle mass",unit:"kg",step:"10",min:100,max:5000,comment:"Mass used for drag and downforce acceleration."},
  {key:"lengthM",label:"Rectangle length",unit:"m",step:"0.1",min:1,max:30,comment:"Physical swept-surface rectangle length."},
  {key:"widthM",label:"Rectangle width",unit:"m",step:"0.05",min:.5,max:12,comment:"Physical swept-surface rectangle width."},
  {key:"safetyMarginM",label:"Safety margin",unit:"m / side",step:"0.01",min:0,max:2,comment:"Added to every side during containment."},
  {key:"vMaxMps",label:"Maximum speed",unit:"m/s",step:"0.5",min:1,max:150,comment:"Hard speed cap before force limits."},
  {key:"axPlus0",label:"Base acceleration",unit:"m/s²",step:"0.1",min:.1,max:30,comment:"Zero-speed traction-axis capability."},
  {key:"axMinus0",label:"Base braking",unit:"m/s²",step:"0.1",min:.1,max:50,comment:"Zero-speed braking-axis capability."},
  {key:"ay0",label:"Base lateral grip",unit:"m/s²",step:"0.1",min:.1,max:50,comment:"Lateral capability before aerodynamic load."},
  {key:"ellipseP",label:"Acceleration ellipse",unit:"p",step:"0.1",min:1,max:8,comment:"Combined longitudinal and lateral force exponent."},
  {key:"dragAreaM2",label:"Drag area CdA",unit:"m²",step:"0.05",min:0,max:10,comment:"Quadratic aerodynamic drag."},
  {key:"downforceAreaM2",label:"Downforce area ClA",unit:"m²",step:"0.1",min:0,max:20,comment:"Makes available tire grip rise with speed."},
  {key:"airDensity",label:"Air density",unit:"kg/m³",step:"0.01",min:.5,max:1.5,comment:"Shared drag and downforce atmosphere value."},
  {key:"kappaMax",label:"Curvature limit",unit:"1/m",step:"0.001",min:.001,max:2,comment:"Optional geometric limit; blank disables it."},
];

function showToast(text:string):void{const el=$("toast");el.textContent=text;el.classList.add("show");clearTimeout(toastTimer);toastTimer=window.setTimeout(()=>el.classList.remove("show"),2400);}
function setStatus(text:string,mode:"idle"|"active"|"busy"="idle"):void{$("engine-status").textContent=text;$("engine-dot").className=`status-dot ${mode}`;}
function errorText(error:unknown,fallback:string):string{const text=error instanceof Error?error.message:String(error??"");return text.trim()||fallback;}
function settingsFingerprint():string{return JSON.stringify(vehicle);}
function messageEnvelope(){return{runVersion,trackFingerprint:fingerprint,settingsFingerprint:settingsFingerprint()};}
function lineFromCertified(preimage:Float64Array,genotype:ArrayLike<number>):LineSpec{return racingLineFromPreimage(track,genotype,preimage);}
function pairArray(a:ArrayLike<number>):[number,number][]{const out:[number,number][]=[];for(let i=0;i<a.length;i+=2)out.push([a[i]!,a[i+1]!]);return out;}

function profileFromPacked(values:Float64Array,edgeCount:number,lapTime:number,line:LineSpec):EvaluatedProfile{const nodes:ProfileNodeJson[]=[];for(let i=0;i<edgeCount;i++){const j=7*i;nodes.push({parameter:values[j]!,distance:values[j+1]!,time:values[j+2]!,q:values[j+3]!,acceleration:values[j+4]!,curvature:values[j+5]!,stability:values[j+6]!});}return{lapTime,lineLength:evaluateProfile(line,vehicle).lineLength,nodes};}

function renderTrackList():void{const list=$("track-list");list.replaceChildren();for(const item of BUILT_IN_TRACKS){const button=document.createElement("button");button.className=`track-card${item===track?" active":""}`;button.role="option";button.ariaSelected=String(item===track);button.innerHTML=`<strong>${item.source.name}</strong><small>${item.source.tags.join(" · ")}</small>`;button.onclick=()=>void selectTrack(item);list.append(button);}
  $("track-count").textContent=String(BUILT_IN_TRACKS.length);}

function renderSettings():void{const grid=$("settings-grid");grid.replaceChildren();for(const spec of SETTINGS){const wrap=document.createElement("div");wrap.className="setting";const value=vehicle[spec.key];wrap.innerHTML=`<label for="setting-${spec.key}"><span>${spec.label}</span></label><div class="input-wrap"><input id="setting-${spec.key}" type="number" step="${spec.step}" ${spec.min===undefined?"":`min="${spec.min}"`} ${spec.max===undefined?"":`max="${spec.max}"`} value="${value??""}"><span>${spec.unit}</span></div><small>${spec.comment}</small>`;
    const input=wrap.querySelector("input")!;let wheelTimer=0;
    input.addEventListener("change",()=>{const number=input.value===""&&spec.key==="kappaMax"?null:Number(input.value);if(number!==null&&!Number.isFinite(number)){input.value=String(vehicle[spec.key]??"");return;}if(number!==null&&((spec.min!==undefined&&number<spec.min)||(spec.max!==undefined&&number>spec.max))){input.value=String(vehicle[spec.key]??"");showToast(`${spec.label} is outside its supported range.`);return;}if(vehicle[spec.key]===number)return;(vehicle as unknown as Record<string,number|null>)[spec.key]=number;recertifyCenter("Validating updated settings");});
    input.addEventListener("wheel",event=>{event.preventDefault();if(event.deltaY===0)return;input.focus({preventScroll:true});if(event.deltaY<0)input.stepUp();else input.stepDown();clearTimeout(wheelTimer);wheelTimer=window.setTimeout(()=>input.dispatchEvent(new Event("change",{bubbles:true})),90);},{passive:false});grid.append(wrap);}
  const mode=document.createElement("div");mode.className="setting";mode.innerHTML='<label for="setting-run-mode"><span>Run mode</span></label><div class="input-wrap"><select id="setting-run-mode" class="run-mode"><option value="random">Nondeterministic</option><option value="deterministic">Deterministic</option></select></div><small>Nondeterministic runs use a fresh seed. Deterministic runs repeat the same restart sequence.</small>';const select=mode.querySelector("select")!;select.value=deterministicRun?"deterministic":"random";select.onchange=()=>{deterministicRun=select.value==="deterministic";showToast(`${deterministicRun?"Deterministic":"Nondeterministic"} mode selected for the next run.`);};grid.append(mode);}

function recertifyCenter(status:string):void{stopOptimizer(true);runVersion++;resetCertifier();playing=false;pausedRaceTime=0;profileCursorTime=0;profileMarkActive=false;currentLine=centerlineSpec(track);currentGenotype=new Float64Array(64);currentCertificate=null;scene.certifiedBest=null;scene.provisionalBest=null;scene.invalidFlash=false;scene.candidateLines=null;scene.candidateOffsets=null;$("candidate-rate").textContent="—";rebuildProfile();setStatus(status,"busy");queueCertification("baseline",currentGenotype,currentProfile.lapTime);}

function resetSettings():void{vehicle={...DEFAULT_VEHICLE};deterministicRun=false;activeSeedLo=0x12345678;activeSeedHi=0x9abcdef0;renderSettings();recertifyCenter("Validating default settings");showToast("Vehicle settings and run mode reset.");}

function ensureCertifier():Promise<void>{if(certifierReady)return certifierReady;certifier=new Worker(new URL("./workers/certifier-worker.ts",import.meta.url),{type:"module"});certifier.onmessage=(event:MessageEvent<CertifierEvent>)=>handleCertifier(event.data);certifierReady=new Promise<void>((resolve,reject)=>{resolveCertifier=resolve;rejectCertifier=reject;});certifier.onerror=event=>{const message=errorText(event.message,"worker failed without a diagnostic");rejectCertifier?.(new Error(message));certifier?.terminate();certifier=null;certifierReady=null;rejectCertifier=null;resolveCertifier=null;activeCertification=null;certificationQueue=[];certifying=false;setStatus(currentCertificate?`Certifier unavailable · ${message}; retained ${currentProfile.lapTime.toFixed(3)} s`:`Certifier error · ${message}`,currentCertificate?"active":"idle");syncButtons();};certifier.postMessage({...messageEnvelope(),type:"init"} satisfies CertifierCommand);return certifierReady;}

function resetCertifier():void{certifier?.terminate();certifier=null;certifierReady=null;resolveCertifier=null;rejectCertifier=null;certificationQueue=[];activeCertification=null;certifying=false;certificationId++;}

function queueCertification(kind:CertificationJob["kind"],genotype:Float64Array,provisionalLapTime:number,warmPreimage?:Float64Array):void{if(kind==="optimizer"||kind==="polish"){const queued=certificationQueue.find(job=>job.kind===kind);if(queued&&queued.provisionalLapTime<=provisionalLapTime)return;certificationQueue=certificationQueue.filter(job=>job.kind!==kind);}const job:CertificationJob={candidateId:++certificationId,kind,genotype:new Float64Array(genotype),provisionalLapTime,...(warmPreimage===undefined?{}:{warmPreimage:new Float64Array(warmPreimage)})};certificationQueue.push(job);certifying=true;void pumpCertification();syncButtons();}

async function pumpCertification():Promise<void>{if(activeCertification||certificationQueue.length===0){finishStoppedRun();return;}const job=certificationQueue.shift()!;activeCertification=job;certifying=true;try{await ensureCertifier();if(activeCertification!==job)return;const command={...messageEnvelope(),type:job.kind==="polish"?"polishCandidate" as const:"certifyCandidate" as const,compiledTrack:track,vehicle:{...vehicle},genotype:job.genotype,...(job.warmPreimage===undefined?{}:{warmPreimage:job.warmPreimage}),provisionalLapTime:job.provisionalLapTime,candidateId:job.candidateId};certifier!.postMessage(command satisfies CertifierCommand);}catch(error){if(activeCertification!==job)return;activeCertification=null;const message=errorText(error,"certification failed without a diagnostic");setStatus(currentCertificate?`Certification skipped · ${message}; retained ${currentProfile.lapTime.toFixed(3)} s`:`Certifier error · ${message}`,currentCertificate?"active":"idle");void pumpCertification();}}

function commitCertified(event:Extract<CertifierEvent,{type:"certified"}>):void{const priorLap=currentCertificate?currentProfile.lapTime:Infinity;currentLine=lineFromCertified(event.preimage,event.genotype);currentGenotype=new Float64Array(event.genotype);currentCertificate=event.certificate;currentProfile=profileFromPacked(event.profileNodes,event.edgeCount,event.lapTime,currentLine);profileCursorTime=0;pausedRaceTime=0;profileMarkActive=false;scene.certifiedBest=currentLine;scene.provisionalBest=null;scene.invalidFlash=false;updateProfileDisplay();if(event.lapTime<priorLap-1e-6)runCertifiedImprovement=true;}

function finishStoppedRun():void{certifying=activeCertification!==null||certificationQueue.length>0;syncButtons();if(!optimizerStopped||certifying)return;if(runCertifiedImprovement)setStatus(`Stopped · certified best ${currentProfile.lapTime.toFixed(3)} s`,"active");else if(currentCertificate)setStatus(`Stopped · no certified improvement; retained ${currentProfile.lapTime.toFixed(3)} s`,"active");else setStatus("Stopped · no feasible candidate","active");syncButtons();}

function handleCertifier(event:CertifierEvent):void{if(event.type==="ready"){resolveCertifier?.();resolveCertifier=null;rejectCertifier=null;return;}if(event.runVersion!==runVersion||event.trackFingerprint!==fingerprint||event.settingsFingerprint!==settingsFingerprint())return;
  if(event.type==="certified"){const job=activeCertification;if(!job||event.candidateId!==job.candidateId)return;activeCertification=null;if(event.certificate.pass&&(!currentCertificate||event.lapTime<currentProfile.lapTime-1e-6)){commitCertified(event);if(job.kind==="optimizer")queueCertification("polish",event.genotype,event.lapTime,event.preimage);if(optimizing)setStatus(`GPU running · certified ${event.lapTime.toFixed(3)} s`,"busy");else if(!optimizerStopped)setStatus(`Certified · ${event.lapTime.toFixed(3)} s binary64 profile`,"active");}void pumpCertification();}
  else if(event.type==="certificationFailed"){const job=activeCertification;if(!job||event.candidateId!==job.candidateId)return;activeCertification=null;if(job.kind==="baseline"&&!optimizing)setStatus(`Center profile infeasible · ${event.error.message}`,"idle");void pumpCertification();}
  else if(event.type==="error"){activeCertification=null;const message=errorText(event.error.message,"certification failed without a diagnostic");setStatus(currentCertificate?`Certification step skipped · ${message}; retained ${currentProfile.lapTime.toFixed(3)} s`:`Certifier error · ${message}`,currentCertificate?"active":"idle");void pumpCertification();}}

async function selectTrack(next:CompiledTrackJson):Promise<void>{stopOptimizer(true);runVersion++;resetCertifier();playing=false;pausedRaceTime=0;profileCursorTime=0;profileMarkActive=false;track=next;fingerprint=await trackFingerprint(track.source);currentLine=centerlineSpec(track);currentGenotype=new Float64Array(64);currentCertificate=null;selected.clear();rebuildProfile();scene.track=track;scene.certifiedBest=null;scene.provisionalBest=null;scene.invalidFlash=false;scene.candidateLines=null;scene.candidateOffsets=null;
  $("track-name").textContent=track.source.name;$("track-meta").textContent=`${track.source.description} · ${track.lapLengthM.toFixed(0)} m`;renderTrackList();await refreshSaved();fitCamera();setStatus("Certifying center profile","busy");queueCertification("baseline",currentGenotype,currentProfile.lapTime);}

function fitCamera():void{const rect=canvas.getBoundingClientRect(),points=tessellateLine(centerlineSpec(track),1),bounds=boundsOfPoints(points),pad=Math.max(track.source.leftWidthM,track.source.rightWidthM)+4;
  scene.camera=fitAllCamera({minX:bounds.minX-pad,minY:bounds.minY-pad,maxX:bounds.maxX+pad,maxY:bounds.maxY+pad},rect.width,rect.height);}

function updateProfileDisplay():void{$("lap-time").textContent=`${currentProfile.lapTime.toFixed(3)} s`;$("line-length").textContent=`${currentProfile.lineLength.toFixed(1)} m`;drawChart();}
function rebuildProfile():void{currentProfile=evaluateProfile(currentLine,vehicle);updateProfileDisplay();syncButtons();}

function chartProfile(nodes:ProfileNodeJson[],lapTime:number,lineLength:number,color?:string){const axis=lineDistancesAtParameters(centerlineSpec(track),nodes.map(node=>node.parameter));return{nodes,lapTime,lineLength,axisDistances:axis.distances,axisLength:axis.totalLength,...(color===undefined?{}:{color})};}
function drawChart():void{const comparisons=saved.filter(p=>selected.has(p.profileId)).map(p=>chartProfile(p.profileNodes,p.lapTimeS,p.lineLengthM,profileColor(p.profileId)));drawProfileChart(chart,chartProfile(currentProfile.nodes,currentProfile.lapTime,currentProfile.lineLength),comparisons,{xAxis:profileXAxis,cursorTime:profileCursorTime});}

async function refreshSaved():Promise<void>{try{saved=await getProfilesForTrack(fingerprint);}catch{saved=[];}const list=$("saved-list");list.replaceChildren();$("saved-count").textContent=String(saved.length);const focus=$("focus-select") as HTMLSelectElement;focus.replaceChildren(new Option("Current line","current"));
  if(saved.length===0){const p=document.createElement("p");p.className="empty";p.textContent="No saved profiles on this track.";list.append(p);}for(const profile of saved){const color=profileColor(profile.profileId),label=document.createElement("label");label.className="saved-item";label.innerHTML=`<input type="checkbox" ${selected.has(profile.profileId)?"checked":""}><span><b>${profile.name}</b><br><small>${profile.lapTimeS.toFixed(3)} s</small></span><i class="saved-swatch" style="background:${color}"></i>`;const input=label.querySelector("input")!;input.onchange=()=>{if(input.checked)selected.add(profile.profileId);else selected.delete(profile.profileId);refreshRaceLines();drawChart();};const remove=document.createElement("button");remove.type="button";remove.className="delete-profile";remove.title=`Delete ${profile.name}`;remove.ariaLabel=`Delete ${profile.name}`;remove.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 12H8L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z"/></svg>';remove.onclick=event=>{event.preventDefault();event.stopPropagation();void deleteSavedProfile(profile.profileId);};label.append(remove);list.append(label);focus.add(new Option(profile.name,profile.profileId));}
  if(!["current",...saved.map(p=>p.profileId)].includes(focusId))focusId="current";focus.value=focusId;refreshRaceLines();}

function refreshRaceLines():void{scene.savedLines=saved.filter(p=>selected.has(p.profileId)).map(p=>{const pre=flattenPairs(p.preimageControls);return{color:profileColor(p.profileId),spec:racingLineFromPreimage(track,p.genotypeD,pre)};});syncFocusOptions();}
function syncFocusOptions():void{const focus=$("focus-select") as HTMLSelectElement;focus.value=focusId;}

async function deleteSavedProfile(profileId:string):Promise<void>{try{await deleteProfile(profileId);selected.delete(profileId);if(focusId===profileId)focusId="current";await refreshSaved();drawChart();showToast("Saved profile deleted.");}catch(error){showToast(error instanceof Error?error.message:"Profile delete failed");}}

function startOptimizer():void{if(optimizing)return;stopOptimizer(true);runVersion++;resetCertifier();playing=false;pausedRaceTime=0;profileCursorTime=0;profileMarkActive=false;
  // Each run searches from the center independently, but the displayed
  // certified profile remains the playback-safe fallback until a faster
  // binary64-certified result replaces it.
  const centerGenotype=new Float64Array(64),centerProfile=evaluateProfile(centerlineSpec(track),vehicle);optimizing=true;stoppingRequested=false;optimizerStopped=false;runCertifiedImprovement=false;runRawBestLap=Infinity;runRawBestGenotype=null;runRawBestPreimage=null;runStarted=performance.now();totalCandidates=0;scene.provisionalBest=null;scene.invalidFlash=false;scene.candidateLines=null;scene.candidateOffsets=null;queueCertification("baseline",centerGenotype,centerProfile.lapTime);queueCertification("polish",centerGenotype,centerProfile.lapTime);
  optimizer=new Worker(new URL("./workers/optimizer-worker.ts",import.meta.url),{type:"module"});optimizer.onmessage=(event:MessageEvent<OptimizerEvent>)=>handleOptimizer(event.data);optimizer.onerror=e=>{setStatus(`Optimizer error · ${e.message}`,"idle");stopOptimizer(true);};
  if(deterministicRun){activeSeedLo=0x12345678;activeSeedHi=0x9abcdef0;}else{const seed=nextOptimizerSeed();activeSeedLo=seed.lo;activeSeedHi=seed.hi;}
  const envelope=messageEnvelope();const init:OptimizerCommand={...envelope,type:"init",compiledTrack:track,vehicle:{...vehicle},optimizer:{seedLo:activeSeedLo,seedHi:activeSeedHi,deterministic:deterministicRun,candidateVisibility:8}};optimizer.postMessage(init);optimizer.postMessage({...envelope,type:"start",seedGenotype:null,checkpoint:null} satisfies OptimizerCommand);setStatus(`GPU optimization running · ${deterministicRun?"deterministic":"fresh-seed"} restarts · certifying center`,"busy");syncButtons();}

function handleOptimizer(event:OptimizerEvent):void{if(event.runVersion!==runVersion)return;if(event.type==="ready"){if(event.adapterInfo!=="initializing"){const seed=`${activeSeedLo.toString(16).padStart(8,"0")}:${activeSeedHi.toString(16).padStart(8,"0")}`;setStatus(`${event.cpuFallback?"CPU fallback":"GPU"} · ${event.adapterInfo} · ${deterministicRun?"deterministic":`seed ${seed}`}`,"busy");}}
  else if(event.type==="progress"){totalCandidates=event.candidates;const elapsed=Math.max((performance.now()-runStarted)/1000,.001);$("candidate-rate").textContent=`${Math.round(totalCandidates/elapsed).toLocaleString()}`;}
  else if(event.type==="displayCandidates"){scene.candidateLines=event.lines;scene.candidateOffsets=event.lineOffsets;}
  else if(event.type==="provisionalBest"){if(event.lapTime<runRawBestLap){runRawBestLap=event.lapTime;runRawBestGenotype=new Float64Array(event.genotype);runRawBestPreimage=new Float64Array(event.preimage);}queueCertification("optimizer",event.genotype,event.lapTime,event.preimage);}
  else if(event.type==="stopped"){optimizing=false;stoppingRequested=false;optimizerStopped=true;scene.candidateLines=null;scene.candidateOffsets=null;optimizer?.terminate();optimizer=null;if(runRawBestGenotype)queueCertification("polish",runRawBestGenotype,runRawBestLap,runRawBestPreimage??undefined);setStatus(certifying?"Stopped · validating and polishing best GPU basin":"Stopped · finalizing","busy");finishStoppedRun();syncButtons();}
  else if(event.type==="deviceLost"||event.type==="error"){setStatus(event.type==="deviceLost"?`GPU lost · ${event.reason}`:event.error.message,"idle");stopOptimizer(true);}}

function stopOptimizer(immediate=false):void{if(!optimizer){if(immediate){optimizing=false;stoppingRequested=false;syncButtons();}return;}if(immediate){optimizer.terminate();optimizer=null;optimizing=false;stoppingRequested=false;optimizerStopped=false;scene.candidateLines=null;scene.candidateOffsets=null;syncButtons();}else if(!stoppingRequested){stoppingRequested=true;optimizer.postMessage({runVersion,trackFingerprint:fingerprint,settingsFingerprint:JSON.stringify(vehicle),type:"stop"} satisfies OptimizerCommand);setStatus("Stopping after current fixed-work batch","busy");syncButtons();}}

function syncButtons():void{const action=$("optimize-button") as HTMLButtonElement;action.textContent=optimizing?"STOP":"OPTIMIZE";action.disabled=stoppingRequested;action.classList.toggle("optimize",!optimizing);action.classList.toggle("stop",optimizing);($("track-list").querySelectorAll("button") as NodeListOf<HTMLButtonElement>).forEach(b=>b.disabled=optimizing);($("play-button") as HTMLButtonElement).disabled=!currentCertificate||optimizing;($("save-button") as HTMLButtonElement).disabled=!currentCertificate||optimizing||certifying;$("play-button").textContent=playing?"Ⅱ PAUSE":"▶ PLAY";$("zoom-button").setAttribute("aria-pressed",String(zoomed));const overlay=$("work-overlay");const work=optimizing?"OPTIMIZING":certifying?"VALIDATING":"";overlay.hidden=work==="";overlay.classList.toggle("validating",!optimizing&&certifying);overlay.querySelector("span")!.textContent=work;}

function togglePlay():void{if(optimizing||!currentCertificate)return;if(!playing){playing=true;playStart=performance.now()-pausedRaceTime*1000/playbackRate;setStatus("Race playback","active");}else{pausedRaceTime=raceTime();playing=false;setStatus("Playback paused","active");}syncButtons();}
function raceTime():number{return playing?(performance.now()-playStart)/1000*playbackRate:pausedRaceTime;}

interface RaceEntry{id:string;label:string;color:string;line:LineSpec;nodes:ProfileNodeJson[];lap:number;vehicle:VehicleSettings;}
function raceEntries():RaceEntry[]{const out:RaceEntry[]=[{id:"current",label:"CURRENT",color:"#ff8a1f",line:currentLine,nodes:currentProfile.nodes,lap:currentProfile.lapTime,vehicle}];
  for(const p of saved)if(selected.has(p.profileId)){const pre=flattenPairs(p.preimageControls);out.push({id:p.profileId,label:p.name,color:profileColor(p.profileId),line:racingLineFromPreimage(track,p.genotypeD,pre),nodes:p.profileNodes,lap:p.lapTimeS,vehicle:p.vehicleSettings});}return out;}
function parameterAt(nodes:ProfileNodeJson[],time:number,lap:number):number{const local=((time%lap)+lap)%lap;let lo=0,hi=nodes.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(nodes[mid]!.time<=local)lo=mid;else hi=mid-1;}const a=nodes[lo]!,b=nodes[(lo+1)%nodes.length]!,bt=lo+1<nodes.length?b.time:lap,span=Math.max(bt-a.time,1e-9),u=(local-a.time)/span;return a.parameter+u*((lo+1<nodes.length?b.parameter:64)-a.parameter);}

function updateRace():void{const entries=raceEntries(),time=raceTime();if(playing){profileCursorTime=((time%currentProfile.lapTime)+currentProfile.lapTime)%currentProfile.lapTime;drawChart();}scene.vehicles=[];scene.labels=[];let focusedPose:ReturnType<typeof evaluateLineFrame>|null=null,focusedVehicle:VehicleSettings|null=null;
  for(const entry of entries){const parameter=parameterAt(entry.nodes,time,entry.lap),pose=evaluateLineFrame(entry.line,parameter),focused=entry.id===focusId,v=entry.vehicle;scene.vehicles.push({x:pose.x,y:pose.y,tx:pose.tx,ty:pose.ty,lengthM:v.lengthM,widthM:v.widthM,color:entry.color,focused,label:entry.label,envelope:{lengthM:v.lengthM+2*v.safetyMarginM,widthM:v.widthM+2*v.safetyMarginM}});scene.labels.push({x:pose.x,y:pose.y,text:entry.label,color:entry.color});if(focused){focusedPose=pose;focusedVehicle=v;}}
  if(zoomed&&focusedPose&&focusedVehicle){const r=canvas.getBoundingClientRect();scene.camera=zoomedCamera(focusedPose.x,focusedPose.y,focusedPose.tx,focusedPose.ty,focusedVehicle.lengthM,focusedVehicle.widthM,r.width,r.height);}}

async function saveCurrent():Promise<void>{if(!currentCertificate){showToast("Wait for binary64 certification before saving.");return;}const now=new Date(),id=crypto.randomUUID();const profile:SavedProfileJson={schemaVersion:1,profileId:id,name:`Run ${saved.length+1} · ${currentProfile.lapTime.toFixed(3)} s`,createdAt:now.toISOString(),trackId:track.source.id,trackFingerprint:fingerprint,vehicleSettings:{...vehicle},dynamicSettings:{seedLo:activeSeedLo,seedHi:activeSeedHi,deterministic:deterministicRun,candidateVisibility:8},optimizerSeed:[activeSeedLo,activeSeedHi],genotypeD:Array.from(currentGenotype),preimageControls:pairArray(currentLine.preimage),lineLengthM:currentProfile.lineLength,lapTimeS:currentProfile.lapTime,profileNodes:currentProfile.nodes,certificate:{...currentCertificate,hash:fingerprint}};
  try{await saveProfileTransaction(profile);await refreshSaved();showToast("Racing profile saved in this browser.");}catch(error){showToast(error instanceof Error?error.message:"Profile save failed");}}

function seekProfile(clientX:number):void{const time=profileTimeAtCanvasX(chart,chartProfile(currentProfile.nodes,currentProfile.lapTime,currentProfile.lineLength),profileXAxis,clientX);if(time===null)return;playing=false;pausedRaceTime=Math.max(0,Math.min(currentProfile.lapTime,time));profileCursorTime=pausedRaceTime;profileMarkActive=true;drawChart();updateRace();setStatus(`Profile mark · ${pausedRaceTime.toFixed(3)} s`,"active");syncButtons();}

function bindUi():void{renderSettings();$("optimize-button").onclick=()=>{if(optimizing)stopOptimizer(false);else startOptimizer();};$("reset-button").onclick=resetSettings;$("play-button").onclick=togglePlay;$("save-button").onclick=()=>void saveCurrent();$("zoom-button").onclick=()=>{zoomed=!zoomed;if(!zoomed)fitCamera();syncButtons();};
  chart.addEventListener("pointerdown",event=>{profileDragging=true;chart.setPointerCapture(event.pointerId);seekProfile(event.clientX);event.preventDefault();});
  chart.addEventListener("pointermove",event=>{if(!profileDragging)return;seekProfile(event.clientX);event.preventDefault();});
  chart.addEventListener("pointerup",event=>{if(!profileDragging)return;seekProfile(event.clientX);profileDragging=false;if(chart.hasPointerCapture(event.pointerId))chart.releasePointerCapture(event.pointerId);});
  chart.addEventListener("pointercancel",()=>{profileDragging=false;});
  ($("profile-axis-select") as HTMLSelectElement).onchange=e=>{profileXAxis=(e.target as HTMLSelectElement).value as ProfileXAxis;drawChart();};
  ($("focus-select") as HTMLSelectElement).onchange=e=>{focusId=(e.target as HTMLSelectElement).value;};($("speed-select") as HTMLSelectElement).onchange=e=>{const old=raceTime();playbackRate=Number((e.target as HTMLSelectElement).value);pausedRaceTime=old;if(playing)playStart=performance.now()-old*1000/playbackRate;};
  window.addEventListener("resize",()=>{if(!zoomed)fitCamera();drawChart();});}

function frame():void{updateRace();renderer.render(scene);requestAnimationFrame(frame);}

async function init():Promise<void>{bindUi();renderTrackList();await selectTrack(track);requestAnimationFrame(frame);}
void init();
