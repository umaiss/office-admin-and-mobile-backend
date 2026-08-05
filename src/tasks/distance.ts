// ============================================================================
//  Pure geo helpers: noise filtering, distance, and polyline encoding.
// ============================================================================
//  Everything in this file is a PURE function of its inputs — no database, no
//  clock, no config service. That is deliberate. Distance calculation is the
//  one piece of the tasks module with real arithmetic in it, and arithmetic is
//  exactly what unit tests are good at: fixed coordinates in, a known number
//  out. Keeping it here, away from Prisma and Nest, means those tests need no
//  mocks and run in milliseconds.
//
//  Units live in names throughout, matching the schema convention:
//  `distanceMeters`, never `distance`.
// ============================================================================

/**
 * The minimum shape a point needs to take part in distance/route computation.
 *
 * It is intentionally a plain interface rather than the Prisma `TaskLocation`
 * type: this file must not depend on the generated client, and the computation
 * only ever reads these fields. A test can build one by hand in a line.
 */
export interface GeoPoint {
  latitude: number;
  longitude: number;
  /** Radius of uncertainty in metres. Higher is worse. Null = unknown. */
  accuracyMeters?: number | null;
  /** OS-reported motion state. `false` means the device says it is stationary. */
  isMoving?: boolean | null;
}

/**
 * Tuning constants for the noise filter.
 *
 * These live as named constants rather than magic numbers so the thresholds
 * are documented in one place and can be lifted into config later without
 * hunting through the arithmetic. The values are the ones the build guide
 * settled on and are conservative — a consumer GPS fix is typically accurate to
 * 5–20 m outdoors, so 50 m cleanly separates "a real position" from "the phone
 * is guessing".
 */
export const DEFAULT_ACCURACY_THRESHOLD_METERS = 50;

/** Mean Earth radius in metres (WGS-84 mean). Used by the haversine formula. */
const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Great-circle distance between two points, in metres, via the haversine
 * formula.
 *
 * Why not plain Pythagoras on the lat/lng differences? Because a degree of
 * longitude is not a fixed distance: it is ~111 km at the equator and shrinks
 * to zero at the poles as the meridians converge. Treating lat/lng as a flat
 * grid overstates east–west distance everywhere except the equator. Haversine
 * models the Earth as a sphere and is accurate to well under a metre over the
 * short hops between consecutive GPS samples.
 */
export function haversineMeters(a: GeoPoint, b: GeoPoint): number {
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);

  const sinLat = Math.sin(deltaLat / 2);
  const sinLon = Math.sin(deltaLon / 2);

  const h = sinLat * sinLat + Math.cos(lat1) * Math.cos(lat2) * sinLon * sinLon;

  // clamp guards against tiny floating-point overshoots pushing the argument
  // of asin above 1, which would yield NaN for two identical points.
  const c = 2 * Math.asin(Math.min(1, Math.sqrt(h)));

  return EARTH_RADIUS_METERS * c;
}

/**
 * Decides whether a single reading is trustworthy enough to count toward
 * distance.
 *
 * Two independent signals reject a point:
 *   • Accuracy worse than the threshold — a reading of "somewhere within 200 m"
 *     tells us almost nothing about how far the office boy actually moved.
 *   • `isMoving === false` — the OS is telling us the device is stationary, so
 *     any change in its coordinates is GPS drift, not travel. Note the strict
 *     `=== false`: a null/undefined `isMoving` is "unknown", not "stationary",
 *     and is kept.
 *
 * Returns true when the point should be KEPT.
 */
export function isTrustworthy(
  point: GeoPoint,
  accuracyThresholdMeters: number = DEFAULT_ACCURACY_THRESHOLD_METERS,
): boolean {
  if (point.isMoving === false) {
    return false;
  }

  if (
    point.accuracyMeters !== null &&
    point.accuracyMeters !== undefined &&
    point.accuracyMeters > accuracyThresholdMeters
  ) {
    return false;
  }

  return true;
}

/**
 * Splits an ordered list of points into the ones that survive the noise filter
 * and the ones that don't.
 *
 * The caller passes points already ordered by `recordedAt` (the
 * `@@index([taskId, recordedAt])` makes that ordering cheap). Order is
 * preserved in `kept`, because distance is summed between *consecutive*
 * survivors — reordering would invent or erase travel.
 */
