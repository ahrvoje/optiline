import "./styles.css";
import "./profile-overrides.css";
import "./ui-overrides.css";

import {
  DEFAULT_VEHICLE,
  KMH_PER_MPS,
  profileColor,
  type CertificateReportJson,
  type CertifierCommand,
  type CertifierEvent,
  type CompiledTrackJson,
  type OptimizerCommand,
  type OptimizerEvent,
  type ProfileNodeJson,
  type SavedProfileJson,
  type TrackSourceJson,
  type V2RepresentationsJson,
  type VehicleSettings,
} from "@/model/contracts";
import { BUILT_IN_TRACKS, compileEditableTrack } from "@/model/catalog";
import {
  createOvalTrackSource,
  duplicateTrackSource,
  forkTrackSource,
  nextCustomTrackName,
} from "@/model/custom-track";
import { trackFingerprint } from "@/model/fingerprint";
import {
  shouldAdoptCertifiedLap,
  upsertPendingCandidate,
} from "@/optimizer/candidate-selection";
import { evaluateProfile, type EvaluatedProfile } from "@/optimizer/profile";
import {
  curvatureRepresentationFromJson,
  reconstructCurvaturePath,
} from "@/optimizer/curvature-closure";
import { nextOptimizerSeed } from "@/optimizer/run-seed";
import {
  CONSTRAINT_COLORS,
  limitingProfileConstraints,
  type ConstraintDomain,
  type ProfileLimitDomain,
} from "@/optimizer/constraint-domain";
import {
  deleteImportedTrack,
  deleteProfile,
  getAllImportedTracks,
  getProfilesForTrack,
  putImportedTrack,
  replaceImportedTrack,
  saveProfileTransaction,
  type ImportedTrackRecord,
} from "@/persistence/db";
import { boundsOfPoints, fitAllCamera, zoomedCamera } from "@/renderer/camera";
import { Canvas2DRenderer } from "@/renderer/canvas2d";
import {
  drawProfileChart,
  PROFILE_CHART_LABELS,
  profileTimeAtCanvasX,
  type ChartProfile,
  type ProfileXAxis,
} from "@/renderer/profile-chart";
import {
  centerlineSpec,
  evaluateLineFrame,
  lineDistancesAtParameters,
  tessellateLine,
  type CurvatureLineSpec,
  type LineSpec,
} from "@/renderer/ph-tessellate";
import { emptyScene } from "@/renderer/scene";

const $=<T extends HTMLElement>(id:string):T=>document.getElementById(id) as T;
const canvas=$("track-canvas") as HTMLCanvasElement,chart=$("profile-canvas") as HTMLCanvasElement;
const renderer=new Canvas2DRenderer(canvas),scene=emptyScene();
let track=BUILT_IN_TRACKS[0]!,fingerprint="",vehicle:VehicleSettings={...DEFAULT_VEHICLE};
let customTracks:ImportedTrackRecord[]=[];
let deterministicRun=false,activeSeedLo=0x12345678,activeSeedHi=0x9abcdef0;
let currentLine:LineSpec=centerlineSpec(track),currentGenotype=new Float64Array(64);
let currentCertificate:CertificateReportJson|null=null;
let currentProfile:EvaluatedProfile=evaluateProfile(currentLine,vehicle),saved:SavedProfileJson[]=[],selected=new Set<string>();
let previewRestore:{line:LineSpec;profile:EvaluatedProfile}|null=null,previewActive=false;
const savedLineCache=new Map<string,CurvatureLineSpec>();
let optimizer:Worker|null=null,runVersion=0,optimizing=false,stoppingRequested=false,totalCandidates=0,runStarted=0,runFinished=0;
let trackSwitching=false,trackSwitchEpoch=0;
let certifier:Worker|null=null,certifierReady:Promise<void>|null=null,resolveCertifier:(()=>void)|null=null,rejectCertifier:((reason:unknown)=>void)|null=null;
let certifying=false,certificationId=0;
  type CertificationJob=
    | {candidateId:number;source:"baseline";queueKey:string;genotype:Float64Array;provisionalLapTime:number}
    | {candidateId:number;source:"curvature";queueKey:string;genotype:Float64Array;provisionalLapTime:number;representations:V2RepresentationsJson};
  let certificationQueue:CertificationJob[]=[],activeCertification:CertificationJob|null=null;
  let optimizerStopped=false,runCertifiedImprovement=false,runCertifiedCandidates=0;
  let currentV2Representations:V2RepresentationsJson|null=null;
let playing=false,zoomed=false,playStart=0,pausedRaceTime=0,playbackRate=1,focusId="current";
let profileXAxis:ProfileXAxis="time",profileCursorTime=0,profileMarkActive=false;
let profileDragging=false;
let toastTimer=0;
let currentLimitDomains:ProfileLimitDomain[]=[],editingFingerprint:string|null=null,editingNodes:[number,number][]=[],editingNode=-1,editBusy=false;
const savedLimitCache=new Map<string,ProfileLimitDomain[]>();

interface SettingSpec { key:keyof VehicleSettings; label:string; unit:string; step:string; min?:number; max?:number; comment:string; equation:string; domain:ConstraintDomain; toDisplay?:(value:number)=>number; fromDisplay?:(value:number)=>number; }
const SETTINGS:SettingSpec[]=[
  {key:"massKg",label:"Vehicle mass",unit:"kg",step:"10",min:100,max:5000,comment:"Mass scales aerodynamic acceleration.",equation:"aᴅ = ρ CᴅA v² / (2m)",domain:"aero"},
  {key:"lengthM",label:"Rectangle length",unit:"m",step:"0.1",min:1,max:30,comment:"Physical swept-surface length.",equation:"Lₑ = Lᵥ",domain:"containment"},
  {key:"widthM",label:"Rectangle width",unit:"m",step:"0.05",min:.5,max:12,comment:"Physical swept-surface width.",equation:"Wₑ = Wᵥ",domain:"containment"},
  {key:"vMaxMps",label:"Maximum speed",unit:"km/h",step:"1",min:KMH_PER_MPS,max:150*KMH_PER_MPS,comment:"Hard speed ceiling before force limits.",equation:"0 ≤ v ≤ vₘₐₓ",domain:"speed",toDisplay:value=>Math.round(value*KMH_PER_MPS*1000)/1000,fromDisplay:value=>value/KMH_PER_MPS},
  {key:"axPlus0",label:"Base acceleration",unit:"m/s²",step:"0.1",min:.1,max:30,comment:"Zero-speed positive traction capability.",equation:"aₓ + aᴅ ≤ aₓ₊₀(1 + γv²)",domain:"acceleration"},
  {key:"axMinus0",label:"Base braking",unit:"m/s²",step:"0.1",min:.1,max:50,comment:"Zero-speed braking capability.",equation:"−aₓ − aᴅ ≤ aₓ₋₀(1 + γv²)",domain:"braking"},
  {key:"ay0",label:"Base lateral grip",unit:"m/s²",step:"0.1",min:.1,max:50,comment:"Lateral capability before aero load.",equation:"|aᵧ| = |v²κ| ≤ aᵧ₀(1 + γv²)",domain:"lateral"},
  {key:"ellipseP",label:"Acceleration ellipse",unit:"p",step:"0.1",min:1,max:8,comment:"Combined longitudinal and lateral envelope.",equation:"|uₓ|ᵖ + |uᵧ|ᵖ ≤ 1",domain:"combined"},
  {key:"dragAreaM2",label:"Drag area CdA",unit:"m²",step:"0.05",min:0,max:10,comment:"Quadratic aerodynamic resistance.",equation:"Fᴅ = ½ρ CᴅA v²",domain:"aero"},
  {key:"downforceAreaM2",label:"Downforce area ClA",unit:"m²",step:"0.1",min:0,max:20,comment:"Aerodynamic load increases tire capacity.",equation:"γ = ρ CₗA / (2mg)",domain:"aero"},
  {key:"airDensity",label:"Air density",unit:"kg/m³",step:"0.005",min:.5,max:1.5,comment:"Shared drag and downforce atmosphere.",equation:"q∞ = ½ρv²",domain:"aero"},
  {key:"kappaMax",label:"Curvature limit",unit:"1/m",step:"0.001",min:.001,max:2,comment:"Optional geometric limit; blank disables it.",equation:"|κ(s)| ≤ κₘₐₓ",domain:"curvature"},
];

