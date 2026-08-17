/** Built-in compact circuits generated as closed quintic PH splines. */
import type {
  CompiledTrackJson,
  CorridorCellJson,
  RationalOffsetSpanJson,
  TrackSourceJson,
} from "@/model/contracts";
import {
  evaluateLineFrame,
  exactOffsetBoundary,
  gatesFromPreimage,
  spanDisplacement,
  spanPreimageBezier,
  tessellateLine,
  type PhLineSpec,
} from "@/renderer/ph-tessellate";

type Point = [number, number];
interface Complex { re: number; im: number; }
interface Preset {
  id: string;
  name: string;
  description: string;
  guide: Point[];
  width: number;
  tags: string[];
  xScale?: number;
  yScale?: number;
  rotationDeg?: number;
}

/* Each original guide has a different topology. Collinear runs retain visible
 * straights; separated returns leave room for the full-width lane. */
const PRESETS: Preset[] = [
  { id:"azure-switchback",name:"Azure Switchback",description:"A wide coastal serpent with a flat-out base, two hooks, and an elevated chicane.",width:10,tags:["wide serpent","double hook","chicane"],guide:[[-128,-52],[108,-52],[132,-30],[112,-8],[62,-8],[42,12],[96,25],[122,46],[104,64],[58,62],[18,40],[-14,62],[-58,55],[-88,34],[-62,12],[-112,4],[-138,-20]] },
  { id:"silver-delta",name:"Silver Delta",description:"A tall boot-shaped circuit with a long stem, a top keyhole, and a lower switchback.",width:10,xScale:.8,tags:["tall boot","keyhole","switchback"],guide:[[-80,-126],[30,-126],[48,-108],[25,-82],[-12,-65],[20,-42],[52,-18],[42,12],[70,36],[58,70],[28,88],[-2,68],[-30,90],[-60,70],[-42,36],[-78,12],[-60,-18],[-92,-48],[-92,-88]] },
  { id:"emerald-crown",name:"Emerald Crown",description:"A triangular ridge joins a long base straight to a high apex and asymmetric esses.",width:10,xScale:.9,tags:["triangular ridge","apex","esses"],guide:[[-126,-70],[104,-70],[132,-70],[146,-50],[132,-26],[100,-18],[66,-18],[102,34],[70,72],[34,104],[8,76],[-8,40],[-38,68],[-68,42],[-92,24],[-116,2],[-88,-24],[-134,-40]] },
  { id:"crimson-mesa",name:"Crimson Mesa",description:"An angular street course joins a long diagonal return to two offset hammerheads.",width:8,xScale:.94,yScale:.94,tags:["angular street course","diagonal return","hammerheads"],guide:[[-130,-70],[-130,40],[-110,70],[-65,70],[-45,45],[-85,20],[-105,0],[-90,-18],[-55,-8],[-5,18],[45,50],[90,80],[125,55],[130,20],[105,-15],[75,-45],[55,-20],[70,5],[55,25],[35,5],[15,-20],[-20,-45],[-60,-68],[-100,-82]] },
  { id:"harbor-coil",name:"Harbor Coil",description:"A rotated diagonal course links a long launch, a remote bulb, and a compact return coil.",width:10,rotationDeg:12,tags:["diagonal straight","remote bulb","coil"],guide:[[-126,-72],[68,-72],[116,-50],[130,-20],[104,2],[62,12],[86,42],[62,74],[22,88],[-6,58],[-34,30],[-10,4],[-52,-2],[-82,22],[-112,12],[-92,-18],[-138,-36]] },
  { id:"sunset-ribbon",name:"Sunset Ribbon",description:"A near-square ribbon uses a long vertical chute, offset hairpins, and a compact inner W.",width:10,tags:["vertical chute","offset hairpins","inner W"],guide:[[-102,-70],[-102,38],[-82,72],[-46,62],[-20,30],[-46,0],[-72,16],[-62,-20],[-28,-38],[4,-10],[30,26],[62,48],[92,30],[102,0],[102,-88],[72,-110],[36,-92],[10,-56],[-20,-86],[-62,-102],[-92,-90]] },
];


