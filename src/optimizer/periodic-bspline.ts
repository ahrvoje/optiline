/** Periodic uniform B-splines used by the minimum-lap-time optimizer.
 *
 * The normalized parameter is u in [0, 1). Coefficients use cyclic indices,
 * so closure and every derivative supported by the degree are structural.
 */

const FACTORIAL = [1, 1, 2, 6, 24, 120, 720, 5040, 40320] as const;

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let value = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) {
    value = value * (n + 1 - i) / i;
  }
  return value;
}

function wrap(index: number, count: number): number {
  const value = index % count;
  return value < 0 ? value + count : value;
}

/** Centered cardinal B-spline M_degree and its analytic derivative. */
export function centeredCardinalBspline(
  degree: number,
  x: number,
  derivative = 0,
): number {
  if (!Number.isInteger(degree) || degree < 0 || degree > 7 ||
      !Number.isInteger(derivative) || derivative < 0 || derivative > degree) {
    throw new RangeError("unsupported B-spline degree or derivative");
  }
  const power = degree - derivative;
  const shift = (degree + 1) / 2;
  let sum = 0;
  for (let k = 0; k <= degree + 1; k++) {
    const positivePart = x + shift - k;
    if (positivePart <= 0) continue;
    const term = binomial(degree + 1, k) * positivePart ** power;
    sum += (k & 1) === 0 ? term : -term;
  }
  return sum / (FACTORIAL[power] ?? 1);
}

export interface PeriodicBasisSample {
  indices: Int32Array;
  /** weights[r][j] is d^r B_j / du^r. */
  weights: Float64Array[];
}

/** The degree + 1 nonzero periodic basis functions at one normalized u. */
export function periodicBasisSample(
  degree: number,
  controlCount: number,
  u: number,
  maxDerivative = degree,
): PeriodicBasisSample {
  if (!Number.isInteger(controlCount) || controlCount < degree + 1) {
    throw new RangeError("controlCount must be at least degree + 1");
  }
  if (!Number.isFinite(u) || maxDerivative < 0 || maxDerivative > degree) {
    throw new RangeError("invalid periodic B-spline sample request");
  }
  const wrappedU = ((u % 1) + 1) % 1;
  const x = wrappedU * controlCount;
  const first = Math.floor(x) - Math.floor(degree / 2);
  const indices = new Int32Array(degree + 1);
  const weights = Array.from(
    { length: maxDerivative + 1 },
    () => new Float64Array(degree + 1),
  );
  for (let j = 0; j <= degree; j++) {
    const unwrappedIndex = first + j;
    indices[j] = wrap(unwrappedIndex, controlCount);
    for (let derivative = 0; derivative <= maxDerivative; derivative++) {
      weights[derivative]![j] = centeredCardinalBspline(
        degree,
        x - unwrappedIndex,
        derivative,
      ) * controlCount ** derivative;
    }
  }
  return { indices, weights };
}

/** Evaluate a scalar periodic uniform B-spline through maxDerivative. */
export function evaluatePeriodicSpline(
  coefficients: ArrayLike<number>,
  degree: number,
  u: number,
  maxDerivative = 0,
): Float64Array {
  const sample = periodicBasisSample(degree, coefficients.length, u, maxDerivative);
  const result = new Float64Array(maxDerivative + 1);
  for (let derivative = 0; derivative <= maxDerivative; derivative++) {
    for (let j = 0; j <= degree; j++) {
      result[derivative] = result[derivative]! +
        (coefficients[sample.indices[j]!] ?? 0) * sample.weights[derivative]![j]!;
    }
  }
  return result;
}

