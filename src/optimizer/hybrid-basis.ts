import {
  evaluateFourierBasis,
  fourierCoefficientCount,
} from "@/optimizer/fourier";
import {
  periodicBasisSample,
  refinePeriodicQuintic,
} from "@/optimizer/periodic-bspline";

const BINOMIAL = [
  [1],
  [1, 1],
  [1, 2, 1],
  [1, 3, 3, 1],
  [1, 4, 6, 4, 1],
] as const;

function choose(n: number, k: number): number {
  return BINOMIAL[n]?.[k] ?? 0;
}

export interface HybridPeriodicBasis {
  fourierModes: number;
  residualControlCount: number;
  /** Column-major G[fourierColumn, residualControl]. */
  residualProjection: Float64Array;
}

export function hybridCoefficientCount(model: HybridPeriodicBasis): number {
  return fourierCoefficientCount(model.fourierModes) + model.residualControlCount;
}

/**
 * Build G=(F'WF)^-1 F'WB for uniform periodic quadrature. The sampled real
 * Fourier columns are mutually orthogonal, so the inverse is diagonal.
 */
export function buildHybridPeriodicBasis(
  fourierModes: number,
  residualControlCount: number,
  quadratureCount = Math.max(1024, 16 * residualControlCount, 64 * fourierModes),
): HybridPeriodicBasis {
  const fourierCount = fourierCoefficientCount(fourierModes);
  if (!Number.isInteger(residualControlCount) || residualControlCount < 0 ||
      (residualControlCount > 0 && residualControlCount < 6) ||
      !Number.isInteger(quadratureCount) || quadratureCount < 2 * fourierModes + 1) {
    throw new RangeError("invalid hybrid periodic basis dimensions");
  }
  const projection = new Float64Array(fourierCount * residualControlCount);
  if (residualControlCount === 0) {
    return { fourierModes, residualControlCount, residualProjection: projection };
  }
  const norms = new Float64Array(fourierCount);
  for (let sample = 0; sample < quadratureCount; sample++) {
    const u = sample / quadratureCount;
    const fourier = evaluateFourierBasis(fourierModes, u, 0)[0]!;
    const spline = periodicBasisSample(5, residualControlCount, u, 0);
    for (let column = 0; column < fourierCount; column++) {
      const f = fourier[column]!;
      norms[column] = norms[column]! + f * f;
      for (let active = 0; active < 6; active++) {
        const residual = spline.indices[active]!;
        projection[column * residualControlCount + residual] =
          projection[column * residualControlCount + residual]! +
          f * spline.weights[0]![active]!;
      }
    }
  }
  for (let column = 0; column < fourierCount; column++) {
    const inverseNorm = 1 / norms[column]!;
    for (let residual = 0; residual < residualControlCount; residual++) {
      projection[column * residualControlCount + residual] =
        projection[column * residualControlCount + residual]! * inverseNorm;
    }
  }
  return { fourierModes, residualControlCount, residualProjection: projection };
}

export function splitHybridCoefficients(
  model: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
): { fourier: Float64Array; residual: Float64Array } {
  const fourierCount = fourierCoefficientCount(model.fourierModes);
  if (coefficients.length !== fourierCount + model.residualControlCount) {
    throw new RangeError("coefficient vector does not match its hybrid basis");
  }
  return {
    fourier: Float64Array.from({ length: fourierCount }, (_, i) => coefficients[i] ?? 0),
    residual: Float64Array.from(
      { length: model.residualControlCount },
      (_, i) => coefficients[fourierCount + i] ?? 0,
    ),
  };
}

