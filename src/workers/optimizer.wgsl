// Fixed-work PH candidate scorer. The hot path uses exact PH span length,
// analytic tangent/curvature, fixed rectangle tests, and a coarse periodic
// acceleration/braking envelope. It contains no quadrature, inverse arc
// length, closest-point solve, or finite difference.
@group(0) @binding(0) var<storage, read> basePre: array<vec2f>;
@group(0) @binding(1) var<storage, read> centerGate: array<vec4f>;
@group(0) @binding(2) var<storage, read> incumbentDelta: array<f32>;
@group(0) @binding(3) var<storage, read_write> scores: array<f32>;
@group(0) @binding(4) var<storage, read> settings: array<f32>;
@group(0) @binding(5) var<storage, read> modeBasis: array<vec2f>;

const PREIMAGE_MODE_COUNT=176u;
const START_MODE=176u;
const SEARCH_MODE_COUNT=177u;
const CLOSURE_MODE_A=177u;
const CLOSURE_MODE_B=178u;
const BASIS_STRIDE=179u;
const SMOOTH_VARIANT_COUNT=3u;
const SMOOTH_FIRST_CANDIDATE=355u;
const SMOOTH_CANDIDATE_COUNT=384u;

fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x*b.x-a.y*b.y, a.x*b.y+a.y*b.x);
}

