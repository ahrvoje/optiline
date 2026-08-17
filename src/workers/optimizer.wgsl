// V2 Fourier-backbone + high-pass quintic-residual proxy. Geometry is
// station-major and one invocation evaluates one (station, candidate) pair.
@group(0) @binding(0) var<storage, read> coefficients: array<f32>;
@group(0) @binding(1) var<storage, read> referenceGeometry: array<vec4f>;
@group(0) @binding(2) var<storage, read> basisTable: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> stationGeometry: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> stationViolation: array<f32>;
@group(0) @binding(5) var<storage, read_write> results: array<vec4f>;
@group(0) @binding(6) var<storage, read> settings: array<f32>;
@group(0) @binding(7) var<storage, read_write> speedProfile: array<f32>;

fn cross2(a: vec2f, b: vec2f) -> f32 {
  return a.x * b.y - a.y * b.x;
}

@compute @workgroup_size(256)
fn geometryMain(@builtin(global_invocation_id) id: vec3u) {
  let flatIndex = id.x;
  let candidateCount = u32(settings[0]);
  let coefficientCount = u32(settings[1]);
  let stationCount = u32(settings[2]);
  if (flatIndex >= candidateCount * stationCount) { return; }
  let candidate = flatIndex % candidateCount;
  let station = flatIndex / candidateCount;
  let corridorMidpoint = 0.5 * (settings[3] + settings[4]);
  let corridorHalfWidth = 0.5 * (settings[4] - settings[3]);
  let laneLeft = settings[5];
  let laneRight = settings[6];
  let halfLength = settings[7];
  let halfWidth = settings[8];
  let maximumSpeedSquared = settings[9];
  let lateralCapacity = settings[10];
  let downforce = settings[11];
  let curvatureLimit = settings[12];
  let progressLimit = settings[13];

  var z = 0.0;
  var z1 = 0.0;
  var z2 = 0.0;
  for (var coefficientIndex = 0u; coefficientIndex < coefficientCount; coefficientIndex++) {
    let basis = basisTable[station * coefficientCount + coefficientIndex];
    // Coefficient-major layout keeps adjacent candidate loads coalesced.
    let coefficient = coefficients[coefficientIndex * candidateCount + candidate];
    z += coefficient * basis.x;
    z1 += coefficient * basis.y;
    z2 += coefficient * basis.z;
  }
  let eta = tanh(z);
  let etaFactor = 1.0 - eta * eta;
  let d = corridorMidpoint + corridorHalfWidth * eta;
  let d1 = corridorHalfWidth * etaFactor * z1;
  let d2 = corridorHalfWidth * etaFactor * (z2 - 2.0 * eta * z1 * z1);
  let c0c1 = referenceGeometry[3u * station];
  let c2n0 = referenceGeometry[3u * station + 1u];
  let n1n2 = referenceGeometry[3u * station + 2u];
  let c1 = c0c1.zw;
  let c2 = c2n0.xy;
  let n0 = c2n0.zw;
  let n1 = n1n2.xy;
  let n2 = n1n2.zw;
  let r1 = c1 + d1 * n0 + d * n1;
  let r2 = c2 + d2 * n0 + 2.0 * d1 * n1 + d * n2;
  let metric = length(r1);
  let referenceMetric = length(c1);
  let distance = metric / f32(stationCount);
  let curvature = cross2(r1, r2) / max(metric * metric * metric, 1e-20);
  let tangent = r1 / max(metric, 1e-20);
  let referenceTangent = c1 / max(referenceMetric, 1e-20);
  let relativeCosine = clamp(dot(tangent, referenceTangent), -1.0, 1.0);
  let relativeSine = cross2(referenceTangent, tangent);
  let extent = halfLength * abs(relativeSine) + halfWidth * abs(relativeCosine);
  let clearance = min(laneLeft - (d + extent), laneRight - (-d + extent));
  let denominator = abs(curvature) - lateralCapacity * downforce;
  var cap = maximumSpeedSquared;
  if (denominator > 0.0) { cap = min(cap, lateralCapacity / denominator); }
  var violation = max(0.0, -clearance) / max(1.0, 2.0 * halfWidth);
  violation = max(violation, max(0.0, progressLimit - relativeCosine) / progressLimit);
  if (curvatureLimit > 0.0) {
    violation = max(violation, max(0.0, abs(curvature) - curvatureLimit) / curvatureLimit);
  }
  if (!(metric > 1e-8) || !(cap > 0.0)) { violation = max(violation, 1.0); }
  stationGeometry[flatIndex] = vec4f(distance, curvature, cap, clearance);
  stationViolation[flatIndex] = violation;
  speedProfile[flatIndex] = cap;
}

