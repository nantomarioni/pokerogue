import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { savestateManager } from "#system/savestate-manager";
import { SettingKeys, setSetting } from "#system/settings";
import { GameManager } from "#test/framework/game-manager";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe("Savestate speed boost", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    savestateManager.clear();
    game.override
      .battleStyle("single")
      .startingLevel(100)
      .enemyLevel(100)
      .disableTrainerWaves()
      .moveset([MoveId.SPLASH])
      .enemyMoveset(MoveId.SPLASH)
      .enemySpecies(SpeciesId.MAGIKARP);
  });

  it("should keep the player's Turbo speed after a restore", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);
    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();

    game.scene.gameSpeed = 5;

    expect(savestateManager.loadLast()).toBe(true);
    await game.phaseInterceptor.to("CommandPhase");
    await sleep(1500); // let the revert timer fire

    expect(game.scene.gameSpeed).toBe(5);
  });

  it("should boost during restore and revert to the player's speed", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);
    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();

    game.scene.gameSpeed = 3;

    expect(savestateManager.loadLast()).toBe(true);
    expect(game.scene.gameSpeed).toBe(5); // boosted while restoring
    await game.phaseInterceptor.to("CommandPhase");
    await sleep(1500);

    expect(game.scene.gameSpeed).toBe(3); // reverted to the player's own speed
  });

  it("should keep a speed raised by the player right after a boosted restore", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);
    game.move.select(MoveId.SPLASH);
    await game.toNextTurn();

    game.scene.gameSpeed = 3;

    expect(savestateManager.loadLast()).toBe(true);
    await game.phaseInterceptor.to("CommandPhase");
    // The player switches to Turbo (via the real settings path) while the revert timer is pending
    setSetting(SettingKeys.Game_Speed, 3); // option index 3 = "5" (Turbo)
    expect(game.scene.gameSpeed).toBe(5);
    await sleep(1500);

    expect(game.scene.gameSpeed).toBe(5);
  });
});
