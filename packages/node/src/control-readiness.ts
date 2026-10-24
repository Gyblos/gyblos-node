// Observes actual inference activity without probing the engine when control queries inspect readiness.
// Caller supplies the already established warm-residency deadline.
import type { QuoteReadiness } from '@gyblos/core/control-quotes';
import type { Engine } from '@gyblos/protocol/engine';

export function observeControlReadiness(
  engine: Engine,
  validUntil: number,
  now: () => number = Date.now,
) {
  const observedAt = now();
  let active = 0;
  let generation = 1;
  const observed: Engine = {
    describe: () => engine.describe(),
    capabilities: () => engine.capabilities(),
    async generate(input) {
      active++;
      generation++;
      try {
        return await engine.generate(input);
      } finally {
        active--;
        generation++;
      }
    },
  };
  const readiness = (): QuoteReadiness => ({
    generation,
    busy: active > 0,
    observedAt,
    validUntil,
  });
  return { engine: observed, readiness };
}
