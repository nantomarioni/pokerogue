import { AbilityId } from "#enums/ability-id";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { Stat } from "#enums/stat";
import { UiMode } from "#enums/ui-mode";
import type { SelectModifierPhase } from "#phases/select-modifier-phase";
import { getSavestateLocalStorageKey, savestateManager } from "#system/savestate-manager";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Savestates", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({
      type: Phaser.HEADLESS,
    });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    savestateManager.clear();
    game.override
      .battleStyle("single")
      .startingLevel(100)
      .enemyLevel(100) // Tackle must chip, not one-shot, so battles span multiple turns
      .disableTrainerWaves()
      .moveset([MoveId.SPLASH, MoveId.TACKLE])
      .enemyMoveset(MoveId.SPLASH)
      .enemySpecies(SpeciesId.MAGIKARP);
  });

  /** Trigger a savestate load and run the restore pipeline to the next input boundary. */
  async function loadAndResume(loadFn: () => boolean, target: "CommandPhase" | "SelectModifierPhase") {
    expect(loadFn()).toBe(true);
    await game.phaseInterceptor.to(target);
  }

  it("should auto-capture a snapshot at each turn boundary", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    expect(savestateManager.states).toHaveLength(1);
    expect(savestateManager.states[0].kind).toBe("turn");
    expect(savestateManager.states[0].battle.turn).toBe(1);

    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();

    expect(savestateManager.states).toHaveLength(2);
    expect(savestateManager.states[1].battle.turn).toBe(2);
    expect(savestateManager.cursorIndex).toBe(1);
  });

  it("should restore the current turn with identical RNG state and battle state", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();

    const preLoadRngState = Phaser.Math.RND.state();
    const preLoadBattleSeed = game.scene.currentBattle.battleSeed;
    const preLoadEnemyHp = game.scene.getEnemyPokemon()!.hp;

    await loadAndResume(() => savestateManager.loadLast(), "CommandPhase");

    expect(Phaser.Math.RND.state()).toBe(preLoadRngState);
    expect(game.scene.currentBattle.turn).toBe(2);
    expect(game.scene.currentBattle.battleSeed).toBe(preLoadBattleSeed);
    expect(game.scene.getEnemyPokemon()!.hp).toBe(preLoadEnemyHp);
    expect(savestateManager.cursorIndex).toBe(1);
    expect(savestateManager.restorePending).toBe(false);
  });

  it("should rewind to a previous turn and step forward again", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    game.move.select(MoveId.TACKLE);
    await game.toNextTurn();
    const enemyHpAfterTurn1 = game.scene.getEnemyPokemon()!.hp;

    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();
    expect(savestateManager.states).toHaveLength(3);

    // Rewind to the start of turn 1: the tackle damage must be undone
    await loadAndResume(() => savestateManager.loadPrevious(), "CommandPhase");
    await loadAndResume(() => savestateManager.loadPrevious(), "CommandPhase");
    expect(game.scene.currentBattle.turn).toBe(1);
    expect(game.scene.getEnemyPokemon()!.hp).toBe(game.scene.getEnemyPokemon()!.getMaxHp());
    expect(savestateManager.cursorIndex).toBe(0);

    // The future still exists: step forward to turn 2 (post-tackle)
    await loadAndResume(() => savestateManager.loadNext(), "CommandPhase");
    expect(game.scene.currentBattle.turn).toBe(2);
    expect(game.scene.getEnemyPokemon()!.hp).toBe(enemyHpAfterTurn1);
    expect(savestateManager.states).toHaveLength(3);

    // At the tip, stepping forward is a no-op
    await loadAndResume(() => savestateManager.loadNext(), "CommandPhase");
    expect(savestateManager.loadNext()).toBe(false);
  });

  it("should not re-apply entry abilities when restoring", async () => {
    game.override.ability(AbilityId.INTIMIDATE);
    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    expect(game.scene.getEnemyPokemon()!.getStatStage(Stat.ATK)).toBe(-1);

    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();

    await loadAndResume(() => savestateManager.loadLast(), "CommandPhase");

    // Intimidate must not double-apply through the restore's summon pipeline
    expect(game.scene.getEnemyPokemon()!.getStatStage(Stat.ATK)).toBe(-1);
  });

  it("should truncate the stale future when playing from a rewound state", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();
    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();
    expect(savestateManager.states).toHaveLength(3);

    // Rewind to turn 1 and play it: old turns 2-3 must die, new turn 2 becomes the tip
    await loadAndResume(() => savestateManager.loadIndex(0), "CommandPhase");
    expect(savestateManager.states).toHaveLength(3);

    game.move.select(MoveId.TACKLE);
    await game.toNextTurn();

    expect(savestateManager.states).toHaveLength(2);
    expect(savestateManager.states[1].battle.turn).toBe(2);
    expect(savestateManager.cursorIndex).toBe(1);
  });

  it("should capture reward-screen rolls and roll back a reroll with identical options", async () => {
    game.override.enemyLevel(1);
    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    game.scene.money = 100000;
    game.move.select(MoveId.TACKLE);
    await game.doKillOpponents();
    await game.phaseInterceptor.to("SelectModifierPhase");

    const rewardStates = savestateManager.states.filter(s => s.kind === "reward");
    expect(rewardStates).toHaveLength(1);
    expect(rewardStates[0].reward?.rerollCount).toBe(0);

    const initialPhase = game.scene.phaseManager.getCurrentPhase() as SelectModifierPhase;
    const initialOptions = initialPhase["typeOptions"].map(o => o.type.id);
    const moneyBeforeReroll = game.scene.money;

    // Reroll: burns money, unshifts a new SelectModifierPhase(rerollCount + 1)
    expect(initialPhase["rerollModifiers"]()).toBe(true);
    await game.phaseInterceptor.to("SelectModifierPhase");

    expect(game.scene.money).toBeLessThan(moneyBeforeReroll);
    expect(savestateManager.states.filter(s => s.kind === "reward")).toHaveLength(2);

    // Roll back the reroll: money refunded, regenerated options identical
    await loadAndResume(() => savestateManager.loadPrevious(), "SelectModifierPhase");

    expect(game.scene.money).toBe(moneyBeforeReroll);
    expect(game.scene.ui.getMode()).toBe(UiMode.MODIFIER_SELECT);
    const restoredPhase = game.scene.phaseManager.getCurrentPhase() as SelectModifierPhase;
    expect(restoredPhase["typeOptions"].map(o => o.type.id)).toEqual(initialOptions);
  });

  it("should persist the manual slot and reject snapshots from another run", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);

    expect(savestateManager.saveManualSlot()).toBe(true);
    const key = getSavestateLocalStorageKey(game.scene.sessionSlotId);
    expect(localStorage.getItem(key)).not.toBeNull();
    expect(savestateManager.peekManualSlot()).not.toBeNull();

    // A snapshot from a different run (seed mismatch) must never load
    const foreign = { ...savestateManager.tip!, seed: "someOtherSeed" };
    expect(savestateManager.isValid(foreign)).toBe(false);

    savestateManager.clearManualSlot();
    expect(localStorage.getItem(key)).toBeFalsy();
  });
});