function showToast(text:string):void{const el=$("toast");el.textContent=text;el.classList.add("show");clearTimeout(toastTimer);toastTimer=window.setTimeout(()=>el.classList.remove("show"),2400);}
function setStatus(text:string,mode:"idle"|"active"|"busy"="idle"):void{$("engine-status").textContent=text;$("engine-dot").className=`status-dot ${mode}`;}
function settingsLocked():boolean{return trackSwitching||optimizing||stoppingRequested||(optimizerStopped&&certifying);}
function formatDuration(seconds:number):string{if(seconds<60)return`${seconds.toFixed(1)} s`;const minutes=Math.floor(seconds/60),remainder=seconds-60*minutes;if(minutes<60)return`${minutes} min ${remainder.toFixed(1)} s`;const hours=Math.floor(minutes/60);return`${hours} h ${minutes%60} min ${remainder.toFixed(1)} s`;}
function updateRunElapsed():void{const elapsed=$("optimization-time");if(runStarted<=0){elapsed.textContent="—";return;}const end=runFinished>0?runFinished:performance.now();elapsed.textContent=formatDuration(Math.max(0,end-runStarted)/1000);}
function errorText(error:unknown,fallback:string):string{const text=error instanceof Error?error.message:String(error??"");return text.trim()||fallback;}
function nativeWorkerError(event:ErrorEvent,fallback:string):string{const detail=event.error instanceof Error?event.error.message:String(event.error??""),location=event.filename?`${event.filename}:${event.lineno}:${event.colno}`:"";return[event.message,detail,location].map(text=>text.trim()).find(Boolean)??fallback;}
function terminateWorker(worker:Worker):void{worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}
function settingsFingerprint():string{return JSON.stringify(vehicle);}
function messageEnvelope(){return{runVersion,trackFingerprint:fingerprint,settingsFingerprint:settingsFingerprint()};}
function curvatureLineFromSamples(pathSamples:Float64Array,pathLengthM:number):CurvatureLineSpec{return{kind:"curvature",pathLengthM,samples:pathSamples};}
function lineFromSaved(profile:SavedProfileJson):CurvatureLineSpec{const cached=savedLineCache.get(profile.profileId);if(cached)return cached;const representation=curvatureRepresentationFromJson(profile.v2Representations.curvature),path=reconstructCurvaturePath(representation,4096),samples=new Float64Array(5*path.length);for(let i=0;i<path.length;i++){const sample=path[i]!;samples.set([sample.x,sample.y,sample.tx,sample.ty,sample.kappa],5*i);}const line:CurvatureLineSpec={kind:"curvature",pathLengthM:representation.pathLengthM,samples};savedLineCache.set(profile.profileId,line);return line;}

function profileFromPacked(values:Float64Array,edgeCount:number,lapTime:number,line:LineSpec,lineLength?:number):EvaluatedProfile{const nodes:ProfileNodeJson[]=[];for(let i=0;i<edgeCount;i++){const j=7*i;nodes.push({parameter:values[j]!,distance:values[j+1]!,time:values[j+2]!,q:values[j+3]!,acceleration:values[j+4]!,curvature:values[j+5]!,stability:values[j+6]!});}return{lapTime,lineLength:lineLength??evaluateProfile(line,vehicle).lineLength,nodes};}
function certifiedIncumbentLap():number{return currentCertificate?(previewRestore?.profile.lapTime??currentProfile.lapTime):Infinity;}
function restoreCertifiedDisplay():void{if(!previewActive||!previewRestore)return;currentLine=previewRestore.line;currentProfile=previewRestore.profile;previewRestore=null;previewActive=false;scene.provisionalBest=null;profileCursorTime=0;pausedRaceTime=0;profileMarkActive=false;updateProfileDisplay();}
function previewElapsed(elapsedMs:number):string{const seconds=Math.max(0,Math.floor(elapsedMs/1000)),minutes=Math.floor(seconds/60);return`${minutes}:${String(seconds%60).padStart(2,"0")}`;}
function presentIntermediate(event:Extract<OptimizerEvent,{type:"intermediateBest"}>):void{if(!previewActive)previewRestore={line:currentLine,profile:currentProfile};const line=curvatureLineFromSamples(event.pathSamples,event.lineLengthM);currentLine=line;currentProfile={lapTime:event.lapTime,lineLength:event.lineLengthM,nodes:event.profileNodes};previewActive=true;scene.provisionalBest=line;profileCursorTime=Math.min(profileCursorTime,event.lapTime);pausedRaceTime=Math.min(pausedRaceTime,event.lapTime);updateProfileDisplay();setStatus(`Optimizing · ${previewElapsed(event.elapsedMs)} preview ${event.lapTime.toFixed(3)} s provisional`,"busy");}

function allTracks():CompiledTrackJson[]{return[...BUILT_IN_TRACKS,...customTracks.map(record=>record.asset)];}
function isCanonical(item:CompiledTrackJson):boolean{return BUILT_IN_TRACKS.some(candidate=>candidate.source.id===item.source.id);}
function leaveTrackEditor():void{editingFingerprint=null;editingNodes=[];editingNode=-1;scene.editNodes=null;canvas.classList.remove("editing");$("track-editor").hidden=true;}
function renderTrackEditor():void{const panel=$("track-editor");panel.hidden=editingFingerprint===null;if(editingFingerprint===null)return;($("track-editor-name") as HTMLInputElement).value=track.source.name;scene.editNodes=editingNodes;canvas.classList.add("editing");}

