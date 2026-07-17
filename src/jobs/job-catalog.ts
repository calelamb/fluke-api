const JOB_DEFINITIONS = Object.freeze({
  acartia: Object.freeze({
    jobName: 'acartia-ingest',
    name: 'acartia',
    timeoutMs: 2 * 60_000,
  }),
  gbif: Object.freeze({
    jobName: 'gbif-ingest',
    name: 'gbif',
    timeoutMs: 15 * 60_000,
  }),
  predictions: Object.freeze({
    jobName: 'prediction-compute',
    name: 'predictions',
    timeoutMs: 10 * 60_000,
  }),
});

export type ScheduledJobName = keyof typeof JOB_DEFINITIONS;
export type JobDefinition = (typeof JOB_DEFINITIONS)[ScheduledJobName];

export function jobDefinition(value: string | undefined): JobDefinition {
  if (value === 'acartia' || value === 'gbif' || value === 'predictions') {
    return JOB_DEFINITIONS[value];
  }
  throw new Error('Unknown scheduled job; expected acartia, gbif, or predictions');
}
