/**
 * Hybrid logical clock.
 *
 * Formato textual: "<ms desde epoch, 15 dígitos>-<contador, 6 dígitos>", p.ex.
 * "001727950000000-000003". Como os campos têm largura fixa, a comparação de
 * strings coincide com a ordem cronológica/lógica.
 *
 * Garantias usadas pelo merge:
 *  - cada `tick()` devolve um valor estritamente maior do que todos os já
 *    emitidos ou observados neste dispositivo (mesmo que o relógio do PC recue);
 *  - depois de `observe(x)`, o próximo `tick()` é > x. Assim, uma alteração feita
 *    depois de ver outra ordena sempre depois dela, mesmo com relógios desacertados.
 */

const MS_WIDTH = 15;
const C_WIDTH = 6;
const C_MAX = 10 ** C_WIDTH - 1;
const HLC_RE = /^(\d{15})-(\d{6})$/;

export interface HlcParts {
  ms: number;
  c: number;
}

export function formatHlc(p: HlcParts): string {
  return String(p.ms).padStart(MS_WIDTH, '0') + '-' + String(p.c).padStart(C_WIDTH, '0');
}

export function parseHlc(s: unknown): HlcParts | null {
  if (typeof s !== 'string') return null;
  const m = HLC_RE.exec(s);
  if (!m) return null;
  return { ms: Number(m[1]), c: Number(m[2]) };
}

export function isHlc(s: unknown): s is string {
  return parseHlc(s) !== null;
}

/** HLC derivado de uma data física (para eventos antigos sem hlc). */
export function hlcFromMs(ms: number, c = 0): string {
  return formatHlc({ ms: Math.max(0, Math.floor(ms)), c });
}

/** O maior hlc estritamente menor do que `s` (usado em migrações). */
export function hlcPredecessor(s: string): string {
  const p = parseHlc(s);
  if (!p) return s;
  if (p.c > 0) return formatHlc({ ms: p.ms, c: p.c - 1 });
  if (p.ms === 0) return formatHlc({ ms: 0, c: 0 });
  return formatHlc({ ms: p.ms - 1, c: C_MAX });
}

export function hlcMs(s: string): number {
  return parseHlc(s)?.ms ?? 0;
}

export function maxHlc(a: string | null | undefined, b: string | null | undefined): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

export class HlcClock {
  private last: HlcParts;

  constructor(
    private readonly now: () => number = () => Date.now(),
    initial?: string | null,
  ) {
    this.last = parseHlc(initial) ?? { ms: 0, c: 0 };
  }

  /** Novo carimbo para um evento local. */
  tick(): string {
    const pt = this.now();
    if (pt > this.last.ms) {
      this.last = { ms: pt, c: 0 };
    } else if (this.last.c < C_MAX) {
      this.last = { ms: this.last.ms, c: this.last.c + 1 };
    } else {
      this.last = { ms: this.last.ms + 1, c: 0 };
    }
    return formatHlc(this.last);
  }

  /** Regista um hlc visto noutro dispositivo. */
  observe(remote: string | null | undefined): void {
    const r = parseHlc(remote);
    if (!r) return;
    if (r.ms > this.last.ms || (r.ms === this.last.ms && r.c > this.last.c)) {
      this.last = r;
    }
  }

  current(): string {
    return formatHlc(this.last);
  }
}