function renderTrackList():void{const list=$("track-list");list.replaceChildren();for(const item of allTracks()){const row=document.createElement("div"),button=document.createElement("button"),actions=document.createElement("span"),edit=document.createElement("button");row.className="track-row";button.className=`track-card${item.source.id===track.source.id?" active":""}`;button.role="option";button.ariaSelected=String(item.source.id===track.source.id);button.innerHTML=`<strong>${item.source.name}</strong><small>${item.source.tags.join(" · ")}</small>`;button.onclick=()=>{leaveTrackEditor();void selectTrack(item);};actions.className="track-actions";edit.type="button";edit.className="track-action";edit.title=`Edit ${item.source.name}`;edit.ariaLabel=`Edit ${item.source.name}`;edit.textContent="✎";edit.onclick=event=>{event.stopPropagation();void beginTrackEdit(item);};actions.append(edit);if(!isCanonical(item)){const remove=document.createElement("button");remove.type="button";remove.className="track-action delete";remove.title=`Delete ${item.source.name}`;remove.ariaLabel=`Delete ${item.source.name}`;remove.textContent="×";remove.onclick=event=>{event.stopPropagation();void removeCustomTrack(item);};actions.append(remove);}row.append(button,actions);list.append(row);}
  $("track-count").textContent=String(allTracks().length);syncButtons();}

function renderSettings():void{const grid=$("settings-grid");grid.replaceChildren();for(let index=0;index<SETTINGS.length;index++){const spec=SETTINGS[index]!,wrap=document.createElement("div"),domainChanged=index>0&&SETTINGS[index-1]!.domain!==spec.domain;wrap.className=`setting${domainChanged?" constraint-domain-start":""}`;wrap.dataset.constraintDomain=spec.domain;wrap.style.setProperty("--constraint-color",CONSTRAINT_COLORS[spec.domain]);const stored=vehicle[spec.key],value=stored===null?null:spec.toDisplay?.(stored)??stored;wrap.innerHTML=`<div class="setting-editor"><label for="setting-${spec.key}"><span>${spec.label}</span></label><div class="input-wrap"><input id="setting-${spec.key}" type="number" step="${spec.step}" ${spec.min===undefined?"":`min="${spec.min}"`} ${spec.max===undefined?"":`max="${spec.max}"`} value="${value===null?"":Number(value.toFixed(6))}"><span>${spec.unit}</span></div></div><div class="setting-equation"><span class="formula">${spec.equation}</span></div><p class="setting-description">${spec.comment}</p>`;
    const input=wrap.querySelector("input")!;let wheelTimer=0;
    input.addEventListener("change",()=>{if(settingsLocked()){const storedNow=vehicle[spec.key],displayNow=storedNow===null?null:spec.toDisplay?.(storedNow)??storedNow;input.value=displayNow===null?"":String(Number(displayNow.toFixed(6)));return;}const displayed=input.value===""&&spec.key==="kappaMax"?null:Number(input.value);if(displayed!==null&&!Number.isFinite(displayed)){input.value=String(value??"");return;}if(displayed!==null&&((spec.min!==undefined&&displayed<spec.min)||(spec.max!==undefined&&displayed>spec.max))){input.value=String(value??"");showToast(`${spec.label} is outside its supported range.`);return;}const number=displayed===null?null:spec.fromDisplay?.(displayed)??displayed;if(vehicle[spec.key]===number)return;(vehicle as unknown as Record<string,number|null>)[spec.key]=number;recertifyCenter("Validating updated settings");});
    input.addEventListener("wheel",event=>{event.preventDefault();if(settingsLocked()||event.deltaY===0)return;input.focus({preventScroll:true});const raw=input.value.trim(),step=Number(spec.step),places=Math.min(9,Math.max((raw.split(".")[1]??"").length,(spec.step.split(".")[1]??"").length)),factor=10**places,current=raw===""?spec.min??0:Number(raw),direction=event.deltaY<0?1:-1;let next=Math.round((current+direction*step)*factor)/factor;if(spec.min!==undefined)next=Math.max(spec.min,next);if(spec.max!==undefined)next=Math.min(spec.max,next);input.value=String(next);clearTimeout(wheelTimer);wheelTimer=window.setTimeout(()=>input.dispatchEvent(new Event("change",{bubbles:true})),90);},{passive:false});grid.append(wrap);}
  const mode=document.createElement("div");mode.className="setting constraint-domain-start";mode.dataset.constraintDomain="none";mode.style.setProperty("--constraint-color",CONSTRAINT_COLORS.none);mode.innerHTML='<div class="setting-editor"><label for="setting-run-mode"><span>Run mode</span></label><div class="input-wrap"><select id="setting-run-mode" class="run-mode"><option value="random">Nondeterministic</option><option value="deterministic">Deterministic</option></select></div></div><div class="setting-equation"><span class="formula">xₖ₊₁ = Φ(xₖ, ξₖ)</span></div><p class="setting-description">Every Optimize click starts a new worker and a fresh search state.</p>';const select=mode.querySelector("select")!;select.value=deterministicRun?"deterministic":"random";select.onchange=()=>{if(settingsLocked()){select.value=deterministicRun?"deterministic":"random";return;}deterministicRun=select.value==="deterministic";showToast(`${deterministicRun?"Deterministic":"Nondeterministic"} mode selected for the next run.`);};grid.append(mode);}

function renderProfileLabels():void{const host=$("profile-labels"),axes=document.createElement("div"),series=document.createElement("div");axes.className="chart-axis-labels";series.className="chart-series-labels";for(const label of PROFILE_CHART_LABELS){const axis=document.createElement("span"),legend=document.createElement("span");axis.className="chart-axis-label";legend.className="chart-series-label";axis.style.color=label.color;legend.style.color=label.color;axis.textContent=`${label.shortName} · ${label.unit}`;legend.textContent=label.name;axes.append(axis);series.append(legend);}host.replaceChildren(axes,series);}

async function customRecord(source:TrackSourceJson):Promise<ImportedTrackRecord>{const asset=compileEditableTrack(source),recordFingerprint=await trackFingerprint(asset.source);return{fingerprint:recordFingerprint,asset,importedAt:new Date().toISOString(),savedProfileCount:0};}

async function addCustomSource(source:TrackSourceJson):Promise<ImportedTrackRecord>{const record=await customRecord(source);await putImportedTrack(record);customTracks.push(record);return record;}

async function beginTrackEdit(item:CompiledTrackJson):Promise<void>{if(editBusy||optimizing)return;editBusy=true;try{let record=customTracks.find(candidate=>candidate.asset.source.id===item.source.id);if(isCanonical(item)){record=await addCustomSource(duplicateTrackSource(item,nextCustomTrackName(allTracks())));}else if(record){const profiles=await getProfilesForTrack(record.fingerprint);if(profiles.length>0)record=await addCustomSource(forkTrackSource(record.asset.source,nextCustomTrackName(allTracks())));}if(!record)throw new Error("Custom track record is unavailable");editingFingerprint=record.fingerprint;editingNodes=record.asset.source.centerGatesM.map(([x,y])=>[x,y]);await selectTrack(record.asset);renderTrackEditor();showToast("Drag a guide node, rename the copy, then press Done.");}catch(error){showToast(errorText(error,"Custom track creation failed"));}finally{editBusy=false;syncButtons();}}

