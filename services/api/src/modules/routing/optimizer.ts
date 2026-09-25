// Single-vehicle routing with time windows, priorities, service times and breaks.
// Heuristic (construction + 2-opt / relocate local search under a time budget). It returns a good,
// constraint-aware order, NOT a proven optimum — callers must never present it as "最適解保証".
import { haversineKm, type Point } from '../../lib/geo.js';

export interface RouteStopInput {
  id: string;
  location: Point;
  windowStart?: Date;
  windowEnd?: Date;
  serviceMinutes: number;
  priority: 0 | 1 | 2;
}

export interface BreakInput { earliestStart: Date; latestStart: Date; durationMinutes: number }

export interface TravelTimeProvider {
  readonly source: 'estimated' | 'provider';
  /** Minutes and km between two points. */
  leg(a: Point, b: Point): { minutes: number; km: number };
}

/** Straight-line distance × road factor at an assumed urban speed. Always reported as 概算. */
export class EstimatedTravelTime implements TravelTimeProvider {
  readonly source = 'estimated' as const;
  constructor(private readonly speedKmh = 22, private readonly roadFactor = 1.35, private readonly overheadMinutes = 2) {}
  leg(a: Point, b: Point) {
    const km = haversineKm(a, b) * this.roadFactor;
    const minutes = km < 0.05 ? 0 : Math.ceil((km / this.speedKmh) * 60 + this.overheadMinutes);
    return { minutes, km: Math.round(km * 100) / 100 };
  }
}

export interface Leg {
  stopId: string;
  arrivalAt: Date;
  departureAt: Date;
  travelMinutes: number;
  distanceKm: number;
  waitMinutes: number;
  lateMinutes: number;
}
export interface Violation { stopId: string; type: 'time_window_late' | 'break_unplaced' | 'priority_late'; message: string; minutes?: number }
export interface PlacedBreak { startAt: Date; durationMinutes: number; afterStopId: string | null }

export interface RoutePlan {
  orderedStopIds: string[];
  legs: Leg[];
  breaks: PlacedBreak[];
  violations: Violation[];
  estimatedMinutes: number;
  totalDistanceKm: number;
  feasible: boolean;
}

export interface OptimizeInput {
  start: Point;
  end?: Point;
  departureAt: Date;
  stops: RouteStopInput[];
  breaks: BreakInput[];
  travel: TravelTimeProvider;
  timeBudgetMs?: number;
}

const MIN = 60_000;
const fmt = (d: Date) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' }).format(d);

/** Deterministically simulates a route order: travel, breaks (taken as soon as their window opens), waiting and service. */
export function simulate(order: RouteStopInput[], input: Omit<OptimizeInput, 'stops' | 'timeBudgetMs'>): RoutePlan & { cost: number } {
  let t = input.departureAt.getTime();
  let pos = input.start;
  let totalKm = 0;
  const legs: Leg[] = [];
  const violations: Violation[] = [];
  const pending = [...input.breaks].sort((a, b) => a.earliestStart.getTime() - b.earliestStart.getTime());
  const placed: PlacedBreak[] = [];
  let lateSum = 0;
  let priorityCost = 0;
  let prevId: string | null = null;

  const takeBreaksUntil = (limit: number) => {
    while (pending.length && pending[0]!.earliestStart.getTime() <= limit) {
      const b = pending.shift()!;
      const start = Math.max(t, b.earliestStart.getTime());
      placed.push({ startAt: new Date(start), durationMinutes: b.durationMinutes, afterStopId: prevId });
      if (start > b.latestStart.getTime()) {
        violations.push({ stopId: prevId ?? order[0]?.id ?? '', type: 'break_unplaced', message: `休憩を${fmt(b.latestStart)}までに開始できません`, minutes: Math.round((start - b.latestStart.getTime()) / MIN) });
        lateSum += (start - b.latestStart.getTime()) / MIN;
      }
      t = start + b.durationMinutes * MIN;
    }
  };

  for (const s of order) {
    const leg = input.travel.leg(pos, s.location);
    // A break whose window opens before we would arrive is taken before driving on.
    takeBreaksUntil(t + leg.minutes * MIN);
    const arrival = t + leg.minutes * MIN;
    const ws = s.windowStart?.getTime();
    const we = s.windowEnd?.getTime();
    const begin = ws !== undefined && arrival < ws ? ws : arrival;
    const wait = (begin - arrival) / MIN;
    const late = we !== undefined && begin > we ? (begin - we) / MIN : 0;
    if (late > 0) {
      violations.push({ stopId: s.id, type: 'time_window_late', message: `指定時間（〜${fmt(new Date(we!))}）に約${Math.ceil(late)}分遅れる見込みです`, minutes: Math.ceil(late) });
      lateSum += late;
    }
    priorityCost += s.priority * ((begin - input.departureAt.getTime()) / MIN);
    const depart = begin + s.serviceMinutes * MIN;
    legs.push({ stopId: s.id, arrivalAt: new Date(arrival), departureAt: new Date(depart), travelMinutes: leg.minutes, distanceKm: leg.km, waitMinutes: Math.round(wait), lateMinutes: Math.ceil(late) });
    totalKm += leg.km;
    t = depart;
    pos = s.location;
    prevId = s.id;
  }
  if (input.end) {
    const leg = input.travel.leg(pos, input.end);
    t += leg.minutes * MIN;
    totalKm += leg.km;
  }
  // Remaining breaks are placed at the end of the route if their window allows.
  takeBreaksUntil(Number.MAX_SAFE_INTEGER);

  const minutes = (t - input.departureAt.getTime()) / MIN;
  // Lateness dominates; then priority stops earlier; then total time.
  const cost = lateSum * 1000 + priorityCost * 0.5 + minutes;
  return {
    orderedStopIds: order.map((s) => s.id),
    legs,
    breaks: placed,
    violations,
    estimatedMinutes: Math.round(minutes),
    totalDistanceKm: Math.round(totalKm * 100) / 100,
    feasible: violations.length === 0,
    cost,
  };
}