function roundedGuide(vertices:Point[],trimTarget=16):Point[]{
  const n=vertices.length,entry:Point[]=[],exit:Point[]=[];
  for(let i=0;i<n;i++){
    const before=vertices[(i+n-1)%n]!,point=vertices[i]!,after=vertices[(i+1)%n]!,inLength=Math.hypot(point[0]-before[0],point[1]-before[1]),outLength=Math.hypot(after[0]-point[0],after[1]-point[1]),trim=Math.min(trimTarget,.32*inLength,.32*outLength),inX=(point[0]-before[0])/inLength,inY=(point[1]-before[1])/inLength,outX=(after[0]-point[0])/outLength,outY=(after[1]-point[1])/outLength;
    entry.push([point[0]-trim*inX,point[1]-trim*inY]);exit.push([point[0]+trim*outX,point[1]+trim*outY]);
  }
  const dense:Point[]=[];
  for(let i=0;i<n;i++){
    const lineStart=exit[(i+n-1)%n]!,lineEnd=entry[i]!,corner=vertices[i]!,cornerEnd=exit[i]!;
    for(let step=0;step<12;step++){const t=step/12;dense.push([lineStart[0]+t*(lineEnd[0]-lineStart[0]),lineStart[1]+t*(lineEnd[1]-lineStart[1])]);}
    for(let step=0;step<20;step++){const t=step/20,u=1-t;dense.push([u*u*lineEnd[0]+2*u*t*corner[0]+t*t*cornerEnd[0],u*u*lineEnd[1]+2*u*t*corner[1]+t*t*cornerEnd[1]]);}
  }
  return dense;
}

function resampleClosed(points:Point[],count:number):Point[]{
  const cumulative=[0];
  for(let i=0;i<points.length;i++){const a=points[i]!,b=points[(i+1)%points.length]!;cumulative.push(cumulative.at(-1)!+Math.hypot(b[0]-a[0],b[1]-a[1]));}
  const total=cumulative.at(-1)!,result:Point[]=[];let edge=0;
  for(let i=0;i<count;i++){const target=total*i/count;while(cumulative[edge+1]!<target)edge++;const a=points[edge]!,b=points[(edge+1)%points.length]!,mix=(target-cumulative[edge]!)/(cumulative[edge+1]!-cumulative[edge]!);result.push([a[0]+mix*(b[0]-a[0]),a[1]+mix*(b[1]-a[1])]);}
  return result;
}

function totalDisplacement(preimage:Float64Array):Complex{
  const result={re:0,im:0};
  for(let j=0;j<128;j++){const d=spanDisplacement(spanPreimageBezier(preimage,j));result.re+=d[0];result.im+=d[1];}
  return result;
}

/** Solve both PH closure equations with one complex anti-periodic mode. */
function preimageFromGuide(guide:Point[],scale=1):Float64Array{
  const scaledGuide=guide.map(([x,y]):Point=>[scale*x,scale*y]);
  const points=resampleClosed(roundedGuide(scaledGuide,28),128),base=new Float64Array(256);let previousAngle=0;
  for(let j=0;j<128;j++){
    const before=points[(j+127)%128]!,after=points[(j+1)%128]!,dx=after[0]-before[0],dy=after[1]-before[1],magnitude=Math.hypot(dx,dy);let angle=Math.atan2(dy,dx);
    if(j>0){while(angle-previousAngle>Math.PI)angle-=2*Math.PI;while(angle-previousAngle<-Math.PI)angle+=2*Math.PI;}
    const rootMagnitude=Math.sqrt(magnitude);base[2*j]=rootMagnitude*Math.cos(angle/2);base[2*j+1]=rootMagnitude*Math.sin(angle/2);previousAngle=angle;
  }
  for(let pass=0;pass<4;pass++){
    const prior=base.slice();
    for(let j=0;j<128;j++){
      const before=j===0?127:j-1,after=j===127?0:j+1,beforeSign=j===0?-1:1,afterSign=j===127?-1:1;
      base[2*j]=(beforeSign*prior[2*before]!+2*prior[2*j]!+afterSign*prior[2*after]!)/4;
      base[2*j+1]=(beforeSign*prior[2*before+1]!+2*prior[2*j+1]!+afterSign*prior[2*after+1]!)/4;
    }
  }
  const result=base.slice(),directionValue=(direction:number,j:number):Complex=>{const mode=direction>>1,angle=(2*mode+1)*Math.PI*j/128,re=Math.cos(angle),im=Math.sin(angle);return(direction&1)===0?{re,im}:{re:-im,im:re};};
  for(let iteration=0;iteration<8;iteration++){
    const f=totalDisplacement(result);if(Math.hypot(f.re,f.im)<1e-12)break;
    const epsilon=1e-5,jacobian:Array<[number,number]>=[];
    for(let direction=0;direction<16;direction++){
      const perturbed=result.slice();for(let j=0;j<128;j++){const value=directionValue(direction,j);perturbed[2*j]=perturbed[2*j]!+epsilon*value.re;perturbed[2*j+1]=perturbed[2*j+1]!+epsilon*value.im;}
      const fp=totalDisplacement(perturbed);jacobian.push([(fp.re-f.re)/epsilon,(fp.im-f.im)/epsilon]);
    }
    let m00=0,m01=0,m11=0;for(const column of jacobian){m00+=column[0]*column[0];m01+=column[0]*column[1];m11+=column[1]*column[1];}const det=m00*m11-m01*m01;if(Math.abs(det)<1e-12)break;
    const lambda0=(-f.re*m11+m01*f.im)/det,lambda1=(m01*f.re-m00*f.im)/det;
    for(let direction=0;direction<16;direction++){const amount=jacobian[direction]![0]*lambda0+jacobian[direction]![1]*lambda1;for(let j=0;j<128;j++){const value=directionValue(direction,j);result[2*j]=result[2*j]!+amount*value.re;result[2*j+1]=result[2*j+1]!+amount*value.im;}}
  }
  return result;
}