async function createOvalTrack():Promise<void>{if(editBusy||optimizing)return;editBusy=true;try{const record=await addCustomSource(createOvalTrackSource(nextCustomTrackName(allTracks())));editingFingerprint=record.fingerprint;editingNodes=record.asset.source.centerGatesM.map(([x,y])=>[x,y]);await selectTrack(record.asset);renderTrackEditor();showToast("Created a 16-node editable stadium oval.");}catch(error){showToast(errorText(error,"Custom oval creation failed"));}finally{editBusy=false;syncButtons();}}

async function persistTrackEdit(name=track.source.name):Promise<void>{if(editBusy||editingFingerprint===null)return;const trimmed=name.trim();if(trimmed.length===0){($("track-editor-name") as HTMLInputElement).value=track.source.name;showToast("Track name cannot be empty.");return;}editBusy=true;const previousFingerprint=editingFingerprint;try{const source:TrackSourceJson={...track.source,name:trimmed,centerGatesM:editingNodes.map(([x,y])=>[x,y]),sourceVersion:track.source.sourceVersion+1},record=await customRecord(source),index=customTracks.findIndex(candidate=>candidate.fingerprint===previousFingerprint);if(index<0)throw new Error("Custom track revision is unavailable");record.importedAt=customTracks[index]!.importedAt;await replaceImportedTrack(previousFingerprint,record);customTracks[index]=record;editingFingerprint=record.fingerprint;editingNodes=record.asset.source.centerGatesM.map(([x,y])=>[x,y]);await selectTrack(record.asset);renderTrackEditor();showToast("Custom track revision saved.");}catch(error){editingNodes=track.source.centerGatesM.map(([x,y])=>[x,y]);renderTrackEditor();showToast(errorText(error,"Custom track update failed"));}finally{editBusy=false;syncButtons();}}

async function removeCustomTrack(item:CompiledTrackJson):Promise<void>{const record=customTracks.find(candidate=>candidate.asset.source.id===item.source.id);if(!record||optimizing)return;const profiles=await getProfilesForTrack(record.fingerprint);const suffix=profiles.length===0?"":" and its saved profiles";if(!window.confirm(`Delete ${item.source.name}${suffix}?`))return;try{await deleteImportedTrack(record.fingerprint);customTracks=customTracks.filter(candidate=>candidate!==record);if(item.source.id===track.source.id){leaveTrackEditor();await selectTrack(BUILT_IN_TRACKS[0]!);}else renderTrackList();showToast("Custom track deleted.");}catch(error){showToast(errorText(error,"Custom track delete failed"));}}

function recertifyCenter(status:string):void{stopOptimizer(true);optimizerStopped=false;runVersion++;resetCertifier();playing=false;pausedRaceTime=0;profileCursorTime=0;profileMarkActive=false;previewRestore=null;previewActive=false;currentLine=centerlineSpec(track);currentGenotype=new Float64Array(64);currentCertificate=null;currentV2Representations=null;scene.certifiedBest=null;scene.provisionalBest=null;scene.invalidFlash=false;scene.candidateLines=null;scene.candidateOffsets=null;for(const id of ["station-rate","candidate-rate","full-rate","certified-rate"])$(id).textContent="—";rebuildProfile();setStatus(status,"busy");queueBaselineCertification(currentGenotype,currentProfile.lapTime);}

function resetSettings():void{if(settingsLocked())return;vehicle={...DEFAULT_VEHICLE};deterministicRun=false;activeSeedLo=0x12345678;activeSeedHi=0x9abcdef0;renderSettings();recertifyCenter("Validating default settings");showToast("Vehicle settings and run mode reset.");}

function ensureCertifier():Promise<void>{
  if(certifierReady)return certifierReady;
  const ownerVersion=runVersion,worker=new Worker(new URL("./workers/certifier-worker.ts",import.meta.url),{type:"module"});
  certifier=worker;
  certifierReady=new Promise<void>((resolve,reject)=>{resolveCertifier=resolve;rejectCertifier=reject;});
  worker.onmessage=(event:MessageEvent<CertifierEvent>)=>{if(certifier!==worker||runVersion!==ownerVersion)return;handleCertifier(event.data);};
  worker.onerror=event=>{if(certifier!==worker||runVersion!==ownerVersion)return;event.preventDefault();const message=nativeWorkerError(event,"certifier worker failed without a diagnostic"),reject=rejectCertifier;certifier=null;certifierReady=null;rejectCertifier=null;resolveCertifier=null;activeCertification=null;certificationQueue=[];certifying=false;terminateWorker(worker);reject?.(new Error(message));setStatus(currentCertificate?`Certifier unavailable · ${message}; retained ${certifiedIncumbentLap().toFixed(3)} s`:`Certifier error · ${message}`,currentCertificate?"active":"idle");syncButtons();};
  worker.onmessageerror=()=>{if(certifier!==worker||runVersion!==ownerVersion)return;const reject=rejectCertifier;certifier=null;certifierReady=null;rejectCertifier=null;resolveCertifier=null;activeCertification=null;certificationQueue=[];certifying=false;terminateWorker(worker);reject?.(new Error("certifier worker message could not be decoded"));setStatus("Certifier error · worker message could not be decoded","idle");syncButtons();};
  worker.postMessage({...messageEnvelope(),type:"init"} satisfies CertifierCommand);
  return certifierReady;
}

function resetCertifier():void{const worker=certifier;certifier=null;certifierReady=null;resolveCertifier=null;rejectCertifier=null;certificationQueue=[];activeCertification=null;certifying=false;certificationId++;if(worker)terminateWorker(worker);}

function enqueueCertification(job:CertificationJob):void{certificationQueue=upsertPendingCandidate(certificationQueue,job);certifying=true;void pumpCertification();syncButtons();}
function queueBaselineCertification(genotype:Float64Array,provisionalLapTime:number):void{enqueueCertification({candidateId:++certificationId,source:"baseline",queueKey:"baseline",genotype:new Float64Array(genotype),provisionalLapTime});}
function queueCurvatureCertification(event:Extract<OptimizerEvent,{type:"provisionalBest"}>):void{if(event.candidateKey!=="curvature-live")certificationQueue=certificationQueue.filter(job=>job.queueKey!=="curvature-live");enqueueCertification({candidateId:++certificationId,source:"curvature",queueKey:event.candidateKey,genotype:new Float64Array(event.genotype),provisionalLapTime:event.lapTime,representations:event.representations});}

async function pumpCertification():Promise<void>{if(activeCertification||certificationQueue.length===0){finishStoppedRun();return;}const job=certificationQueue.shift()!;activeCertification=job;certifying=true;try{await ensureCertifier();if(activeCertification!==job)return;if(job.source==="curvature"){certifier!.postMessage({...messageEnvelope(),type:"certifyCurvature",compiledTrack:track,vehicle:{...vehicle},genotype:job.genotype,representations:job.representations,provisionalLapTime:job.provisionalLapTime,candidateId:job.candidateId} satisfies CertifierCommand);}else{certifier!.postMessage({...messageEnvelope(),type:"certifyCenterline",compiledTrack:track,vehicle:{...vehicle},provisionalLapTime:job.provisionalLapTime,candidateId:job.candidateId} satisfies CertifierCommand);}}catch(error){if(activeCertification!==job)return;activeCertification=null;const message=errorText(error,"certification failed without a diagnostic");setStatus(currentCertificate?`Certification skipped · ${message}; retained ${certifiedIncumbentLap().toFixed(3)} s`:`Certifier error · ${message}`,currentCertificate?"active":"idle");void pumpCertification();}}

