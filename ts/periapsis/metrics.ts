// Wraps periapsis:component/metrics@0.1.0. See identity.ts's header comment
// for why this is its own module rather than folded into one big component.ts.

import { incrementCounter, recordGauge, recordHistogram } from "periapsis:component/metrics@0.1.0";

const NO_LABELS = { values: [] as { key: string; value: string }[] };

function labels(o?: Record<string, string>): { values: { key: string; value: string }[] } {
  return o ? { values: Object.entries(o).map(([key, value]) => ({ key, value })) } : NO_LABELS;
}

/** Increment a counter metric, optionally labeled. */
export function counter(name: string, by: number = 1, labelValues?: Record<string, string>): void {
  incrementCounter(name, by, labels(labelValues));
}

/** Record a gauge metric, optionally labeled. */
export function gauge(name: string, value: number, labelValues?: Record<string, string>): void {
  recordGauge(name, value, labels(labelValues));
}

/** Record a histogram observation, optionally labeled. */
export function histogram(name: string, value: number, labelValues?: Record<string, string>): void {
  recordHistogram(name, value, labels(labelValues));
}
