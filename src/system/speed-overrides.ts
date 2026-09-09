/**
 * Tiny registry decoupling the fork's temporary game-speed overrides (savestate
 * restore boost, reward-path automation) from the settings module. `settings.ts`
 * must not import those systems directly — they pull in heavy module trees that
 * cycle back into settings.
 */

type SpeedOverrideCanceller = () => void;

const cancellers = new Set<SpeedOverrideCanceller>();

/** Register a canceller that drops (without reverting) a temporary speed override. */
export function registerSpeedOverrideCanceller(canceller: SpeedOverrideCanceller): void {
  cancellers.add(canceller);
}

/**
 * Drop all pending speed overrides. Called when the player explicitly changes the
 * game speed: their choice always wins over any pending revert.
 */
export function dropAllSpeedOverrides(): void {
  for (const cancel of cancellers) {
    cancel();
  }
}
