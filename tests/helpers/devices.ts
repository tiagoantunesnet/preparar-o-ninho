/** Simulador de PCs para os testes de merge: cada um tem o seu relógio e o que já viu. */
import { makeEvent } from '../../src/core/events';
import { HlcClock } from '../../src/core/hlc';
import { stateFromEvents, type MergeState } from '../../src/core/merge';
import type { Change, EventType, RgEvent } from '../../src/core/types';

export class World {
  /** "Tempo real" partilhado (ms). */
  t = Date.UTC(2026, 9, 1, 9, 0, 0);
  advance(ms: number) {
    this.t += ms;
  }
}

export class SimDevice {
  readonly clock: HlcClock;
  known = new Map<string, RgEvent>();

  constructor(
    readonly id: string,
    readonly world: World,
    /** Desvio do relógio deste PC em relação ao tempo real (ms). */
    readonly skewMs = 0,
    readonly author = `Utilizador ${id}`,
  ) {
    this.clock = new HlcClock(() => this.world.t + this.skewMs);
  }

  now(): Date {
    return new Date(this.world.t + this.skewMs);
  }

  receive(events: Iterable<RgEvent>) {
    for (const e of events) {
      this.known.set(e.id, e);
      this.clock.observe(e.hlc);
    }
  }

  view(): MergeState {
    return stateFromEvents(this.known.values());
  }

  private emit(type: EventType, recordId: string, changes: Record<string, Change>): RgEvent {
    const rec = this.view().records[recordId];
    const ev = makeEvent({
      hlc: this.clock.tick(),
      author: this.author,
      deviceId: this.id,
      recordId,
      type,
      changes,
      baseRev: type === 'create' ? null : (rec?.rev ?? null),
      now: this.now(),
    });
    this.known.set(ev.id, ev);
    return ev;
  }

  create(recordId: string, values: Record<string, string>): RgEvent {
    const changes: Record<string, Change> = {};
    for (const [k, v] of Object.entries(values)) changes[k] = { from: null, to: v };
    return this.emit('create', recordId, changes);
  }

  edit(recordId: string, values: Record<string, string>, type: EventType = 'update'): RgEvent {
    const cur = this.view().records[recordId];
    const changes: Record<string, Change> = {};
    for (const [k, v] of Object.entries(values)) changes[k] = { from: cur?.fields[k]?.value ?? '', to: v };
    return this.emit(type, recordId, changes);
  }
}

/** Embaralhamento determinístico (mulberry32). */
export function shuffled<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
