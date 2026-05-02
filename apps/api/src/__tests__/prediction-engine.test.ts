import { describe, it, expect } from 'vitest';
import { computeTransitions, predictNext, gridCell } from '../services/prediction-engine';

describe('prediction-engine', () => {
  it('gridCell maps lat/lng to a deterministic cell key', () => {
    const c1 = gridCell(48.516, -123.155);
    const c2 = gridCell(48.516, -123.155);
    const c3 = gridCell(48.5161, -123.1551);
    expect(c1).toBe(c2);
    // 1/10000 of a degree shouldn't move cells (5km grid)
    expect(c3).toBe(c1);
    // 0.05° = ~5.5km should move cells
    const c4 = gridCell(48.46, -123.155);
    expect(c4).not.toBe(c1);
  });

  it('computeTransitions builds a normalized transition matrix from sightings', () => {
    const sightings = [
      { observedAt: new Date('2025-05-01T00:00:00Z'), latitude: 48.5, longitude: -123.0 },
      { observedAt: new Date('2025-05-05T00:00:00Z'), latitude: 48.55, longitude: -123.05 },
      { observedAt: new Date('2025-05-09T00:00:00Z'), latitude: 48.5, longitude: -123.0 },
      { observedAt: new Date('2025-05-13T00:00:00Z'), latitude: 48.55, longitude: -123.05 },
    ];
    const matrix = computeTransitions(sightings, 5);
    const fromCell = gridCell(48.5, -123.0);
    expect(matrix[fromCell]).toBeDefined();
    const probs = Object.values(matrix[fromCell]);
    const sum = probs.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it('predictNext returns top-N cells with probabilities', () => {
    const sightings = [
      { observedAt: new Date('2025-05-01T00:00:00Z'), latitude: 48.5, longitude: -123.0 },
      { observedAt: new Date('2025-05-05T00:00:00Z'), latitude: 48.55, longitude: -123.05 },
      { observedAt: new Date('2025-05-09T00:00:00Z'), latitude: 48.5, longitude: -123.0 },
    ];
    const matrix = computeTransitions(sightings, 5);
    const result = predictNext({
      currentCell: gridCell(48.5, -123.0),
      matrix,
      topN: 5,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty('cell');
    expect(result[0]).toHaveProperty('probability');
  });

  it('returns empty for unknown cell', () => {
    const result = predictNext({
      currentCell: 'never-seen',
      matrix: {},
      topN: 5,
    });
    expect(result).toEqual([]);
  });
});