function commitBaseline(event:Extract<CertifierEvent,{type:"centerlineCertified"}>):void{const line=centerlineSpec(track);currentLine=line;currentGenotype=new Float64Array(64);currentCertificate=event.certificate;currentV2Representations=null;currentProfile=profileFromPacked(event.profileNodes,event.edgeCount,event.lapTime,line);previewRestore=optimizing?{line:currentLine,profile:currentProfile}:null;previewActive=false;profileCursorTime=0;pausedRaceTime=0;profileMarkActive=false;scene.certifiedBest=null;scene.provisionalBest=null;scene.invalidFlash=false;updateProfileDisplay();}

function commitCurvature(event:Extract<CertifierEvent,{type:"curvatureCertified"}>):void{const priorLap=certifiedIncumbentLap(),line=curvatureLineFromSamples(event.pathSamples,event.lineLengthM);currentLine=line;currentGenotype=new Float64Array(event.genotype);currentCertificate=event.certificate;currentV2Representations=event.representations;currentProfile=profileFromPacked(event.profileNodes,event.edgeCount,event.lapTime,line,event.lineLengthM);previewRestore=null;previewActive=false;profileCursorTime=0;pausedRaceTime=0;profileMarkActive=false;scene.certifiedBest=line;scene.provisionalBest=null;scene.invalidFlash=false;updateProfileDisplay();if(event.lapTime<priorLap-1e-6)runCertifiedImprovement=true;}

function finishStoppedRun():void{certifying=activeCertification!==null||certificationQueue.length>0;syncButtons();if(!optimizerStopped||certifying)return;if(!runCertifiedImprovement)restoreCertifiedDisplay();if(runFinished===0)runFinished=performance.now();if(runCertifiedImprovement)setStatus(`Stopped · certified best ${currentProfile.lapTime.toFixed(3)} s`,"active");else if(currentCertificate)setStatus(`Stopped · no certified improvement; retained ${currentProfile.lapTime.toFixed(3)} s`,"active");else setStatus("Stopped · no feasible candidate","active");updateRunElapsed();syncButtons();}

function handleCertifier(event:CertifierEvent):void{if(event.runVersion!==runVersion||event.trackFingerprint!==fingerprint||event.settingsFingerprint!==settingsFingerprint())return;if(event.type==="ready"){resolveCertifier?.();resolveCertifier=null;rejectCertifier=null;return;}
  if(event.type==="centerlineCertified"){const job=activeCertification;if(!job||job.source!=="baseline"||event.candidateId!==job.candidateId)return;activeCertification=null;if(event.certificate.pass&&shouldAdoptCertifiedLap(event.lapTime,certifiedIncumbentLap())){commitBaseline(event);if(optimizing)setStatus(`GPU running · center baseline ${event.lapTime.toFixed(3)} s`,"busy");else if(!optimizerStopped)setStatus(`Certified center baseline · ${event.lapTime.toFixed(3)} s binary64 profile`,"active");}void pumpCertification();}
  else if(event.type==="curvatureCertified"){const job=activeCertification;if(!job||job.source!=="curvature"||event.candidateId!==job.candidateId)return;activeCertification=null;if(event.certificate.pass){runCertifiedCandidates++;const elapsed=Math.max((performance.now()-runStarted)/1000,.001);$("certified-rate").textContent=(runCertifiedCandidates/elapsed).toFixed(2);}if(event.certificate.pass&&shouldAdoptCertifiedLap(event.lapTime,certifiedIncumbentLap())){commitCurvature(event);setStatus(`${optimizing?"GPU running · ":""}certified intrinsic curvature ${event.lapTime.toFixed(3)} s`,optimizing?"busy":"active");}void pumpCertification();}
  else if(event.type==="certificationFailed"){const job=activeCertification;if(!job||event.candidateId!==job.candidateId)return;activeCertification=null;if(job.source==="baseline"&&!optimizing)setStatus(`Center profile infeasible · ${event.error.message}`,"idle");void pumpCertification();}
  else if(event.type==="error"){activeCertification=null;const message=errorText(event.error.message,"certification failed without a diagnostic");setStatus(currentCertificate?`Certification step skipped · ${message}; retained ${certifiedIncumbentLap().toFixed(3)} s`:`Certifier error · ${message}`,currentCertificate?"active":"idle");void pumpCertification();}}

async function selectTrack(next:CompiledTrackJson):Promise<void>{const epoch=++trackSwitchEpoch;trackSwitching=true;stopOptimizer(true);runVersion++;resetCertifier();runStarted=0;runFinished=0;playing=false;pausedRaceTime=0;profileCursorTime=0;profileMarkActive=false;previewRestore=null;previewActive=false;setStatus("Loading track","busy");syncButtons();try{const nextFingerprint=await trackFingerprint(next.source);if(epoch!==trackSwitchEpoch)return;track=next;fingerprint=nextFingerprint;currentLine=centerlineSpec(track);currentGenotype=new Float64Array(64);currentCertificate=null;currentV2Representations=null;selected.clear();savedLimitCache.clear();rebuildProfile();scene.track=track;scene.certifiedBest=null;scene.provisionalBest=null;scene.invalidFlash=false;scene.candidateLines=null;scene.candidateOffsets=null;$("track-name").textContent=track.source.name;$("track-meta").textContent=`${track.source.description} · ${track.lapLengthM.toFixed(0)} m`;renderTrackList();renderTrackEditor();await refreshSaved();if(epoch!==trackSwitchEpoch)return;fitCamera();setStatus("Certifying center profile","busy");queueBaselineCertification(currentGenotype,currentProfile.lapTime);updateRunElapsed();}catch(error){if(epoch===trackSwitchEpoch)setStatus(`Track change failed · ${errorText(error,"track initialization failed")}`,"idle");}finally{if(epoch===trackSwitchEpoch){trackSwitching=false;syncButtons();}}}

function fitCamera():void{const rect=canvas.getBoundingClientRect(),points=tessellateLine(centerlineSpec(track),1),bounds=boundsOfPoints(points),pad=Math.max(track.source.leftWidthM,track.source.rightWidthM)+4;
  scene.camera=fitAllCamera({minX:bounds.minX-pad,minY:bounds.minY-pad,maxX:bounds.maxX+pad,maxY:bounds.maxY+pad},rect.width,rect.height);}

function limitDomains(nodes:ProfileNodeJson[],settings:VehicleSettings):ProfileLimitDomain[]{return limitingProfileConstraints(nodes,settings);}
function updateProfileDisplay():void{currentLimitDomains=limitDomains(currentProfile.nodes,vehicle);$("lap-time").textContent=`${currentProfile.lapTime.toFixed(3)} s`;$("line-length").textContent=`${currentProfile.lineLength.toFixed(1)} m`;drawChart();}
function rebuildProfile():void{currentProfile=evaluateProfile(currentLine,vehicle);updateProfileDisplay();syncButtons();}

