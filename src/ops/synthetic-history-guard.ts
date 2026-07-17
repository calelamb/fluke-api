export type SyntheticHistoryEnvironment = Readonly<Record<string, string | undefined>>;

export function assertSyntheticHistoryAllowed(env: SyntheticHistoryEnvironment): void {
  if (env.NODE_ENV === 'production') {
    throw new Error('Synthetic historical sightings are disabled in production.');
  }

  if (env.ALLOW_SYNTHETIC_HISTORY !== 'true') {
    throw new Error(
      'Set ALLOW_SYNTHETIC_HISTORY=true to generate synthetic historical sightings.',
    );
  }
}