fn tireRemainder(speedSquared: f32, curvature: f32) -> f32 {
  let load = 1.0 + settings[11] * speedSquared;
  let lateralUse = abs(speedSquared * curvature) /
    max(settings[10] * load, 1e-12);
  if (lateralUse >= 1.0) { return 0.0; }
  let ellipseP = settings[17];
  return pow(max(0.0, 1.0 - pow(lateralUse, ellipseP)), 1.0 / ellipseP);
}

fn forwardReach(initial: f32, distance: f32, curvature: f32) -> f32 {
  let load = 1.0 + settings[11] * initial;
  let acceleration = settings[15] * load * tireRemainder(initial, curvature) -
    settings[18] * initial;
  return max(0.0, initial + 2.0 * distance * acceleration);
}

fn brakingReach(next: f32, distance: f32, curvature: f32) -> f32 {
  let load = 1.0 + settings[11] * next;
  let braking = settings[16] * load * tireRemainder(next, curvature) +
    settings[18] * next;
  return max(0.0, next + 2.0 * distance * braking);
}

@compute @workgroup_size(256)
fn reduceMain(@builtin(global_invocation_id) id: vec3u) {
  let candidate = id.x;
  let candidateCount = u32(settings[0]);
  let stationCount = u32(settings[2]);
  if (candidate >= candidateCount) { return; }
  let effectiveLength = settings[14];
  var proxyTime = 0.0;
  var pathLength = 0.0;
  var regularizerIntegral = 0.0;
  var violation = 0.0;
  var minimumClearance = 1e30;

  // Solve the cyclic longitudinal envelope before ranking the candidate.
  // Binary64 elite reranking remains authoritative.
  for (var sweep = 0u; sweep < 8u; sweep++) {
    for (var station = 0u; station < stationCount; station++) {
      let previousStation = (station + stationCount - 1u) % stationCount;
      let previousIndex = previousStation * candidateCount + candidate;
      let index = station * candidateCount + candidate;
      let interval = stationGeometry[previousIndex];
      speedProfile[index] = min(
        speedProfile[index],
        forwardReach(speedProfile[previousIndex], interval.x, interval.y),
      );
    }
    for (var reverse = 0u; reverse < stationCount; reverse++) {
      let station = stationCount - 1u - reverse;
      let nextStation = (station + 1u) % stationCount;
      let index = station * candidateCount + candidate;
      let nextIndex = nextStation * candidateCount + candidate;
      let interval = stationGeometry[index];
      speedProfile[index] = min(
        speedProfile[index],
        brakingReach(speedProfile[nextIndex], interval.x, interval.y),
      );
    }
  }

  for (var station = 0u; station < stationCount; station++) {
    let index = station * candidateCount + candidate;
    let nextStation = (station + 1u) % stationCount;
    let nextIndex = nextStation * candidateCount + candidate;
    let previousStation = (station + stationCount - 1u) % stationCount;
    let previous = stationGeometry[previousStation * candidateCount + candidate];
    let current = stationGeometry[index];
    violation = max(violation, stationViolation[index]);
    minimumClearance = min(minimumClearance, current.w);
    proxyTime += 2.0 * current.x /
      max(sqrt(max(speedProfile[index], 1e-12)) +
          sqrt(max(speedProfile[nextIndex], 1e-12)), 1e-12);
    pathLength += current.x;
    let derivative = (current.y - previous.y) / max(0.5 * (current.x + previous.x), 1e-8);
    let scaledDerivative = effectiveLength * effectiveLength * derivative;
    regularizerIntegral += current.x * scaledDerivative * scaledDerivative;
  }
  let regularizer = regularizerIntegral / max(pathLength, 1e-8);
  if (!(proxyTime >= 0.0) || proxyTime > 1e20) {
    proxyTime = 1e30;
    violation = 1e30;
  }
  results[candidate] = vec4f(proxyTime, violation, regularizer, minimumClearance);
}
