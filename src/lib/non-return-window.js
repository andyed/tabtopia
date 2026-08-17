const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export const NON_RETURN_WINDOW_DEFAULTS = Object.freeze({
  minimumSamples: 80,
  minimumComponentWeight: 0.08,
  minimumLogSeparation: 1.5,
  minimumBoundaryMs: 10 * MINUTE,
  maximumBoundaryMs: 60 * MINUTE,
  minimumGapMs: 2 * 1000,
  maximumGapMs: 30 * DAY,
  fallbackBoundaryMs: 30 * MINUTE
});

/**
 * Estimate the separation between a within-burst return and a later return.
 *
 * The estimator fits two normal components to log inter-access gaps. It emits
 * the point where the two components are equally likely plus the 25%-to-75%
 * posterior transition window. Raw URLs and page identities are not needed.
 */
export function estimateNonReturnWindow(timestamps, config = {}) {
  const options = { ...NON_RETURN_WINDOW_DEFAULTS, ...config };
  const ordered = [...new Set(array(timestamps)
    .map(Number)
    .filter(Number.isFinite))]
    .sort((left, right) => left - right);
  const gaps = [];
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = ordered[index] - ordered[index - 1];
    if (gap >= options.minimumGapMs && gap <= options.maximumGapMs) gaps.push(gap);
  }

  const base = {
    status: "insufficient-data",
    boundaryMs: options.fallbackBoundaryMs,
    source: "fallback",
    sampleCount: gaps.length
  };
  if (gaps.length < options.minimumSamples) return base;

  const fit = fitLogGapMixture(gaps.map(Math.log));
  const [withinBurst, laterReturn] = fit.components;
  const separation = laterReturn.mean - withinBurst.mean;
  if (
    withinBurst.weight < options.minimumComponentWeight
    || laterReturn.weight < options.minimumComponentWeight
    || separation < options.minimumLogSeparation
  ) {
    return { ...base, status: "not-bimodal", separation };
  }

  const boundaryLog = posteriorCrossing(fit.components, 0.5);
  const windowStartLog = posteriorCrossing(fit.components, 0.25);
  const windowEndLog = posteriorCrossing(fit.components, 0.75);
  if (![boundaryLog, windowStartLog, windowEndLog].every(Number.isFinite)) {
    return { ...base, status: "unstable-fit", separation };
  }

  const boundaryMs = Math.exp(boundaryLog);
  if (boundaryMs < options.minimumBoundaryMs || boundaryMs > options.maximumBoundaryMs) {
    return {
      ...base,
      status: "outside-product-range",
      estimatedBoundaryMs: Math.round(boundaryMs),
      separation
    };
  }

  const sampleConfidence = Math.min(1, gaps.length / (options.minimumSamples * 4));
  const separationConfidence = Math.min(1, separation / 3);
  return {
    status: "ready",
    source: "qualified-access-mixture",
    sampleCount: gaps.length,
    boundaryMs: Math.round(boundaryMs),
    windowStartMs: Math.round(Math.exp(Math.min(windowStartLog, windowEndLog))),
    windowEndMs: Math.round(Math.exp(Math.max(windowStartLog, windowEndLog))),
    confidence: round3(sampleConfidence * separationConfidence),
    separation: round3(separation),
    components: {
      withinBurstMedianMs: Math.round(Math.exp(withinBurst.mean)),
      laterReturnMedianMs: Math.round(Math.exp(laterReturn.mean)),
      withinBurstWeight: round3(withinBurst.weight),
      laterReturnWeight: round3(laterReturn.weight)
    }
  };
}

function fitLogGapMixture(values) {
  const sorted = values.slice().sort((left, right) => left - right);
  const spread = Math.max(0.5, standardDeviation(sorted));
  let components = [
    { mean: quantile(sorted, 0.3), variance: spread ** 2, weight: 0.7 },
    { mean: quantile(sorted, 0.8), variance: spread ** 2, weight: 0.3 }
  ];

  for (let iteration = 0; iteration < 80; iteration += 1) {
    const responsibilities = values.map(value => {
      const densities = components.map(component => component.weight * normalDensity(value, component));
      const total = densities[0] + densities[1] || Number.MIN_VALUE;
      return [densities[0] / total, densities[1] / total];
    });
    components = components.map((component, componentIndex) => {
      const mass = responsibilities.reduce((sum, row) => sum + row[componentIndex], 0);
      const mean = values.reduce((sum, value, index) =>
        sum + responsibilities[index][componentIndex] * value, 0) / mass;
      const variance = Math.max(0.0025, values.reduce((sum, value, index) =>
        sum + responsibilities[index][componentIndex] * ((value - mean) ** 2), 0) / mass);
      return { mean, variance, weight: mass / values.length };
    }).sort((left, right) => left.mean - right.mean);
  }
  return { components };
}

function posteriorCrossing(components, target) {
  const [early, late] = components;
  const start = early.mean;
  const end = late.mean;
  const targetOdds = Math.log(target / (1 - target));
  let previousX = start;
  let previousValue = logPosteriorOdds(start, early, late) - targetOdds;
  for (let index = 0; index <= 512; index += 1) {
    const x = start + ((end - start) * index / 512);
    const value = logPosteriorOdds(x, early, late) - targetOdds;
    if (value === 0) return x;
    if (Math.sign(value) !== Math.sign(previousValue)) {
      let lower = previousX;
      let upper = x;
      for (let step = 0; step < 40; step += 1) {
        const midpoint = (lower + upper) / 2;
        const midpointValue = logPosteriorOdds(midpoint, early, late) - targetOdds;
        if (Math.sign(midpointValue) === Math.sign(previousValue)) lower = midpoint;
        else upper = midpoint;
      }
      return (lower + upper) / 2;
    }
    previousX = x;
    previousValue = value;
  }
  return null;
}

function logPosteriorOdds(value, early, late) {
  return Math.log(late.weight / early.weight)
    + (0.5 * Math.log(early.variance / late.variance))
    - (((value - late.mean) ** 2) / (2 * late.variance))
    + (((value - early.mean) ** 2) / (2 * early.variance));
}

function normalDensity(value, component) {
  return Math.exp(-((value - component.mean) ** 2) / (2 * component.variance))
    / Math.sqrt(2 * Math.PI * component.variance);
}

function standardDeviation(values) {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length);
}

function quantile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}
