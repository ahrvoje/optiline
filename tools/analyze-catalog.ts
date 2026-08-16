import { BUILT_IN_TRACKS } from "@/model/catalog";
import { centerlineSpec, sampleLineFrames } from "@/renderer/ph-tessellate";
import { genotypeForLine, lineFromSearchDelta, SEARCH_MODE_COUNT } from "@/optimizer/ph-search";

for (const track of BUILT_IN_TRACKS) {
  const frames = sampleLineFrames(centerlineSpec(track), 4096);
  let straightLength=0,currentStraight=0;
  let absoluteTurn = 0;
  let signedTurn = 0;
  const turnSteps:number[]=[];
  for (let i = 0; i < frames.length; i++) {
    const a = frames[i]!;
    const b = frames[(i + 1) % frames.length]!;
    const angle = Math.atan2(a.tx * b.ty - a.ty * b.tx, a.tx * b.tx + a.ty * b.ty);
    const ds=Math.hypot(b.x-a.x,b.y-a.y);if(Math.abs(a.kappa)<.001){currentStraight+=ds;straightLength=Math.max(straightLength,currentStraight);}else currentStraight=0;
    absoluteTurn += Math.abs(angle);
    signedTurn += angle;
    turnSteps.push(angle);
  }
  let hairpinTurn=0;for(let start=0;start<frames.length;start++){let sum=0;for(let offset=0;offset<1024;offset++)sum+=turnSteps[(start+offset)%turnSteps.length]!;hairpinTurn=Math.max(hairpinTurn,Math.abs(sum));}
  const sharpestIndex=frames.reduce((best,frame,index)=>Math.abs(frame.kappa)>Math.abs(frames[best]!.kappa)?index:best,0);
  console.info(JSON.stringify({
    id: track.source.id,
    absoluteTurnDeg: absoluteTurn * 180 / Math.PI,
    signedTurnDeg: signedTurn * 180 / Math.PI,
    curvatureMin: track.curvature.min,
    curvatureMax: track.curvature.max,
    preimageMin: Math.min(...track.centerPreimageControls.map(point => Math.hypot(point[0], point[1]))),
    preimageMax: Math.max(...track.centerPreimageControls.map(point => Math.hypot(point[0], point[1]))),
    scaleH: track.normalization.scaleH,
    straightLength,
    hairpinTurnDeg:hairpinTurn*180/Math.PI,
    sharpest:{parameter:64*sharpestIndex/frames.length,x:frames[sharpestIndex]!.x,y:frames[sharpestIndex]!.y,kappa:frames[sharpestIndex]!.kappa},
    modeDisplacements: Array.from({length:SEARCH_MODE_COUNT},(_,mode)=>{const delta=new Float32Array(SEARCH_MODE_COUNT);delta[mode]=.05;return Math.max(...Array.from(genotypeForLine(track,lineFromSearchDelta(track,delta)),Math.abs));}),
  }));
}
