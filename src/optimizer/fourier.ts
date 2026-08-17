/** Periodic real Fourier bases used by the V2 kernel, lateral, and curvature fields. */

const TWO_PI = 2 * Math.PI;

export function fourierCoefficientCount(modeCount: number): number {
  if (!Number.isInteger(modeCount) || modeCount < 0) {
    throw new RangeError("Fourier mode count must be a nonnegative integer");
  }
  return 1 + 2 * modeCount;
}

/**
 * Packed order: constant, cos(2 pi u), sin(2 pi u), cos(4 pi u), ...
 * Returned rows contain derivatives with respect to normalized u.
 */
export function evaluateFourierBasis(
  modeCount: number,
  u: number,
  maxDerivative = 0,
): Float64Array[] {
  if (!Number.isFinite(u) || !Number.isInteger(maxDerivative) || maxDerivative < 0) {
    throw new RangeError("invalid Fourier basis request");
  }
  const count = fourierCoefficientCount(modeCount);
  const rows = Array.from(
    { length: maxDerivative + 1 },
    () => new Float64Array(count),
  );
  rows[0]![0] = 1;
  for (let mode = 1; mode <= modeCount; mode++) {
    const omega = TWO_PI * mode;
    const phase = omega * u;
    const cosineIndex = 2 * mode - 1;
    const sineIndex = 2 * mode;
    let power = 1;
    for (let derivative = 0; derivative <= maxDerivative; derivative++) {
      const shifted = phase + derivative * Math.PI / 2;
      rows[derivative]![cosineIndex] = power * Math.cos(shifted);
      rows[derivative]![sineIndex] = power * Math.sin(shifted);
      power *= omega;
    }
  }
  return rows;
}

export function evaluateFourierSeries(
  coefficients: ArrayLike<number>,
  u: number,
  maxDerivative = 0,
): Float64Array {
  if (coefficients.length === 0 || (coefficients.length & 1) === 0) {
    throw new RangeError("packed Fourier coefficients must have odd nonzero length");
  }
  const modes = (coefficients.length - 1) / 2;
  const basis = evaluateFourierBasis(modes, u, maxDerivative);
  const result = new Float64Array(maxDerivative + 1);
  for (let derivative = 0; derivative <= maxDerivative; derivative++) {
    for (let column = 0; column < coefficients.length; column++) {
      result[derivative] = result[derivative]! +
        (coefficients[column] ?? 0) * basis[derivative]![column]!;
    }
  }
  return result;
}

/** Discrete Fourier least-squares fit at equally spaced periodic samples. */
export function fitRealFourier(
  samples: ArrayLike<number>,
  modeCount: number,
  smoothingLambda = 0,
  smoothingOrder = 4,
): Float64Array {
  const sampleCount = samples.length;
  if (!Number.isInteger(sampleCount) || sampleCount < 2 * modeCount + 1 ||
      !Number.isFinite(smoothingLambda) || smoothingLambda < 0 ||
      !Number.isInteger(smoothingOrder) || smoothingOrder < 0) {
    throw new RangeError("invalid Fourier fit request");
  }
  const coefficients = new Float64Array(fourierCoefficientCount(modeCount));
  for (let sample = 0; sample < sampleCount; sample++) {
    coefficients[0] = coefficients[0]! + (samples[sample] ?? 0) / sampleCount;
  }
  for (let mode = 1; mode <= modeCount; mode++) {
    let cosine = 0;
    let sine = 0;
    for (let sample = 0; sample < sampleCount; sample++) {
      const phase = TWO_PI * mode * sample / sampleCount;
      const value = samples[sample] ?? 0;
      cosine += value * Math.cos(phase);
      sine += value * Math.sin(phase);
    }
    const regularizer = 1 + smoothingLambda * mode ** (2 * smoothingOrder);
    coefficients[2 * mode - 1] = 2 * cosine / sampleCount / regularizer;
    coefficients[2 * mode] = 2 * sine / sampleCount / regularizer;
  }
  return coefficients;
}

/** Physical-scale mode selection from specification V2 Sections 7.1 and 15.2. */
export function selectFourierModeRange(
  lapLengthM: number,
  minimumModes = 1,
  maximumModes = 32,
  initialWavelengthM = 150,
  finalWavelengthM = 30,
): { initial: number; maximum: number } {
  if (!(lapLengthM > 0) || !(initialWavelengthM > 0) || !(finalWavelengthM > 0) ||
      !Number.isInteger(minimumModes) || !Number.isInteger(maximumModes) ||
      minimumModes < 0 || maximumModes < minimumModes) {
    throw new RangeError("invalid physical Fourier mode limits");
  }
  const clamp = (value: number): number => Math.max(
    minimumModes,
    Math.min(maximumModes, Math.floor(value)),
  );
  const initial = clamp(lapLengthM / initialWavelengthM);
  const maximum = Math.max(initial, clamp(lapLengthM / finalWavelengthM));
  return { initial, maximum };
}