function chartProfile(nodes:ProfileNodeJson[],lapTime:number,lineLength:number,domains:ProfileLimitDomain[],color?:string){const axis=lineDistancesAtParameters(centerlineSpec(track),nodes.map(node=>node.parameter));return{nodes,lapTime,lineLength,axisDistances:axis.distances,axisLength:axis.totalLength,limitDomains:domains,...(color===undefined?{}:{color})};}
function savedDomains(profile:SavedProfileJson):ProfileLimitDomain[]{const cached=savedLimitCache.get(profile.profileId);if(cached)return cached;const domains=limitDomains(profile.profileNodes,profile.vehicleSettings);savedLimitCache.set(profile.profileId,domains);return domains;}
function focusedChartProfile():ChartProfile{if(focusId==="current")return chartProfile(currentProfile.nodes,currentProfile.lapTime,currentProfile.lineLength,currentLimitDomains);const profile=saved.find(candidate=>candidate.profileId===focusId);return profile?chartProfile(profile.profileNodes,profile.lapTimeS,profile.lineLengthM,savedDomains(profile)):chartProfile(currentProfile.nodes,currentProfile.lapTime,currentProfile.lineLength,currentLimitDomains);}
function drawChart():void{let comparisons:ChartProfile[];if(focusId==="current")comparisons=saved.filter(p=>selected.has(p.profileId)).map(p=>chartProfile(p.profileNodes,p.lapTimeS,p.lineLengthM,savedDomains(p),profileColor(p.profileId)));else{comparisons=[chartProfile(currentProfile.nodes,currentProfile.lapTime,currentProfile.lineLength,currentLimitDomains,"#ff8a1f"),...saved.filter(p=>p.profileId!==focusId&&selected.has(p.profileId)).map(p=>chartProfile(p.profileNodes,p.lapTimeS,p.lineLengthM,savedDomains(p),profileColor(p.profileId)))];}chart.dataset.focusTrajectory=focusId;drawProfileChart(chart,focusedChartProfile(),comparisons,{xAxis:profileXAxis,cursorTime:profileMarkActive||playing?profileCursorTime:null});}

