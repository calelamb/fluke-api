const BBOX = { south: 47.0, west: -124.7, north: 49.5, east: -122.0 };
const CELL_SIZE_DEG = 0.045; // ~5km

interface Sighting {
  observedAt: Date;
  latitude: number;
  longitude: number;
}

export function gridCell(lat: number, lng: number): string {
  const x = Math.floor((lng - BBOX.west) / CELL_SIZE_DEG);
  const y = Math.floor((BBOX.north - lat) / CELL_SIZE_DEG);
  return `${x},${y}`;
}

export function cellToCoord(cell: string): { lat: number; lng: number } {
  const [xs, ys] = cell.split(',');
  const x = parseInt(xs, 10);
  const y = parseInt(ys, 10);
  return {
    lng: BBOX.west + (x + 0.5) * CELL_SIZE_DEG,
    lat: BBOX.north - (y + 0.5) * CELL_SIZE_DEG,
  };
}

/**
 * Build a row-normalized transition matrix from sightings filtered to a
 * target month-of-year. Each row sums to 1.
 */
export function computeTransitions(
  sightings: Sighting[],
  targetMonth: number
): Record<string, Record<string, number>> {
  const matched = sightings.filter(
    (s) => s.observedAt.getUTCMonth() + 1 === targetMonth
  );

  const counts: Record<string, Record<string, number>> = {};

  for (let i = 0; i < matched.length - 1; i++) {
    const a = matched[i];
    const b = matched[i + 1];
    const dt = b.observedAt.getTime() - a.observedAt.getTime();
    if (dt > 30 * 24 * 60 * 60 * 1000) continue; // skip gaps > 30 days

    const fromCell = gridCell(a.latitude, a.longitude);
    const toCell = gridCell(b.latitude, b.longitude);
    counts[fromCell] = counts[fromCell] || {};
    counts[fromCell][toCell] = (counts[fromCell][toCell] || 0) + 1;
  }

  const matrix: Record<string, Record<string, number>> = {};
  for (const [from, to] of Object.entries(counts)) {
    const rowSum = Object.values(to).reduce((a, b) => a + b, 0);
    matrix[from] = {};
    for (const [t, c] of Object.entries(to)) {
      matrix[from][t] = c / rowSum;
    }
  }

  return matrix;
}

export interface PredictionEntry {
  cell: string;
  probability: number;
}

export function predictNext(args: {
  currentCell: string;
  matrix: Record<string, Record<string, number>>;
  topN: number;
}): PredictionEntry[] {
  const row = args.matrix[args.currentCell] ?? {};
  return Object.entries(row)
    .map(([cell, p]) => ({ cell, probability: p }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, args.topN);
}

export function confidenceFor(sampleSize: number): number {
  return Math.min(1.0, sampleSize / 50);
}
