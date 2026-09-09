import type { FaintLogEntry } from "#app/battle";
import { globalScene } from "#app/global-scene";
import { Phase } from "#app/phase";
import { UiMode } from "#enums/ui-mode";
import { rewardOracle } from "#system/reward-oracle";
import type { Savestate } from "#system/savestate-manager";
import { savestateManager } from "#system/savestate-manager";

/**
 * Rebuilds the scene from a {@linkcode Savestate} without a page reload.
 *
 * Runs in two stages:
 * - `setup`: tears down the live battle, re-initializes the session from the snapshot
 *   (via the same pipeline as a vanilla session load) and queues the follow-up phases
 *   (encounter/summons for turn snapshots, nothing extra for reward snapshots).
 * - `finalize`: runs after the field has been rebuilt; re-applies the mid-wave state that
 *   vanilla saves drop (battle counters, RNG, per-Pokemon transients) and requeues the
 *   reward screen for reward snapshots.
 *
 * While a restore is pending, {@linkcode SummonPhase} / {@linkcode InitEncounterPhase}
 * suppress `PostSummonPhase` queuing so entry effects (already reflected in the snapshot)
 * don't re-apply.
 */
export class SavestateRestorePhase extends Phase {
  public readonly phaseName = "SavestateRestorePhase";

  constructor(
    private readonly state: Savestate,
    private readonly stage: "setup" | "finalize" = "setup",
  ) {
    super();
  }

  public override start(): void {
    super.start();

    if (this.stage === "setup") {
      this.doSetup().catch(err => {
        console.error("Savestate restore failed:", err);
        savestateManager.finishRestore();
        this.end();
      });
    } else {
      this.doFinalize();
      this.end();
    }
  }

  private async doSetup(): Promise<void> {
    const { state } = this;
    const phaseManager = globalScene.phaseManager;

    globalScene.ui.setMode(UiMode.MESSAGE);
    globalScene.ui.resetModeChain();

    // A state load is the sanctioned way to re-enable the reward oracle after a
    // completed auto-path suppressed it
    rewardOracle.unsuppress();

    this.teardownLiveBattle();

    // Deep-copy the stored session so repeated loads never share live objects
    const session = globalScene.gameData.parseSessionData(JSON.stringify(state.session));
    await globalScene.gameData.loadSessionFromData(session);

    if (state.kind === "turn") {
      // Mirror the vanilla loaded-session pipeline (TitlePhase.end), minus CheckSwitchPhase
      phaseManager.pushNew("EncounterPhase", true);
      phaseManager.pushNew("SummonPhase", 0, true, true);
      if (globalScene.currentBattle.double && globalScene.getPokemonAllowedInBattle().length > 1) {
        phaseManager.pushNew("SummonPhase", 1, true, true);
      }
    } else {
      // Reward screen: the battle is already over, so skip the encounter entirely and
      // just re-summon the player's field before reopening the shop in `finalize`
      const availablePartyMembers = globalScene.getPokemonAllowedInBattle().length;
      if (availablePartyMembers > 0) {
        phaseManager.pushNew("SummonPhase", 0, true, true);
      }
      if (globalScene.currentBattle.double && availablePartyMembers > 1) {
        phaseManager.pushNew("SummonPhase", 1, true, true);
      }
    }

    phaseManager.pushPhase(new SavestateRestorePhase(state, "finalize"));

    this.end();
  }

  /** Destroy the live battle objects so the snapshot can be rebuilt from scratch. */
  private teardownLiveBattle(): void {
    const battle = globalScene.currentBattle;

    globalScene.modifiers = [];
    globalScene["enemyModifiers"] = [];
    globalScene["modifierBar"].removeAll(true);
    globalScene["enemyModifierBar"].removeAll(true);

    for (const p of globalScene.getPlayerParty()) {
      globalScene.tweens.killTweensOf(p);
      p.destroy();
    }
    for (const p of globalScene.getEnemyParty()) {
      try {
        globalScene.tweens.killTweensOf(p);
        p.destroy();
      } catch {
        console.warn("Unable to destroy stale enemy pokemon during savestate restore");
      }
    }

    if (battle?.mysteryEncounter?.introVisuals) {
      globalScene.field.remove(battle.mysteryEncounter.introVisuals, true);
    }
    if (battle?.trainer) {
      globalScene.tweens.killTweensOf(battle.trainer);
      battle.trainer.destroy();
    }
  }