async function refreshSaved():Promise<void>{try{saved=await getProfilesForTrack(fingerprint);}catch{saved=[];}savedLineCache.clear();savedLimitCache.clear();const list=$("saved-list");list.replaceChildren();$("saved-count").textContent=String(saved.length);const focus=$("focus-select") as HTMLSelectElement;focus.replaceChildren(new Option("Current line","current"));
  if(saved.length===0){const p=document.createElement("p");p.className="empty";p.textContent="No saved profiles on this track.";list.append(p);}for(const profile of saved){const color=profileColor(profile.profileId),label=document.createElement("label");label.className="saved-item";label.innerHTML=`<input type="checkbox" ${selected.has(profile.profileId)?"checked":""}><span><b>${profile.name}</b><br><small>${profile.lapTimeS.toFixed(3)} s</small></span><i class="saved-swatch" style="background:${color}"></i>`;const input=label.querySelector("input")!;input.onchange=()=>{if(input.checked)selected.add(profile.profileId);else selected.delete(profile.profileId);refreshRaceLines();drawChart();};const remove=document.createElement("button");remove.type="button";remove.className="delete-profile";remove.title=`Delete ${profile.name}`;remove.ariaLabel=`Delete ${profile.name}`;remove.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h10l-1 12H8L7 9Zm3 2v7h2v-7h-2Zm4 0v7h2v-7h-2Z"/></svg>';remove.onclick=event=>{event.preventDefault();event.stopPropagation();void deleteSavedProfile(profile.profileId);};label.append(remove);list.append(label);focus.add(new Option(profile.name,profile.profileId));}
  if(!["current",...saved.map(p=>p.profileId)].includes(focusId))focusId="current";focus.value=focusId;refreshRaceLines();}

function refreshRaceLines():void{scene.savedLines=saved.filter(p=>selected.has(p.profileId)||p.profileId===focusId).map(p=>({color:profileColor(p.profileId),spec:lineFromSaved(p)}));syncFocusOptions();}
function syncFocusOptions():void{const focus=$("focus-select") as HTMLSelectElement;focus.value=focusId;}

async function deleteSavedProfile(profileId:string):Promise<void>{try{await deleteProfile(profileId);selected.delete(profileId);if(focusId===profileId)focusId="current";await refreshSaved();drawChart();showToast("Saved profile deleted.");}catch(error){showToast(error instanceof Error?error.message:"Profile delete failed");}}

function startOptimizer():void{if(optimizing||trackSwitching)return;stopOptimizer(true);restoreCertifiedDisplay();runVersion++;resetCertifier();
  // Every run retains the certified incumbent as one seed. The optimizer also
  // creates an independent center seed and smooth spectral seeds, so preserving
  // the best known line does not collapse exploration to one prior solution.
  const centerGenotype=new Float64Array(64),seedGenotype=currentCertificate?currentGenotype:centerGenotype,centerProfile=evaluateProfile(centerlineSpec(track),vehicle);optimizing=true;stoppingRequested=false;optimizerStopped=false;runCertifiedImprovement=false;runCertifiedCandidates=0;runStarted=performance.now();runFinished=0;totalCandidates=0;previewRestore={line:currentLine,profile:currentProfile};previewActive=false;const candidateRate=$("candidate-rate");delete candidateRate.dataset.totalCandidates;scene.provisionalBest=null;scene.invalidFlash=false;scene.candidateLines=null;scene.candidateOffsets=null;if(!currentCertificate)queueBaselineCertification(centerGenotype,centerProfile.lapTime);
  const ownerVersion=runVersion;let worker:Worker;try{worker=new Worker(new URL("./workers/optimizer-worker.ts",import.meta.url),{type:"module"});}catch(error){runFinished=performance.now();optimizing=false;setStatus(`Optimizer error · ${errorText(error,"optimizer worker could not be created")}`,"idle");syncButtons();return;}optimizer=worker;worker.onmessage=(event:MessageEvent<OptimizerEvent>)=>{if(optimizer!==worker||runVersion!==ownerVersion)return;handleOptimizer(event.data,worker);};worker.onerror=event=>{if(optimizer!==worker||runVersion!==ownerVersion)return;event.preventDefault();const message=nativeWorkerError(event,"optimizer worker failed without a diagnostic");runFinished=performance.now();setStatus(`Optimizer error · ${message}`,"idle");stopOptimizer(true);};worker.onmessageerror=()=>{if(optimizer!==worker||runVersion!==ownerVersion)return;runFinished=performance.now();setStatus("Optimizer error · worker message could not be decoded","idle");stopOptimizer(true);};
  if(deterministicRun){activeSeedLo=0x12345678;activeSeedHi=0x9abcdef0;}else{const seed=nextOptimizerSeed();activeSeedLo=seed.lo;activeSeedHi=seed.hi;}
  const envelope=messageEnvelope();const init:OptimizerCommand={...envelope,type:"init",compiledTrack:track,vehicle:{...vehicle},optimizer:{seedLo:activeSeedLo,seedHi:activeSeedHi,deterministic:deterministicRun,candidateVisibility:8}};worker.postMessage(init);worker.postMessage({...envelope,type:"start",seedGenotype,checkpoint:null} satisfies OptimizerCommand);setStatus(`GPU optimization running · ${deterministicRun?"deterministic":"fresh-seed"} restarts · direct certification`,"busy");updateRunElapsed();syncButtons();}

function handleOptimizer(event:OptimizerEvent,source:Worker):void{if(source!==optimizer||event.runVersion!==runVersion||event.trackFingerprint!==fingerprint||event.settingsFingerprint!==settingsFingerprint())return;if(event.type==="ready"){if(event.adapterInfo!=="initializing"){const seed=`${activeSeedLo.toString(16).padStart(8,"0")}:${activeSeedHi.toString(16).padStart(8,"0")}`;setStatus(`${event.cpuFallback?"CPU fallback":"GPU"} · ${event.adapterInfo} · ${deterministicRun?"deterministic":`seed ${seed}`}`,"busy");}}
  else if(event.type==="progress"){totalCandidates=event.candidates;$("station-rate").textContent=Math.round(event.throughput.stationPerSecond).toLocaleString();const candidateRate=$("candidate-rate");candidateRate.textContent=Math.round(event.throughput.proxyPerSecond).toLocaleString();candidateRate.dataset.totalCandidates=String(event.candidates);$("full-rate").textContent=event.throughput.fullPerSecond.toFixed(1);}
  else if(event.type==="displayCandidates"){scene.candidateLines=event.lines;scene.candidateOffsets=event.lineOffsets;}
  else if(event.type==="intermediateBest"){presentIntermediate(event);}
  else if(event.type==="provisionalBest"){queueCurvatureCertification(event);}
  else if(event.type==="warning"){setStatus(`${event.stage} stage skipped · ${event.message} · retained canonical incumbent`,"busy");}
  else if(event.type==="stopped"){optimizing=false;stoppingRequested=false;optimizerStopped=true;scene.candidateLines=null;scene.candidateOffsets=null;optimizer=null;terminateWorker(source);setStatus(certifying?"Stopped · certifying canonical finalists":"Stopped · finalizing","busy");finishStoppedRun();syncButtons();}
  else if(event.type==="deviceLost"||event.type==="error"){runFinished=performance.now();const message=event.type==="deviceLost"?errorText(event.reason,"GPU device was lost"):errorText(event.error.message,"optimizer failed without a diagnostic");setStatus(event.type==="deviceLost"?`GPU lost · ${message}`:`Optimizer error · ${message}`,"idle");stopOptimizer(true);}}

function stopOptimizer(immediate=false):void{const worker=optimizer;if(!worker){if(immediate){optimizing=false;stoppingRequested=false;restoreCertifiedDisplay();syncButtons();}return;}if(immediate){optimizer=null;terminateWorker(worker);optimizing=false;stoppingRequested=false;optimizerStopped=false;scene.candidateLines=null;scene.candidateOffsets=null;restoreCertifiedDisplay();syncButtons();}else if(!stoppingRequested){stoppingRequested=true;worker.postMessage({runVersion,trackFingerprint:fingerprint,settingsFingerprint:JSON.stringify(vehicle),type:"stop"} satisfies OptimizerCommand);setStatus("Validating final candidates","busy");syncButtons();}}

function syncButtons():void{const action=$("optimize-button") as HTMLButtonElement,locked=settingsLocked();action.textContent=optimizing?"STOP":"OPTIMIZE";action.disabled=stoppingRequested||editBusy||trackSwitching;action.classList.toggle("optimize",!optimizing);action.classList.toggle("stop",optimizing);($("track-list").querySelectorAll("button") as NodeListOf<HTMLButtonElement>).forEach(b=>b.disabled=optimizing||editBusy||trackSwitching);($("new-track-button") as HTMLButtonElement).disabled=optimizing||editBusy||trackSwitching;($("track-editor-name") as HTMLInputElement).disabled=optimizing||editBusy||trackSwitching;($("track-editor-done") as HTMLButtonElement).disabled=optimizing||editBusy||trackSwitching;($("reset-button") as HTMLButtonElement).disabled=locked;($("settings-grid").querySelectorAll("input, select") as NodeListOf<HTMLInputElement|HTMLSelectElement>).forEach(control=>control.disabled=locked);($("play-button") as HTMLButtonElement).disabled=false;($("save-button") as HTMLButtonElement).disabled=!currentCertificate||currentLine.kind!=="curvature"||currentV2Representations===null||optimizing||certifying||trackSwitching;$("play-button").textContent=playing?"Ⅱ PAUSE":"▶ PLAY";$("zoom-button").setAttribute("aria-pressed",String(zoomed));const overlay=$("work-overlay"),validating=stoppingRequested||(!optimizing&&certifying),work=validating?"VALIDATING":optimizing?"OPTIMIZING":certifying?"VALIDATING":"";overlay.hidden=work==="";overlay.classList.toggle("validating",validating);overlay.querySelector("span")!.textContent=work;scene.workLabel=null;}

function togglePlay():void{if(!playing){playing=true;profileMarkActive=true;playStart=performance.now()-pausedRaceTime*1000/playbackRate;if(!optimizing)setStatus("Race playback","active");}else{pausedRaceTime=raceTime();playing=false;if(!optimizing)setStatus("Playback paused","active");}syncButtons();}
function raceTime():number{return playing?(performance.now()-playStart)/1000*playbackRate:pausedRaceTime;}

interface RaceEntry{id:string;label:string;color:string;line:LineSpec;nodes:ProfileNodeJson[];lap:number;vehicle:VehicleSettings;}
function raceEntries():RaceEntry[]{const out:RaceEntry[]=[{id:"current",label:"CURRENT",color:"#ff8a1f",line:currentLine,nodes:currentProfile.nodes,lap:currentProfile.lapTime,vehicle}];
  for(const p of saved)if(selected.has(p.profileId)||p.profileId===focusId){out.push({id:p.profileId,label:p.name,color:profileColor(p.profileId),line:lineFromSaved(p),nodes:p.profileNodes,lap:p.lapTimeS,vehicle:p.vehicleSettings});}return out;}
function parameterAt(nodes:ProfileNodeJson[],time:number,lap:number):number{const local=((time%lap)+lap)%lap;let lo=0,hi=nodes.length-1;while(lo<hi){const mid=(lo+hi+1)>>1;if(nodes[mid]!.time<=local)lo=mid;else hi=mid-1;}const a=nodes[lo]!,b=nodes[(lo+1)%nodes.length]!,bt=lo+1<nodes.length?b.time:lap,span=Math.max(bt-a.time,1e-9),u=(local-a.time)/span;return a.parameter+u*((lo+1<nodes.length?b.parameter:64)-a.parameter);}

function updateRace():void{const entries=raceEntries(),time=raceTime(),focusedEntry=entries.find(entry=>entry.id===focusId)??entries[0]!;if(playing){profileCursorTime=((time%focusedEntry.lap)+focusedEntry.lap)%focusedEntry.lap;drawChart();}scene.vehicles=[];scene.labels=[];let focusedPose:ReturnType<typeof evaluateLineFrame>|null=null,focusedVehicle:VehicleSettings|null=null;
  for(const entry of entries){const parameter=parameterAt(entry.nodes,time,entry.lap),pose=evaluateLineFrame(entry.line,parameter),focused=entry.id===focusId,v=entry.vehicle;scene.vehicles.push({x:pose.x,y:pose.y,tx:pose.tx,ty:pose.ty,lengthM:v.lengthM,widthM:v.widthM,color:entry.color,focused,label:entry.label,envelope:{lengthM:v.lengthM+2*v.safetyMarginM,widthM:v.widthM+2*v.safetyMarginM}});scene.labels.push({x:pose.x,y:pose.y,text:entry.label,color:entry.color});if(focused){focusedPose=pose;focusedVehicle=v;}}
  if(zoomed&&focusedPose&&focusedVehicle){const r=canvas.getBoundingClientRect();scene.camera=zoomedCamera(focusedPose.x,focusedPose.y,focusedPose.tx,focusedPose.ty,focusedVehicle.lengthM,focusedVehicle.widthM,r.width,r.height);}}

async function saveCurrent():Promise<void>{if(!currentCertificate||currentLine.kind!=="curvature"||currentV2Representations===null){showToast("Only a certified canonical-curvature trajectory can be saved.");return;}const now=new Date(),id=crypto.randomUUID();const profile:SavedProfileJson={schemaVersion:2,profileId:id,name:`Run ${saved.length+1} · ${currentProfile.lapTime.toFixed(3)} s`,createdAt:now.toISOString(),trackId:track.source.id,trackFingerprint:fingerprint,vehicleSettings:{...vehicle},dynamicSettings:{seedLo:activeSeedLo,seedHi:activeSeedHi,deterministic:deterministicRun,candidateVisibility:8},optimizerSeed:[activeSeedLo,activeSeedHi],lineLengthM:currentProfile.lineLength,lapTimeS:currentProfile.lapTime,profileNodes:currentProfile.nodes,certificate:{...currentCertificate,hash:fingerprint},v2Representations:currentV2Representations};
  try{await saveProfileTransaction(profile);await refreshSaved();showToast("Racing profile saved in this browser.");}catch(error){showToast(error instanceof Error?error.message:"Profile save failed");}}

function seekProfile(clientX:number):void{const primary=focusedChartProfile(),time=profileTimeAtCanvasX(chart,primary,profileXAxis,clientX);if(time===null)return;playing=false;pausedRaceTime=Math.max(0,Math.min(primary.lapTime??currentProfile.lapTime,time));profileCursorTime=pausedRaceTime;profileMarkActive=true;drawChart();updateRace();syncButtons();}

function editorWorldPoint(clientX:number,clientY:number):[number,number]{const rect=canvas.getBoundingClientRect(),x=(clientX-rect.left-rect.width/2)/scene.camera.scale+scene.camera.centerX,y=-(clientY-rect.top-rect.height/2)/scene.camera.scale+scene.camera.centerY;return[x,y];}
function beginNodeDrag(event:PointerEvent):void{if(editingFingerprint===null||editBusy)return;const point=editorWorldPoint(event.clientX,event.clientY),threshold=12/scene.camera.scale;let nearest=-1,distance=Infinity;for(let i=0;i<editingNodes.length;i++){const node=editingNodes[i]!,candidate=Math.hypot(node[0]-point[0],node[1]-point[1]);if(candidate<distance){nearest=i;distance=candidate;}}if(nearest<0||distance>threshold)return;editingNode=nearest;canvas.setPointerCapture(event.pointerId);event.preventDefault();}
function moveNodeDrag(event:PointerEvent):void{if(editingNode<0)return;editingNodes[editingNode]=editorWorldPoint(event.clientX,event.clientY);scene.editNodes=editingNodes;event.preventDefault();}
function endNodeDrag(event:PointerEvent):void{if(editingNode<0)return;moveNodeDrag(event);editingNode=-1;if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);void persistTrackEdit();}