/** Evaluate z_F + (I-P_F) Bc and analytic normalized-u derivatives. */
export function evaluateHybridField(
  model: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
  u: number,
  maxDerivative = 0,
  preparedProjection?: ArrayLike<number>,
): Float64Array {
  if (!Number.isInteger(maxDerivative) || maxDerivative < 0 || maxDerivative > 4) {
    throw new RangeError("hybrid field supports derivatives through order four");
  }
  const fourierCount = fourierCoefficientCount(model.fourierModes);
  if (coefficients.length !== fourierCount + model.residualControlCount) {
    throw new RangeError("coefficient vector does not match its hybrid basis");
  }
  const fourierBasis = evaluateFourierBasis(model.fourierModes, u, maxDerivative);
  const result = new Float64Array(maxDerivative + 1);
  for (let derivative = 0; derivative <= maxDerivative; derivative++) {
    for (let column = 0; column < fourierCount; column++) {
      result[derivative] = result[derivative]! +
        (coefficients[column] ?? 0) * fourierBasis[derivative]![column]!;
    }
  }
  if (model.residualControlCount === 0) return result;
  const spline = periodicBasisSample(5, model.residualControlCount, u, maxDerivative);
  const projectedFourier = preparedProjection ?? projectHybridResidual(model, coefficients);
  if (projectedFourier.length !== fourierCount) {
    throw new RangeError("prepared hybrid projection has the wrong length");
  }
  for (let derivative = 0; derivative <= maxDerivative; derivative++) {
    for (let active = 0; active < 6; active++) {
      result[derivative] = result[derivative]! +
        (coefficients[fourierCount + spline.indices[active]!] ?? 0) *
        spline.weights[derivative]![active]!;
    }
    for (let column = 0; column < fourierCount; column++) {
      result[derivative] = result[derivative]! -
        projectedFourier[column]! * fourierBasis[derivative]![column]!;
    }
  }
  return result;
}

/** Candidate-invariant G*c term reused by every station evaluation. */
export function projectHybridResidual(
  model: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
): Float64Array {
  const fourierCount = fourierCoefficientCount(model.fourierModes);
  if (coefficients.length !== fourierCount + model.residualControlCount) {
    throw new RangeError("coefficient vector does not match its hybrid basis");
  }
  const projected = new Float64Array(fourierCount);
  for (let column = 0; column < fourierCount; column++) {
    for (let residual = 0; residual < model.residualControlCount; residual++) {
      projected[column] = projected[column]! +
        model.residualProjection[column * model.residualControlCount + residual]! *
        (coefficients[fourierCount + residual] ?? 0);
    }
  }
  return projected;
}

/** Derivatives of tanh(z(u)), computed from y'=(1-y^2)z'. */
export function tanhJet(z: ArrayLike<number>, maxDerivative = z.length - 1): Float64Array {
  if (maxDerivative < 0 || maxDerivative > 4 || z.length <= maxDerivative) {
    throw new RangeError("tanh jet supports complete derivative jets through order four");
  }
  const y = new Float64Array(maxDerivative + 1);
  y[0] = Math.tanh(z[0] ?? 0);
  for (let derivative = 0; derivative < maxDerivative; derivative++) {
    const oneMinusSquare = new Float64Array(derivative + 1);
    for (let order = 0; order <= derivative; order++) {
      let squareDerivative = 0;
      for (let k = 0; k <= order; k++) {
        squareDerivative += choose(order, k) * y[k]! * y[order - k]!;
      }
      oneMinusSquare[order] = (order === 0 ? 1 : 0) - squareDerivative;
    }
    for (let k = 0; k <= derivative; k++) {
      y[derivative + 1] = y[derivative + 1]! + choose(derivative, k) *
        oneMinusSquare[k]! * (z[derivative - k + 1] ?? 0);
    }
  }
  return y;
}

export interface HybridCorridorSample {
  lower: number;
  upper: number;
  lowerDerivatives?: ArrayLike<number>;
  upperDerivatives?: ArrayLike<number>;
}

