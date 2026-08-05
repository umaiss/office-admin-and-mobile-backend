import {
  computeRoute,
  DEFAULT_ACCURACY_THRESHOLD_METERS,
  encodePolyline,
  haversineMeters,
  isTrustworthy,
  partitionByQuality,
  totalDistanceMeters,
} from './distance';

/**
 * These tests use fixed coordinates with distances known in advance, so a
 * regression in the arithmetic fails loudly rather than drifting a report by a
 * few percent unnoticed.
 *
 * The anchor fact: at the equator, 0.001° of latitude ≈ 111 m. One degree of
 * latitude is ~111.19 km anywhere on Earth (latitude lines are evenly spaced),
 * so this holds regardless of longitude.
 */
describe('haversineMeters', () => {
  it('is zero for two identical points (no NaN from float overshoot)', () => {
    const p = { latitude: 24.86, longitude: 67.0 };
    expect(haversineMeters(p, p)).toBe(0);
  });

  it('measures ~111 m for 0.001° of latitude', () => {
    const a = { latitude: 24.86, longitude: 67.0 };
    const b = { latitude: 24.861, longitude: 67.0 };

    const d = haversineMeters(a, b);

    // ~111.19 m; allow a metre of slack for the spherical model.
    expect(d).toBeGreaterThan(110);
    expect(d).toBeLessThan(112);
  });

  it('is symmetric', () => {
    const a = { latitude: 24.86, longitude: 67.0 };
    const b = { latitude: 24.87, longitude: 67.01 };
    expect(haversineMeters(a, b)).toBeCloseTo(haversineMeters(b, a), 6);
  });
});

describe('totalDistanceMeters', () => {
  it('is zero for empty and single-point paths', () => {
    expect(totalDistanceMeters([])).toBe(0);
    expect(totalDistanceMeters([{ latitude: 24.86, longitude: 67.0 }])).toBe(0);
  });

  it('sums consecutive hops', () => {
    // Three points each 0.001° apart in latitude → ~222 m total.
    const points = [
      { latitude: 24.86, longitude: 67.0 },
      { latitude: 24.861, longitude: 67.0 },
      { latitude: 24.862, longitude: 67.0 },
    ];
    const d = totalDistanceMeters(points);
    expect(d).toBeGreaterThan(221);
    expect(d).toBeLessThan(224);
  });
});

describe('isTrustworthy / noise filter', () => {
  it('keeps a clean point', () => {
    expect(
      isTrustworthy({ latitude: 0, longitude: 0, accuracyMeters: 8 }),
    ).toBe(true);
  });

  it('drops points with accuracy worse than the threshold', () => {
    expect(
      isTrustworthy({
        latitude: 0,
        longitude: 0,
        accuracyMeters: DEFAULT_ACCURACY_THRESHOLD_METERS + 1,
      }),
    ).toBe(false);
  });

  it('drops points the device reports as stationary', () => {
    expect(
      isTrustworthy({
        latitude: 0,
        longitude: 0,
        accuracyMeters: 5,
        isMoving: false,
      }),
    ).toBe(false);
  });

  it('keeps points with unknown accuracy or unknown motion', () => {
    // null/undefined is "we don't know", not "bad" — err toward keeping data.
    expect(
      isTrustworthy({ latitude: 0, longitude: 0, accuracyMeters: null }),
    ).toBe(true);
    expect(isTrustworthy({ latitude: 0, longitude: 0, isMoving: null })).toBe(
      true,
    );
  });

  it('partitions preserving input order among survivors', () => {
    const points = [
      { latitude: 1, longitude: 0, accuracyMeters: 5 }, // keep
      { latitude: 2, longitude: 0, accuracyMeters: 500 }, // drop (accuracy)
      { latitude: 3, longitude: 0, isMoving: false }, // drop (stationary)
      { latitude: 4, longitude: 0, accuracyMeters: 10 }, // keep
    ];

    const { kept, filtered } = partitionByQuality(points);

    expect(kept.map((p) => p.latitude)).toEqual([1, 4]);
    expect(filtered.map((p) => p.latitude)).toEqual([2, 3]);
  });
});

describe('encodePolyline', () => {
  it('matches the reference example from the Google spec', () => {
    // The canonical worked example from Google's polyline algorithm docs.
    const points = [
      { latitude: 38.5, longitude: -120.2 },
      { latitude: 40.7, longitude: -120.95 },
      { latitude: 43.252, longitude: -126.453 },
    ];
    expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@');
  });

  it('encodes an empty path as an empty string', () => {
    expect(encodePolyline([])).toBe('');
  });
});

describe('computeRoute', () => {
  it('filters noise, then measures only the survivors', () => {
    const raw = [
      { latitude: 24.86, longitude: 67.0, accuracyMeters: 8 },
      { latitude: 24.999, longitude: 67.0, accuracyMeters: 999 }, // noise spike
      { latitude: 24.861, longitude: 67.0, accuracyMeters: 8 },
    ];

    const result = computeRoute(raw);

    expect(result.rawPointCount).toBe(3);
    expect(result.pointCount).toBe(2);
    expect(result.filtered).toHaveLength(1);
    // Distance is the ~111 m between the two clean points, NOT the huge jump to
    // the noise spike and back.
    expect(result.distanceMeters).toBeGreaterThan(110);
    expect(result.distanceMeters).toBeLessThan(112);
    expect(result.encodedPolyline.length).toBeGreaterThan(0);
  });

  it('produces zero distance and empty polyline when nothing survives', () => {
    const raw = [
      { latitude: 24.86, longitude: 67.0, isMoving: false },
      { latitude: 24.861, longitude: 67.0, accuracyMeters: 5000 },
    ];

    const result = computeRoute(raw);

    expect(result.pointCount).toBe(0);
    expect(result.distanceMeters).toBe(0);
    expect(result.encodedPolyline).toBe('');
    expect(result.rawPointCount).toBe(2);
  });
});