/** Interpolate equally spaced periodic samples with a uniform B-spline. */
export function fitPeriodicSplineSamples(
  samples: ArrayLike<number>,
  degree = 5,
): Float64Array {
  const count = samples.length;
  if (!Number.isInteger(count) || count < degree + 1) {
    throw new RangeError("not enough samples for the periodic spline degree");
  }
  const stride = count + 1;
  const augmented = new Float64Array(count * stride);
  for (let row = 0; row < count; row++) {
    const basis = periodicBasisSample(degree, count, row / count, 0);
    for (let active = 0; active <= degree; active++) {
      const index = row * stride + basis.indices[active]!;
      augmented[index] = augmented[index]! + basis.weights[0]![active]!;
    }
    augmented[row * stride + count] = samples[row] ?? 0;
  }
  for (let column = 0; column < count; column++) {
    let pivot = column;
    for (let row = column + 1; row < count; row++) {
      if (Math.abs(augmented[row * stride + column]!) >
          Math.abs(augmented[pivot * stride + column]!)) pivot = row;
    }
    const diagonal = augmented[pivot * stride + column]!;
    if (!(Math.abs(diagonal) > 1e-13)) throw new Error("periodic spline fit is singular");
    if (pivot !== column) {
      for (let j = column; j < stride; j++) {
        const a = column * stride + j;
        const b = pivot * stride + j;
        const temporary = augmented[a]!;
        augmented[a] = augmented[b]!;
        augmented[b] = temporary;
      }
    }
    for (let row = column + 1; row < count; row++) {
      const factor = augmented[row * stride + column]! /
        augmented[column * stride + column]!;
      augmented[row * stride + column] = 0;
      for (let j = column + 1; j < stride; j++) {
        const index = row * stride + j;
        augmented[index] = augmented[index]! - factor * augmented[column * stride + j]!;
      }
    }
  }
  const coefficients = new Float64Array(count);
  for (let row = count - 1; row >= 0; row--) {
    let value = augmented[row * stride + count]!;
    for (let column = row + 1; column < count; column++) {
      value -= augmented[row * stride + column]! * coefficients[column]!;
    }
    coefficients[row] = value / augmented[row * stride + row]!;
  }
  return coefficients;
}

/**
 * Exact dyadic knot insertion for a periodic quintic cardinal spline.
 * The refined control net represents the identical continuous function.
 */
export function refinePeriodicQuintic(
  coefficients: ArrayLike<number>,
): Float64Array {
  const count = coefficients.length;
  if (count < 6) throw new RangeError("a quintic spline needs at least six controls");
  const refined = new Float64Array(2 * count);
  const mask = [1, 6, 15, 20, 15, 6, 1] as const;
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < mask.length; k++) {
      const target = wrap(2 * i - 3 + k, refined.length);
      refined[target] = refined[target]! + (coefficients[i] ?? 0) * mask[k]! / 32;
    }
  }
  return refined;
}

/** Reflect a coefficient into the structural [-1, 1] decoder bound. */
export function reflectSplineCoefficient(value: number): number {
  let shifted = (value + 1) % 4;
  if (shifted < 0) shifted += 4;
  return shifted <= 2 ? shifted - 1 : 3 - shifted;
}

export interface LateralCorridorSample {
  lower: number;
  upper: number;
  lowerDerivatives?: ArrayLike<number>;
  upperDerivatives?: ArrayLike<number>;
}

/** Decode d = midpoint + halfWidth*z, including derivatives through order 4. */
export function decodeLateralField(
  coefficients: ArrayLike<number>,
  u: number,
  corridor: LateralCorridorSample,
  maxDerivative = 4,
): Float64Array {
  const z = evaluatePeriodicSpline(coefficients, 5, u, maxDerivative);
  const midpoint = new Float64Array(maxDerivative + 1);
  const halfWidth = new Float64Array(maxDerivative + 1);
  midpoint[0] = 0.5 * (corridor.lower + corridor.upper);
  halfWidth[0] = 0.5 * (corridor.upper - corridor.lower);
  for (let derivative = 1; derivative <= maxDerivative; derivative++) {
    const lower = corridor.lowerDerivatives?.[derivative - 1] ?? 0;
    const upper = corridor.upperDerivatives?.[derivative - 1] ?? 0;
    midpoint[derivative] = 0.5 * (lower + upper);
    halfWidth[derivative] = 0.5 * (upper - lower);
  }
  const result = midpoint.slice();
  for (let derivative = 0; derivative <= maxDerivative; derivative++) {
    for (let k = 0; k <= derivative; k++) {
      result[derivative] = result[derivative]! + binomial(derivative, k) *
        halfWidth[k]! * z[derivative - k]!;
    }
  }
  return result;
}

/** Packed station-major [B, B', B'', cyclicIndex] records for WGSL. */
export function buildQuinticBasisTable(
  controlCount: number,
  stationCount: number,
): Float32Array {
  if (!Number.isInteger(stationCount) || stationCount <= 0) {
    throw new RangeError("stationCount must be positive");
  }
  const table = new Float32Array(stationCount * 6 * 4);
  for (let station = 0; station < stationCount; station++) {
    const sample = periodicBasisSample(5, controlCount, station / stationCount, 2);
    for (let active = 0; active < 6; active++) {
      const base = 4 * (6 * station + active);
      table[base] = sample.weights[0]![active]!;
      table[base + 1] = sample.weights[1]![active]!;
      table[base + 2] = sample.weights[2]![active]!;
      table[base + 3] = sample.indices[active]!;
    }
  }
  return table;
}
