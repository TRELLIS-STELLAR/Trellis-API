export interface MetricSample {
  timestamp: string | number | Date;
  value: number;
}

export interface MetricBucket {
  start: string;
  end: string;
  count: number;
  sum: number;
  average: number | null;
  min: number | null;
  max: number | null;
}

/**
 * Builds a deterministic, gap-filled time series for dashboard consumers.
 * Empty buckets are explicit so clients do not mistake missing telemetry for
 * a zero-valued measurement. Samples outside the requested range are ignored.
 */
export function rollupMetrics(
  samples: readonly MetricSample[],
  from: Date,
  to: Date,
  bucketMs: number,
): MetricBucket[] {
  const start = from.getTime();
  const end = to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    throw new RangeError("to must be after from");
  }
  if (!Number.isInteger(bucketMs) || bucketMs <= 0) {
    throw new RangeError("bucketMs must be a positive integer");
  }

  const buckets: MetricBucket[] = [];
  for (let cursor = start; cursor < end; cursor += bucketMs) {
    const bucketEnd = Math.min(cursor + bucketMs, end);
    buckets.push({
      start: new Date(cursor).toISOString(),
      end: new Date(bucketEnd).toISOString(),
      count: 0,
      sum: 0,
      average: null,
      min: null,
      max: null,
    });
  }

  for (const sample of samples) {
    const timestamp = new Date(sample.timestamp).getTime();
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end) continue;
    if (!Number.isFinite(sample.value)) throw new TypeError("metric values must be finite");
    const index = Math.floor((timestamp - start) / bucketMs);
    const bucket = buckets[index];
    bucket.count += 1;
    bucket.sum += sample.value;
    bucket.average = bucket.sum / bucket.count;
    bucket.min = bucket.min === null ? sample.value : Math.min(bucket.min, sample.value);
    bucket.max = bucket.max === null ? sample.value : Math.max(bucket.max, sample.value);
  }

  return buckets;
}
