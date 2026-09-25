export interface Point { latitude: number; longitude: number }

const R = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: Point, b: Point): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Coarse public location (~500 m grid) used before acceptance. */
export function coarsen(p: Point): Point {
  const q = 0.005;
  return { latitude: Math.round(p.latitude / q) * q, longitude: Math.round(p.longitude / q) * q };
}

export const toWkt = (p: Point) => `SRID=4326;POINT(${p.longitude} ${p.latitude})`;

/** SQL fragment turning a geography column into {latitude, longitude} JSON-friendly numbers. */
export const pointSql = (col: string) =>
  `CASE WHEN ${col} IS NULL THEN NULL ELSE json_build_object('latitude', ST_Y(${col}::geometry), 'longitude', ST_X(${col}::geometry)) END`;