  private doFinalize(): void {
    const { state } = this;
    const battle = globalScene.currentBattle;

    // Restore the mid-wave battle state dropped by vanilla saves
    const b = state.battle;
    battle.turn = b.turn;
    battle.battleSeed = b.battleSeed;
    battle["battleSeedState"] = null;
    battle.started = b.started;
    battle.enemySwitchCounter = b.enemySwitchCounter;
    battle.battleScore = b.battleScore;
    battle.escapeAttempts = b.escapeAttempts;
    battle.lastMove = b.lastMove;
    battle.moneyScattered = b.moneyScattered;
    battle.lastEnemyInvolved = b.lastEnemyInvolved;
    battle.lastPlayerInvolved = b.lastPlayerInvolved;
    battle.lastUsedPokeball = b.lastUsedPokeball;
    battle.enemyFaints = b.enemyFaints;
    battle.failedRunAway = b.failedRunAway;
    battle.playerParticipantIds = new Set(b.playerParticipantIds);
    battle.seenEnemyPartyMemberIds = new Set(b.seenEnemyPartyMemberIds);
    battle.playerFaintsHistory = this.reviveFaintHistory(b.playerFaintsHistory);
    battle.enemyFaintsHistory = this.reviveFaintHistory(b.enemyFaintsHistory);

    // Re-apply per-Pokemon transient layers (waveData / tempSummonData) by id
    for (const t of state.pokemonTransients) {
      const pokemon = globalScene.getPokemonById(t.id);
      if (!pokemon) {
        continue;
      }
      pokemon.waveData.endured = t.waveData.endured;
      pokemon.waveData.abilitiesApplied = new Set(t.waveData.abilitiesApplied);
      pokemon.waveData.abilityRevealed = t.waveData.abilityRevealed;
      pokemon.tempSummonData.turnCount = t.tempSummonData.turnCount;
      pokemon.tempSummonData.waveTurnCount = t.tempSummonData.waveTurnCount;
    }

    if (state.kind === "turn") {
      // A mid-wave restore may put a fainted enemy on the field (e.g. doubles); hide it
      for (const enemy of globalScene.getEnemyField()) {
        if (enemy.isFainted()) {
          enemy.leaveField(false);
        }
      }
    } else if (state.reward) {
      // Reproduce the post-victory queue tail: shop -> [biome select] -> next wave.
      // The RNG state restored below makes the regenerated shop options identical.
      globalScene.lockModifierTiers = state.reward.lockModifierTiers;
      globalScene.phaseManager.pushNew("SelectModifierPhase", state.reward.rerollCount, state.reward.modifierTiers);
      if (state.reward.biomeSelectPending) {
        globalScene.phaseManager.pushNew("SelectBiomePhase");
      }
      globalScene.phaseManager.pushNew("NewBattlePhase");
    }

    // Restore the global RNG last so nothing above disturbs it
    Phaser.Math.RND.state(state.rngState);

    savestateManager.finishRestore();
    // For turn snapshots the queue now empties into a fresh TurnInitPhase, which
    // re-syncs the history cursor via its capture hook (same for SelectModifierPhase).
  }

  private reviveFaintHistory(entries: [number, number][]): FaintLogEntry[] {
    const revived: FaintLogEntry[] = [];
    for (const [id, turn] of entries) {
      const pokemon = globalScene.getPokemonById(id);
      if (pokemon) {
        revived.push({ pokemon, turn });
      }
    }
    return revived;
  }
}