/** V2 bounded decoder d=m+h*tanh(z), including derivatives through order four. */
export function decodeBoundedHybridField(
  model: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
  u: number,
  corridor: HybridCorridorSample,
  maxDerivative = 4,
  preparedProjection?: ArrayLike<number>,
): Float64Array {
  const z = evaluateHybridField(
    model, coefficients, u, maxDerivative, preparedProjection,
  );
  const eta = tanhJet(z, maxDerivative);
  const midpoint = new Float64Array(maxDerivative + 1);
  const halfWidth = new Float64Array(maxDerivative + 1);
  midpoint[0] = 0.5 * (corridor.lower + corridor.upper);
  halfWidth[0] = 0.5 * (corridor.upper - corridor.lower);
  if (!(halfWidth[0]! >= 0)) throw new RangeError("corridor lower bound exceeds upper bound");
  for (let derivative = 1; derivative <= maxDerivative; derivative++) {
    const lower = corridor.lowerDerivatives?.[derivative - 1] ?? 0;
    const upper = corridor.upperDerivatives?.[derivative - 1] ?? 0;
    midpoint[derivative] = 0.5 * (lower + upper);
    halfWidth[derivative] = 0.5 * (upper - lower);
  }
  const result = midpoint.slice();
  for (let derivative = 0; derivative <= maxDerivative; derivative++) {
    for (let k = 0; k <= derivative; k++) {
      result[derivative] = result[derivative]! + choose(derivative, k) *
        halfWidth[k]! * eta[derivative - k]!;
    }
  }
  return result;
}

/** Dense [value, first, second, unused] table for the WebGPU proxy kernel. */
export function buildHybridBasisTable(
  model: HybridPeriodicBasis,
  stationCount: number,
): Float32Array {
  if (!Number.isInteger(stationCount) || stationCount <= 0) {
    throw new RangeError("stationCount must be positive");
  }
  const coefficientCount = hybridCoefficientCount(model);
  const fourierCount = fourierCoefficientCount(model.fourierModes);
  const table = new Float32Array(stationCount * coefficientCount * 4);
  for (let station = 0; station < stationCount; station++) {
    const u = station / stationCount;
    const fourier = evaluateFourierBasis(model.fourierModes, u, 2);
    for (let column = 0; column < fourierCount; column++) {
      const base = 4 * (station * coefficientCount + column);
      table[base] = fourier[0]![column]!;
      table[base + 1] = fourier[1]![column]!;
      table[base + 2] = fourier[2]![column]!;
    }
    if (model.residualControlCount === 0) continue;
    const spline = periodicBasisSample(5, model.residualControlCount, u, 2);
    for (let residual = 0; residual < model.residualControlCount; residual++) {
      const base = 4 * (station * coefficientCount + fourierCount + residual);
      for (let derivative = 0; derivative <= 2; derivative++) {
        let value = 0;
        for (let active = 0; active < 6; active++) {
          if (spline.indices[active] === residual) value += spline.weights[derivative]![active]!;
        }
        for (let column = 0; column < fourierCount; column++) {
          value -= fourier[derivative]![column]! *
            model.residualProjection[column * model.residualControlCount + residual]!;
        }
        table[base + derivative] = value;
      }
    }
  }
  return table;
}

/** Preserve the represented field while adding Fourier modes or dyadically refining residuals. */
export function remapHybridCoefficients(
  source: HybridPeriodicBasis,
  target: HybridPeriodicBasis,
  coefficients: ArrayLike<number>,
): Float64Array {
  const sourceParts = splitHybridCoefficients(source, coefficients);
  const targetFourierCount = fourierCoefficientCount(target.fourierModes);
  const result = new Float64Array(targetFourierCount + target.residualControlCount);
  result.set(sourceParts.fourier.subarray(0, Math.min(sourceParts.fourier.length, targetFourierCount)));
  if (source.residualControlCount === target.residualControlCount) {
    result.set(sourceParts.residual, targetFourierCount);
  } else if (source.residualControlCount === 0) {
    // Activating the local residual at zero leaves the trajectory unchanged.
  } else if (target.residualControlCount === 2 * source.residualControlCount) {
    result.set(refinePeriodicQuintic(sourceParts.residual), targetFourierCount);
  } else {
    throw new RangeError("residual remapping requires unchanged or dyadically refined knots");
  }
  return result;
}