export function partitionByQuality<T extends GeoPoint>(
  points: T[],
  accuracyThresholdMeters: number = DEFAULT_ACCURACY_THRESHOLD_METERS,
): { kept: T[]; filtered: T[] } {
  const kept: T[] = [];
  const filtered: T[] = [];

  for (const point of points) {
    if (isTrustworthy(point, accuracyThresholdMeters)) {
      kept.push(point);
    } else {
      filtered.push(point);
    }
  }

  return { kept, filtered };
}

/**
 * Total distance along an ordered path, in metres.
 *
 * Zero for an empty path or a single point — you cannot travel a distance
 * without at least two positions.
 */
export function totalDistanceMeters(orderedPoints: GeoPoint[]): number {
  let total = 0;

  for (let i = 1; i < orderedPoints.length; i++) {
    total += haversineMeters(orderedPoints[i - 1], orderedPoints[i]);
  }

  return total;
}

// ----------------------------------------------------------------------------
//  Google encoded polyline
// ----------------------------------------------------------------------------

/**
 * Encodes one signed coordinate component into the polyline alphabet.
 *
 * The algorithm (Google's "Encoded Polyline Algorithm Format"): take the value
 * at 1e5 fixed-point precision, left-shift by one bit, invert all bits if it
 * was negative, then emit it 5 bits at a time from the least-significant end,
 * each 5-bit chunk OR'd with 0x20 while more chunks follow, finally offset by
 * 63 into printable ASCII.
 */
function encodeSignedNumber(value: number): string {
  let sgnNum = value << 1;
  if (value < 0) {
    sgnNum = ~sgnNum;
  }

  let output = '';
  while (sgnNum >= 0x20) {
    output += String.fromCharCode((0x20 | (sgnNum & 0x1f)) + 63);
    sgnNum >>= 5;
  }
  output += String.fromCharCode(sgnNum + 63);
  return output;
}

/**
 * Encodes an ordered list of points into a Google-style encoded polyline.
 *
 * The format stores each point as a *delta* from the previous one, which is why
 * it is so compact: consecutive GPS fixes differ only in their last few decimal
 * places, so the deltas are tiny and encode to one or two characters. A
 * 2,000-point route is ~12 KB encoded versus ~90 KB as raw JSON coordinates —
 * the difference between a map that loads instantly on mobile data and one that
 * stalls. The decoder on the client (every mapping SDK ships one) reverses it
 * exactly.
 */
export function encodePolyline(points: GeoPoint[]): string {
  let lastLat = 0;
  let lastLng = 0;
  let result = '';

  for (const point of points) {
    // Round to 1e5 fixed-point (≈1 m precision) before differencing, so the
    // deltas are integers as the format requires.
    const lat = Math.round(point.latitude * 1e5);
    const lng = Math.round(point.longitude * 1e5);

    result += encodeSignedNumber(lat - lastLat);
    result += encodeSignedNumber(lng - lastLng);

    lastLat = lat;
    lastLng = lng;
  }

  return result;
}

// ----------------------------------------------------------------------------
//  Orchestration
// ----------------------------------------------------------------------------

/** The numeric summary of computing a route from a task's raw location history. */
export interface RouteComputation {
  /** Sum of haversine hops between surviving points, in metres. */
  distanceMeters: number;
  /** Google encoded polyline of the surviving points. */
  encodedPolyline: string;
  /** Points that survived the noise filter. */
  pointCount: number;
  /** Points that were fed in, before filtering. */
  rawPointCount: number;
}

/**
 * The single entry point the service calls: takes the raw, time-ordered
 * location history and produces everything the `end` transaction needs to
 * persist — distance, polyline, counts, and which points were kept vs filtered.
 *
 * Keeping the whole pipeline here (filter → distance → encode) means the
 * service never re-implements any of it, and the recompute path for late points
 * runs the exact same code as the first computation.
 *
 * The `kept` and `filtered` arrays keep the caller's own element type (so a
 * caller that passed points carrying a database `id` gets that `id` back),
 * which is why they live on the generic return rather than on `RouteComputation`.
 */
export function computeRoute<T extends GeoPoint>(
  orderedRawPoints: T[],
  accuracyThresholdMeters: number = DEFAULT_ACCURACY_THRESHOLD_METERS,
): RouteComputation & { kept: T[]; filtered: T[] } {
  const { kept, filtered } = partitionByQuality(
    orderedRawPoints,
    accuracyThresholdMeters,
  );

  return {
    distanceMeters: totalDistanceMeters(kept),
    encodedPolyline: encodePolyline(kept),
    pointCount: kept.length,
    rawPointCount: orderedRawPoints.length,
    kept,
    filtered,
  };
}