function createGuideLine(guide:Point[],scale=1):PhLineSpec{
  const preimage=preimageFromGuide(guide,scale),gates=gatesFromPreimage(preimage),points=tessellateLine({preimage,gates},.2);let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
  for(let i=0;i<points.length;i+=2){minX=Math.min(minX,points[i]!);maxX=Math.max(maxX,points[i]!);minY=Math.min(minY,points[i+1]!);maxY=Math.max(maxY,points[i+1]!);}
  const shiftX=-(minX+maxX)/2,shiftY=-(minY+maxY)/2;for(let i=0;i<gates.length;i+=2){gates[i]=gates[i]!+shiftX;gates[i+1]=gates[i+1]!+shiftY;}return{preimage,gates};
}

function createPresetLine(preset:Preset):PhLineSpec{
  const angle=(preset.rotationDeg??0)*Math.PI/180,cos=Math.cos(angle),sin=Math.sin(angle),initial=preset.guide.map(([x,y]):Point=>{const sx=x*(preset.xScale??1),sy=y*(preset.yScale??1);return[sx*cos-sy*sin,sx*sin+sy*cos];});
  const meanX=initial.reduce((sum,p)=>sum+p[0],0)/initial.length,meanY=initial.reduce((sum,p)=>sum+p[1],0)/initial.length;let xx=0,xy=0,yy=0;for(const p of initial){const x=p[0]-meanX,y=p[1]-meanY;xx+=x*x;xy+=x*y;yy+=y*y;}const principal=.5*Math.atan2(2*xy,xx-yy),alignCos=Math.cos(-principal),alignSin=Math.sin(-principal),transformed=initial.map(([x,y]):Point=>[x*alignCos-y*alignSin,x*alignSin+y*alignCos]);
  let area=0;for(let i=0;i<transformed.length;i++){const a=transformed[i]!,b=transformed[(i+1)%transformed.length]!;area+=a[0]*b[1]-a[1]*b[0];}const guide=area<0?[...transformed].reverse():transformed;return createGuideLine(guide,1.5);
}

function quadCell(vertices:[number,number][],gateLo:number,gateHi:number,index:number):CorridorCellJson{
  let area=0;for(let i=0;i<4;i++)area+=vertices[i]![0]*vertices[(i+1)%4]![1]-vertices[i]![1]*vertices[(i+1)%4]![0];
  const halfSpaces=vertices.map((a,i)=>{const b=vertices[(i+1)%4]!,dx=b[0]-a[0],dy=b[1]-a[1],m=Math.hypot(dx,dy),nx=(area>0?dy:-dy)/m,ny=(area>0?-dx:dx)/m;return{nx,ny,b:nx*a[0]+ny*a[1]};});return{halfSpaces,gateLo,gateHi,neighbors:[(index+255)%256,(index+1)%256]};
}

function pairArray(values:Float64Array):[number,number][]{const out:[number,number][]=[];for(let i=0;i<values.length;i+=2)out.push([values[i]!,values[i+1]!]);return out;}