function initialOrder(stops: RouteStopInput[], start: Point, travel: TravelTimeProvider): RouteStopInput[] {
  // Greedy: prefer urgent windows, then higher priority, then nearest.
  const left = [...stops];
  const out: RouteStopInput[] = [];
  let pos = start;
  while (left.length) {
    let best = 0;
    let bestScore = Infinity;
    left.forEach((s, i) => {
      const d = travel.leg(pos, s.location).minutes;
      const urgency = s.windowEnd ? s.windowEnd.getTime() / MIN : Infinity;
      const score = (Number.isFinite(urgency) ? urgency / 60 : 1e6) * 10 + d - s.priority * 30;
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    });
    const [s] = left.splice(best, 1);
    out.push(s!);
    pos = s!.location;
  }
  return out;
}

export function optimize(input: OptimizeInput): RoutePlan {
  const deadline = Date.now() + (input.timeBudgetMs ?? 1500);
  const base = { start: input.start, end: input.end, departureAt: input.departureAt, breaks: input.breaks, travel: input.travel };
  let order = initialOrder(input.stops, input.start, input.travel);
  let best = simulate(order, base);

  // Also try pure nearest-neighbour as an alternative seed.
  const nnSeed: RouteStopInput[] = [];
  {
    const left = [...input.stops];
    let pos = input.start;
    while (left.length) {
      let bi = 0;
      let bd = Infinity;
      left.forEach((s, i) => {
        const d = input.travel.leg(pos, s.location).minutes;
        if (d < bd) { bd = d; bi = i; }
      });
      const [s] = left.splice(bi, 1);
      nnSeed.push(s!);
      pos = s!.location;
    }
  }
  const nn = simulate(nnSeed, base);
  if (nn.cost < best.cost) { best = nn; order = nnSeed; }

  const n = order.length;
  let improved = true;
  while (improved && Date.now() < deadline) {
    improved = false;
    // 2-opt segment reversal
    for (let i = 0; i < n - 1 && Date.now() < deadline; i++) {
      for (let j = i + 1; j < n; j++) {
        const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        const sim = simulate(cand, base);
        if (sim.cost < best.cost - 1e-9) { best = sim; order = cand; improved = true; }
      }
    }
    // Relocate single stop
    for (let i = 0; i < n && Date.now() < deadline; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const cand = [...order];
        const [s] = cand.splice(i, 1);
        cand.splice(j, 0, s!);
        const sim = simulate(cand, base);
        if (sim.cost < best.cost - 1e-9) { best = sim; order = cand; improved = true; }
      }
    }
  }
  const { cost: _cost, ...plan } = best;
  return plan;
}
