import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import { savestateManager } from "#system/savestate-manager";

/**
 * Phase to handle actions on a new encounter that must take place after other setup
 * (i.e. queue {@linkcode PostSummonPhase}s)
 */
export class InitEncounterPhase extends Phase {
  public override readonly phaseName = "InitEncounterPhase";

  public override start(): void {
    // Entry effects are already reflected in a savestate snapshot; skip them on restore
    if (!savestateManager.restorePending) {
      for (const pokemon of globalScene.getField(true)) {
        if (pokemon.isEnemy() || pokemon.turnData.summonedThisTurn) {
          globalScene.phaseManager.unshiftNew("PostSummonPhase", pokemon.getBattlerIndex());
        }
      }
    }

    super.end();
  }
}