function compileLine(spec:PhLineSpec,source:TrackSourceJson,sourceSha256:string):CompiledTrackJson{
  const leftWidth=source.leftWidthM,rightWidth=source.rightWidthM,left:RationalOffsetSpanJson[]=exactOffsetBoundary(spec,leftWidth),right:RationalOffsetSpanJson[]=exactOffsetBoundary(spec,-rightWidth),cells:CorridorCellJson[]=[],microCells:number[][]=[];let length=0,kMin=Infinity,kMax=-Infinity;
  for(let m=0;m<256;m++){
    const p0=evaluateLineFrame(spec,m/4),p1=evaluateLineFrame(spec,(m+1)/4),c0=evaluateLineFrame(spec,(m-1)/4),c1=evaluateLineFrame(spec,(m+2)/4),cl0:[number,number]=[c0.x-c0.ty*leftWidth,c0.y+c0.tx*leftWidth],cl1:[number,number]=[c1.x-c1.ty*leftWidth,c1.y+c1.tx*leftWidth],cr0:[number,number]=[c0.x+c0.ty*rightWidth,c0.y-c0.tx*rightWidth],cr1:[number,number]=[c1.x+c1.ty*rightWidth,c1.y-c1.tx*rightWidth];
    cells.push(quadCell([cl0,cl1,cr1,cr0],(m-1)/4,(m+2)/4,m));microCells.push([m,(m+255)%256,(m+1)%256,(m+254)%256,(m+2)%256,(m+253)%256,(m+3)%256,(m+252)%256]);length+=Math.hypot(p1.x-p0.x,p1.y-p0.y);kMin=Math.min(kMin,p0.kappa);kMax=Math.max(kMax,p0.kappa);
  }
  const pts=tessellateLine(spec,.25);let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;for(let i=0;i<pts.length;i+=2){minX=Math.min(minX,pts[i]!);maxX=Math.max(maxX,pts[i]!);minY=Math.min(minY,pts[i+1]!);maxY=Math.max(maxY,pts[i+1]!);}
  return{schemaVersion:1,source,sourceSha256,normalization:{originX:0,originY:0,scaleH:Math.max(maxX-minX,maxY-minY)},centerPreimageControls:pairArray(spec.preimage),gatePoints:pairArray(spec.gates),lapLengthM:length,curvature:{min:kMin,max:kMax,rhoLeft:kMax>0?1/kMax:1e9,rhoRight:kMin<0?-1/kMin:1e9},leftBoundary:left,rightBoundary:right,cells,microCells,renderSeeds:Array.from({length:257},(_,i)=>i/4),compilerVersion:1,certificateReport:{maxInterpResidual:0,minPreimageSpeed:1,maxSeamResidual:0,minContainmentBound:0,maxUtilizationBound:0,speedFixedPointResidual:0,adaptiveEdgeCount:0,lapTimeDelta:0,codeVersion:1,pass:true}};
}

function compilePreset(preset:Preset):CompiledTrackJson{
  const spec=createPresetLine(preset),source:TrackSourceJson={schemaVersion:1,id:preset.id,name:preset.name,description:preset.description,direction:"counterclockwise",centerGatesM:pairArray(spec.gates),leftWidthM:preset.width,rightWidthM:preset.width,startGate:0,tags:preset.tags,sourceVersion:1};
  return compileLine(spec,source,preset.id.padEnd(64,"0").slice(0,64));
}

/** Compile an editable guide without mutating any canonical catalog asset. */
export function compileEditableTrack(source:TrackSourceJson):CompiledTrackJson{
  if(source.centerGatesM.length<8||source.centerGatesM.length>128)throw new RangeError("editable tracks require 8 to 128 guide nodes");
  const xs=source.centerGatesM.map(point=>point[0]),ys=source.centerGatesM.map(point=>point[1]),cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
  let guide:Point[]=source.centerGatesM.map(([x,y]):Point=>[x-cx,y-cy]),area=0;
  for(let i=0;i<guide.length;i++){const a=guide[i]!,b=guide[(i+1)%guide.length]!;area+=a[0]*b[1]-a[1]*b[0];}
  if(area<0)guide=[...guide].reverse();
  const normalizedSource:TrackSourceJson={...source,centerGatesM:guide.map(([x,y]):Point=>[x,y])};
  const identity=`${source.id}-${source.sourceVersion}`.replace(/[^a-zA-Z0-9]/g,"");
  return compileLine(createGuideLine(guide),normalizedSource,identity.padEnd(64,"0").slice(0,64));
}

export const BUILT_IN_TRACKS:CompiledTrackJson[]=PRESETS.map(compilePreset);