fn hash32(value: u32) -> u32 {
  var x = value;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

fn proposalNoise(candidate: u32, mode: u32, move: u32) -> f32 {
  let batch = u32(settings[14]);
  let seed = u32(settings[16]);
  let base = candidate ^ (batch * 0x9e3779b9u) ^ (mode * 0x85ebca6bu)
    ^ (move * 0x27d4eb2du) ^ seed;
  var sum = 0.0;
  for (var draw=0u; draw<4u; draw++) {
    let bits = hash32(base + draw * 0xc2b2ae35u);
    sum += f32(bits & 0x00ffffffu) / 16777216.0;
  }
  return sum - 2.0;
}

fn candidateMode(candidate: u32, move: u32) -> u32 {
  if (candidate > 0u && candidate <= 2u*SEARCH_MODE_COUNT) { return (candidate - 1u) / 2u; }
  if (candidate >= SMOOTH_FIRST_CANDIDATE &&
      candidate < SMOOTH_FIRST_CANDIDATE+SMOOTH_CANDIDATE_COUNT) {
    return (candidate-SMOOTH_FIRST_CANDIDATE)/SMOOTH_VARIANT_COUNT;
  }
  let base = hash32(candidate ^ (u32(settings[14]) * 0x9e3779b9u) ^ u32(settings[16]));
  if (move == 0u && (base & 15u) == 0u) { return START_MODE; }
  let stride = (hash32(base ^ 0x68bc21ebu) | 1u) % PREIMAGE_MODE_COUNT;
  return (base + move * stride) % PREIMAGE_MODE_COUNT;
}

fn candidateStep(candidate: u32, mode: u32, move: u32) -> f32 {
  if (candidate == 0u) { return 0.0; }
  let prior = incumbentDelta[mode];
  var change = 0.5 * settings[15] * proposalNoise(candidate, mode, move);
  if (candidate <= 2u*SEARCH_MODE_COUNT) {
    let bits=hash32(u32(settings[16]) ^ ((mode+1u)*0x85ebca6bu));
    let magnitude=0.02+0.1*(f32(bits & 0x00ffffffu)/16777216.0);
    change = select(magnitude, -magnitude, (candidate & 1u) == 1u);
  } else if (candidate >= SMOOTH_FIRST_CANDIDATE &&
             candidate < SMOOTH_FIRST_CANDIDATE+SMOOTH_CANDIDATE_COUNT) {
    let variant=(candidate-SMOOTH_FIRST_CANDIDATE)%SMOOTH_VARIANT_COUNT;
    var blend=1.0;
    if (variant == 1u) { blend=0.5; }
    if (variant == 2u) { blend=0.25; }
    let left=incumbentDelta[(mode+127u)%128u];
    let right=incumbentDelta[(mode+1u)%128u];
    let target=0.25*left+0.5*prior+0.25*right;
    change=blend*(target-prior);
  }
  return clamp(prior + change, -0.5, 0.5) - prior;
}

fn basisControl(index: i32, mode: u32) -> vec2f {
  var j = index;
  var sign = 1.0;
  if (j < 0) { j += 128; sign = -1.0; }
  if (j >= 128) { j -= 128; sign = -1.0; }
  return sign * modeBasis[BASIS_STRIDE * u32(j) + mode];
}

fn mutationControl(index: i32, modes: vec4u, steps: vec4f, moveCount: u32) -> vec2f {
  var change = vec2f(0.0);
  for (var move=0u; move<moveCount; move++) {
    change += steps[move] * basisControl(index, modes[move]);
  }
  return change;
}

fn control(index: i32, modes: vec4u, steps: vec4f, moveCount: u32, correction: vec2f) -> vec2f {
  var j = index;
  var sign = 1.0;
  if (j < 0) { j += 128; sign = -1.0; }
  if (j >= 128) { j -= 128; sign = -1.0; }
  return sign * basePre[u32(j)] + mutationControl(index, modes, steps, moveCount)
    + correction.x * basisControl(index, CLOSURE_MODE_A)
    + correction.y * basisControl(index, CLOSURE_MODE_B);
}

fn spanDisplacement(cm: vec2f, c0: vec2f, cp: vec2f) -> vec2f {
  let b0 = 0.5 * (cm + c0);
  let b1 = c0;
  let b2 = 0.5 * (c0 + cp);
  return 0.1 * (cmul(b0,b0) + cmul(b0,b1)
    + (cmul(b0,b2) + 2.0 * cmul(b1,b1)) / 3.0
    + cmul(b1,b2) + cmul(b2,b2));
}

fn spanDerivative(cm: vec2f, c0: vec2f, cp: vec2f,
                  dm: vec2f, d0: vec2f, dp: vec2f) -> vec2f {
  let b0 = 0.5 * (cm + c0);
  let b1 = c0;
  let b2 = 0.5 * (c0 + cp);
  let e0 = 0.5 * (dm + d0);
  let e1 = d0;
  let e2 = 0.5 * (d0 + dp);
  return 0.1 * (2.0 * cmul(b0,e0)
    + cmul(e0,b1) + cmul(b0,e1)
    + (cmul(e0,b2) + cmul(b0,e2) + 4.0 * cmul(b1,e1)) / 3.0
    + cmul(e1,b2) + cmul(b1,e2) + 2.0 * cmul(b2,e2));
}

fn closureProjection(modes: vec4u, steps: vec4f, moveCount: u32) -> vec2f {
  var correction = vec2f(0.0);
  for (var iteration=0u; iteration<4u; iteration++) {
    var residual = vec2f(0.0);
    var columnA = vec2f(0.0);
    var columnB = vec2f(0.0);
    var cm = control(-1, modes, steps, moveCount, correction);
    var c0 = control(0, modes, steps, moveCount, correction);
    var am = basisControl(-1, CLOSURE_MODE_A);
    var a0 = basisControl(0, CLOSURE_MODE_A);
    var bm = basisControl(-1, CLOSURE_MODE_B);
    var b0 = basisControl(0, CLOSURE_MODE_B);
    for (var span=0i; span<128i; span++) {
      let cp = control(span+1, modes, steps, moveCount, correction);
      let ap = basisControl(span+1, CLOSURE_MODE_A);
      let bp = basisControl(span+1, CLOSURE_MODE_B);
      residual += spanDisplacement(cm,c0,cp);
      columnA += spanDerivative(cm,c0,cp,am,a0,ap);
      columnB += spanDerivative(cm,c0,cp,bm,b0,bp);
      cm=c0; c0=cp; am=a0; a0=ap; bm=b0; b0=bp;
    }
    let determinant = columnA.x * columnB.y - columnA.y * columnB.x;
    if (abs(determinant) < 1e-10) { return vec2f(1e20); }
    correction += vec2f(
      (-residual.x * columnB.y + columnB.x * residual.y) / determinant,
      (-columnA.x * residual.y + residual.x * columnA.y) / determinant
    );
  }
  return correction;
}

fn longitudinalRemainder(q: f32, kappa: f32, ay: f32, ellipseP: f32, grip: f32) -> f32 {
  let loadScale = max(1.0 + grip*q, 1e-6);
  let lateralUse = clamp(q*kappa/(ay*loadScale), 0.0, 1.0);
  return pow(max(0.0, 1.0-pow(lateralUse, ellipseP)), 1.0/ellipseP);
}

fn spanCurvature(b0: vec2f, b1: vec2f, b2: vec2f, u: f32) -> f32 {
  let s = 1.0-u;
  let w = s*s*b0 + 2.0*s*u*b1 + u*u*b2;
  let wd = 2.0*(s*(b1-b0) + u*(b2-b1));
  let r = dot(w,w);
  return abs(4.0*(w.x*wd.y-w.y*wd.x)/(r*r));
}

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let candidate = id.x;
  let count = u32(settings[0]);
  if (candidate >= count) { return; }
  let isSmooth = candidate >= SMOOTH_FIRST_CANDIDATE &&
    candidate < SMOOTH_FIRST_CANDIDATE+SMOOTH_CANDIDATE_COUNT;
  let moveCount = select(4u, 1u, candidate <= 2u*SEARCH_MODE_COUNT || isSmooth);
  var modes = vec4u(0u);
  var steps = vec4f(0.0);
  for (var move=0u; move<moveCount; move++) {
    modes[move] = candidateMode(candidate, move);
    steps[move] = candidateStep(candidate, modes[move], move);
  }
  let correction = closureProjection(modes, steps, moveCount);
  let dLeft=settings[1]; let dRight=settings[2];
  let halfLength=0.5*(settings[3]+2.0*settings[5]);
  let halfWidth=0.5*(settings[4]+2.0*settings[5]);
  let vmax2=settings[6]*settings[6]; let axp=settings[7]; let axm=settings[8]; let ay=settings[9];
  let ellipseP=settings[10]; let drag=settings[11]; let grip=settings[12];
  let kappaLimit=settings[13];
  var startCoordinate=incumbentDelta[START_MODE];
  for (var move=0u; move<moveCount; move++) {
    if (modes[move] == START_MODE) { startCoordinate += steps[move]; }
  }
  let startOffset=select(2.0*dRight*startCoordinate,2.0*dLeft*startCoordinate,startCoordinate>=0.0);
  var position=centerGate[0].xy+startOffset*centerGate[0].zw;
  var valid=true;
  var segmentLength: array<f32,64>;
  var segmentKappa: array<f32,64>;
  var speedSquared: array<f32,64>;
  var cm=control(-1,modes,steps,moveCount,correction);
  var c0=control(0,modes,steps,moveCount,correction);
  for (var span=0i; span<128i; span++) {
    let cp=control(span+1,modes,steps,moveCount,correction);
    let b0=0.5*(cm+c0); let b1=c0; let b2=0.5*(c0+cp);
    let q0=cmul(b0,b0); let q1=cmul(b0,b1);
    let q2=(cmul(b0,b2)+2.0*cmul(b1,b1))/3.0;
    let q3=cmul(b1,b2); let q4=cmul(b2,b2);
    let displacement=0.1*(q0+q1+q2+q3+q4);
    if ((span & 1) == 0) {
      let gate=centerGate[u32(span/2)];
      let tangent=normalize(q0);
      let normal=vec2f(-tangent.y,tangent.x);
      let centerNormal=gate.zw;
      let lateral=dot(position-gate.xy,centerNormal);
      let extent=halfLength*abs(dot(tangent,centerNormal))+halfWidth*abs(dot(normal,centerNormal));
      if (lateral+extent>dLeft || lateral-extent < -dRight) { valid=false; }
    }
    let r0=dot(b0,b0); let r1=dot(b0,b1);
    let r2=(dot(b0,b2)+2.0*dot(b1,b1))/3.0;
    let r3=dot(b1,b2); let r4=dot(b2,b2);
    let length=0.1*(r0+r1+r2+r3+r4);
    var kappa=0.0;
    for (var curvatureSample=0u; curvatureSample<=8u; curvatureSample++) {
      kappa=max(kappa,spanCurvature(b0,b1,b2,f32(curvatureSample)/8.0));
    }
    if (kappaLimit>0.0 && kappa>kappaLimit) { valid=false; }
    if (!(length>0.0)) { valid=false; }
    let dynamicSegment=u32(span/2);
    segmentLength[dynamicSegment] += length;
    segmentKappa[dynamicSegment] = max(segmentKappa[dynamicSegment],kappa);
    position += displacement;
    cm=c0;
    c0=cp;
  }
  if (distance(position,centerGate[0].xy)>0.02) { valid=false; }

  // First cap each sector by speed, lateral grip, drag, and steady-state
  // traction. Then propagate acceleration and braking limits around the
  // closed loop. Three fixed forward/backward sweeps remove the arbitrary
  // start-line dependency without introducing a data-dependent GPU loop.
  for (var segment=0u; segment<64u; segment++) {
    let kappa=segmentKappa[segment];
    let combined=pow(pow(drag/axp,ellipseP)+pow(kappa/ay,ellipseP),1.0/ellipseP);
    let steady=select(1e20,1.0/(combined-grip),combined>grip);
    speedSquared[segment]=min(vmax2,steady);
    if (!(segmentLength[segment]>0.0) || !(speedSquared[segment]>0.0)) { valid=false; }
  }
  for (var sweep=0u; sweep<3u; sweep++) {
    for (var segment=0u; segment<64u; segment++) {
      let next=(segment+1u)%64u;
      let q=speedSquared[segment];
      let kappa=max(segmentKappa[segment],segmentKappa[next]);
      let remainder=longitudinalRemainder(q,kappa,ay,ellipseP,grip);
      let acceleration=max(0.0,axp*(1.0+grip*q)*remainder-drag*q);
      speedSquared[next]=min(speedSquared[next],q+2.0*acceleration*segmentLength[segment]);
    }
    for (var reverse=0u; reverse<64u; reverse++) {
      let segment=63u-reverse;
      let next=(segment+1u)%64u;
      let q=speedSquared[next];
      let kappa=max(segmentKappa[segment],segmentKappa[next]);
      let remainder=longitudinalRemainder(q,kappa,ay,ellipseP,grip);
      let braking=max(0.0,axm*(1.0+grip*q)*remainder+drag*q);
      speedSquared[segment]=min(speedSquared[segment],q+2.0*braking*segmentLength[segment]);
    }
  }
  var time=0.0;
  for (var segment=0u; segment<64u; segment++) {
    let next=(segment+1u)%64u;
    time += 2.0*segmentLength[segment]
      / max(sqrt(speedSquared[segment])+sqrt(speedSquared[next]),1e-6);
  }
  scores[candidate]=select(3.402823e38,time,valid);
}