function bindUi():void{renderSettings();renderProfileLabels();$("optimize-button").onclick=()=>{if(optimizing)stopOptimizer(false);else startOptimizer();};$("reset-button").onclick=resetSettings;$("play-button").onclick=togglePlay;$("save-button").onclick=()=>void saveCurrent();$("zoom-button").onclick=()=>{zoomed=!zoomed;if(!zoomed)fitCamera();syncButtons();};
  $("new-track-button").onclick=()=>void createOvalTrack();$("track-editor-done").onclick=()=>{leaveTrackEditor();renderTrackList();showToast("Track editor closed.");};($("track-editor-name") as HTMLInputElement).addEventListener("change",event=>void persistTrackEdit((event.target as HTMLInputElement).value));
  canvas.addEventListener("pointerdown",beginNodeDrag);canvas.addEventListener("pointermove",moveNodeDrag);canvas.addEventListener("pointerup",endNodeDrag);canvas.addEventListener("pointercancel",event=>{if(editingNode>=0){editingNode=-1;if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);editingNodes=track.source.centerGatesM.map(([x,y])=>[x,y]);scene.editNodes=editingNodes;}});
  chart.addEventListener("pointerdown",event=>{profileDragging=true;chart.setPointerCapture(event.pointerId);seekProfile(event.clientX);event.preventDefault();});
  chart.addEventListener("pointermove",event=>{if(!profileDragging)return;seekProfile(event.clientX);event.preventDefault();});
  chart.addEventListener("pointerup",event=>{if(!profileDragging)return;seekProfile(event.clientX);profileDragging=false;if(chart.hasPointerCapture(event.pointerId))chart.releasePointerCapture(event.pointerId);});
  chart.addEventListener("pointercancel",()=>{profileDragging=false;});
  ($("profile-axis-select") as HTMLSelectElement).onchange=e=>{profileXAxis=(e.target as HTMLSelectElement).value as ProfileXAxis;drawChart();};
  ($("focus-select") as HTMLSelectElement).onchange=e=>{focusId=(e.target as HTMLSelectElement).value;const primary=focusedChartProfile(),lap=primary.lapTime??currentProfile.lapTime;profileCursorTime=((raceTime()%lap)+lap)%lap;refreshRaceLines();drawChart();};($("speed-select") as HTMLSelectElement).onchange=e=>{const old=raceTime();playbackRate=Number((e.target as HTMLSelectElement).value);pausedRaceTime=old;if(playing)playStart=performance.now()-old*1000/playbackRate;};
  window.addEventListener("resize",()=>{if(!zoomed)fitCamera();drawChart();});}

function frame():void{updateRace();updateRunElapsed();renderer.render(scene);requestAnimationFrame(frame);}

async function init():Promise<void>{bindUi();try{customTracks=await getAllImportedTracks();}catch{customTracks=[];}renderTrackList();await selectTrack(track);requestAnimationFrame(frame);}
void init();
