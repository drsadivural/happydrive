// DEL-02 (unit): optimizer respects time windows, priorities and breaks; scales to 200 stops.
import { describe, expect, it } from 'vitest';
import { EstimatedTravelTime, optimize, simulate, type RouteStopInput } from '../src/modules/routing/optimizer.js';

const base = { latitude: 35.4437, longitude: 139.638 };
const at = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 1, h - 9, m));
const travel = new EstimatedTravelTime();

function grid(n: number, seed = 1): RouteStopInput[] {
  let x = seed;
  const rnd = () => ((x = (x * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    location: { latitude: base.latitude + (rnd() - 0.5) * 0.08, longitude: base.longitude + (rnd() - 0.5) * 0.1 },
    serviceMinutes: 3,
    priority: 0 as const,
  }));
}

describe('route optimizer', () => {
  it('visits every stop exactly once and beats the input order on distance', () => {
    const stops = grid(25);
    const plan = optimize({ start: base, departureAt: at(9), stops, breaks: [], travel });
    expect(new Set(plan.orderedStopIds).size).toBe(25);
    expect(plan.orderedStopIds.sort()).toEqual(stops.map((s) => s.id).sort());
    const naive = simulate(stops, { start: base, departureAt: at(9), breaks: [], travel });
    expect(plan.totalDistanceKm).toBeLessThan(naive.totalDistanceKm);
    expect(plan.feasible).toBe(true);
  });

  it('satisfies feasible time windows even when geometry suggests another order', () => {
    const stops: RouteStopInput[] = [
      { id: 'near-late', location: { latitude: 35.444, longitude: 139.639 }, windowStart: at(11), windowEnd: at(11, 30), serviceMinutes: 5, priority: 0 },
      { id: 'far-early', location: { latitude: 35.47, longitude: 139.62 }, windowStart: at(9), windowEnd: at(9, 45), serviceMinutes: 5, priority: 0 },
      { id: 'mid', location: { latitude: 35.455, longitude: 139.63 }, serviceMinutes: 5, priority: 0 },
    ];
    const plan = optimize({ start: base, departureAt: at(9), stops, breaks: [], travel });
    expect(plan.feasible).toBe(true);
    expect(plan.orderedStopIds[0]).toBe('far-early');
    const late = plan.legs.find((l) => l.stopId === 'near-late')!;
    expect(late.arrivalAt.getTime() + late.waitMinutes * 60_000).toBeGreaterThanOrEqual(at(11).getTime());
  });

  it('reports infeasibility with reasons instead of hiding it', () => {
    const stops: RouteStopInput[] = [
      { id: 'a', location: { latitude: 35.6, longitude: 139.7 }, windowStart: at(9), windowEnd: at(9, 5), serviceMinutes: 3, priority: 0 },
      { id: 'b', location: { latitude: 35.3, longitude: 139.5 }, windowStart: at(9), windowEnd: at(9, 10), serviceMinutes: 3, priority: 0 },
    ];
    const plan = optimize({ start: base, departureAt: at(9), stops, breaks: [], travel });
    expect(plan.feasible).toBe(false);
    expect(plan.violations.length).toBeGreaterThan(0);
    expect(plan.violations[0]!.message).toMatch(/遅れる見込み/);
  });

  it('prefers high-priority stops earlier when cost is otherwise similar', () => {
    const stops = grid(12, 7);
    stops[11] = { ...stops[11]!, priority: 2 };
    const plan = optimize({ start: base, departureAt: at(9), stops, breaks: [], travel });
    expect(plan.orderedStopIds.indexOf('s11')).toBeLessThan(6);
  });

  it('places a break inside its window', () => {
    const stops = grid(20, 3);
    const plan = optimize({ start: base, departureAt: at(9), stops, breaks: [{ earliestStart: at(10), latestStart: at(11), durationMinutes: 30 }], travel });
    expect(plan.breaks).toHaveLength(1);
    const b = plan.breaks[0]!;
    expect(b.startAt.getTime()).toBeGreaterThanOrEqual(at(10).getTime());
    expect(b.startAt.getTime()).toBeLessThanOrEqual(at(11).getTime());
  });

  it('handles 200 stops within the time budget', () => {
    const t0 = Date.now();
    const plan = optimize({ start: base, departureAt: at(8), stops: grid(200, 11), breaks: [], travel, timeBudgetMs: 1500 });
    expect(plan.orderedStopIds).toHaveLength(200);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});
