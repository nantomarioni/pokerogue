import { Button } from "#enums/buttons";
import { MoveId } from "#enums/move-id";
import { SpeciesId } from "#enums/species-id";
import { UiMode } from "#enums/ui-mode";
import type { SelectModifierPhase } from "#phases/select-modifier-phase";
import { rewardOracle } from "#system/reward-oracle";
import { buildWantedCatalog, getWantedItemKey, wantedItems } from "#system/wanted-items";
import { GameManager } from "#test/framework/game-manager";
import { BaseOptionSelectUiHandler } from "#ui/base-option-select-ui-handler";
import { MenuUiHandler } from "#ui/menu-ui-handler";
import Phaser from "phaser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

describe("Reward oracle", () => {
  let phaserGame: Phaser.Game;
  let game: GameManager;

  beforeAll(() => {
    phaserGame = new Phaser.Game({ type: Phaser.HEADLESS });
  });

  beforeEach(() => {
    game = new GameManager(phaserGame);
    // Wanted list is persisted; make each test start clean
    localStorage.clear();
    wantedItems.invalidate();
    rewardOracle.clear();
    game.override
      .battleStyle("single")
      .startingLevel(100)
      .enemyLevel(1)
      .disableTrainerWaves()
      .moveset([MoveId.TACKLE])
      .enemyMoveset(MoveId.SPLASH)
      .enemySpecies(SpeciesId.MAGIKARP);
  });

  /** Kill the wave and stop at the reward screen. */
  async function reachRewardScreen(): Promise<SelectModifierPhase> {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);
    game.move.select(MoveId.TACKLE);
    await game.doKillOpponents();
    await game.phaseInterceptor.to("SelectModifierPhase");
    return game.scene.phaseManager.getCurrentPhase() as SelectModifierPhase;
  }

  function currentOptionKeys(phase: SelectModifierPhase): string[] {
    return phase["typeOptions"].map(o => getWantedItemKey(o.type));
  }

  it("should predict unlocked and locked reroll outcomes exactly", async () => {
    const phase = await reachRewardScreen();

    game.scene.money = 2000;
    wantedItems.toggle("__SENTINEL_NEVER_FOUND__"); // force a full search
    const start = performance.now();
    phase["recomputeRewardOracle"]();
    const elapsed = performance.now() - start;
    console.log(`oracle recompute: ${Math.round(elapsed)}ms, ${rewardOracle.result?.trace.length} rolls simulated`);

    const trace = rewardOracle.result!.trace;
    const predictedUnlocked = trace.find(t => t.lockPath.length === 1 && !t.lockPath[0])!;
    const predictedThenLocked = trace.find(t => t.lockPath.length === 2 && !t.lockPath[0] && t.lockPath[1])!;
    expect(predictedUnlocked).toBeDefined();
    expect(predictedThenLocked).toBeDefined();

    // Actually reroll (unlocked): reality must match the prediction option-for-option
    expect(phase["rerollModifiers"]()).toBe(true);
    await game.phaseInterceptor.to("SelectModifierPhase");
    const rolled = game.scene.phaseManager.getCurrentPhase() as SelectModifierPhase;
    expect(currentOptionKeys(rolled)).toEqual(predictedUnlocked.optionKeys);

    // Lock rarities and reroll again: still matching the original prediction
    rolled["toggleRerollLock"]();
    expect(game.scene.lockModifierTiers).toBe(true);
    expect(rolled["rerollModifiers"]()).toBe(true);
    await game.phaseInterceptor.to("SelectModifierPhase");
    const lockedRolled = game.scene.phaseManager.getCurrentPhase() as SelectModifierPhase;
    expect(currentOptionKeys(lockedRolled)).toEqual(predictedThenLocked.optionKeys);
  }, 30000);

  it("should leave the live RNG state, money and options untouched", async () => {
    const phase = await reachRewardScreen();

    game.scene.money = 1500;
    wantedItems.toggle("__SENTINEL_NEVER_FOUND__");

    const rngBefore = Phaser.Math.RND.state();
    const moneyBefore = game.scene.money;
    const optionsBefore = currentOptionKeys(phase);

    phase["recomputeRewardOracle"]();

    expect(Phaser.Math.RND.state()).toBe(rngBefore);
    expect(game.scene.money).toBe(moneyBefore);
    expect(currentOptionKeys(phase)).toEqual(optionsBefore);
    expect(rewardOracle.result?.trace.length).toBeGreaterThan(0);
  }, 30000);

  it("should find free hits on the current screen and priced hits in the shop row", async () => {
    const phase = await reachRewardScreen();
    game.scene.money = 100000;

    // Something visible right now -> free
    const hereKey = currentOptionKeys(phase)[0];
    wantedItems.toggle(hereKey);
    // The wave-1 shop row always carries a Potion
    wantedItems.toggle("POTION");

    phase["recomputeRewardOracle"]();
    const paths = rewardOracle.result!.paths;

    const herePath = paths.get(hereKey)!;
    expect(herePath).not.toBeNull();
    expect(herePath.kind).toBe("current");
    expect(herePath.totalCost).toBe(0);

    const potionPath = paths.get("POTION")!;
    expect(potionPath).not.toBeNull();
    expect(["shop", "current", "reroll"]).toContain(potionPath.kind);
  }, 30000);

  it("should prune the search by the money budget", async () => {
    const phase = await reachRewardScreen();

    game.scene.money = 0;
    wantedItems.toggle("__SENTINEL_NEVER_FOUND__");
    phase["recomputeRewardOracle"]();

    const result = rewardOracle.result!;
    expect(result.trace).toHaveLength(0); // no reroll is affordable
    expect(result.truncated).toBe(false);
    expect(result.paths.get("__SENTINEL_NEVER_FOUND__")).toBeNull();
  }, 30000);

  it("should navigate the wanted-items checklist UI without freezing", async () => {
    await game.classicMode.startBattle(SpeciesId.FEEBAS);
    const ui = game.scene.ui;
    const menuHandler = ui.handlers.find(h => h instanceof MenuUiHandler) as MenuUiHandler;

    // Enter through the REAL Manage Data submenu (its first entry is Wanted Items):
    // chained configs reuse the handler, so every hop must survive the post-select clear()
    menuHandler.render(); // builds manageDataConfig (normally runs when the menu opens)
    await ui.setOverlayMode(UiMode.MENU_OPTION_SELECT, menuHandler["manageDataConfig"]);
    let handler = ui.getHandler() as BaseOptionSelectUiHandler;
    expect(handler).toBeInstanceOf(BaseOptionSelectUiHandler);
    handler.setCursor(0);
    handler.processInput(Button.ACTION);

    // The category list must now be live and accepting input
    handler = ui.getHandler() as BaseOptionSelectUiHandler;
    expect(ui.getMode()).toBe(UiMode.MENU_OPTION_SELECT);
    expect(handler["config"]).not.toBeNull();
    const categoryCount = handler["config"]!.options.length;
    expect(categoryCount).toBeGreaterThan(5);
    // Every window must fit the screen: bottom-anchored above the message box
    expect(handler["getWindowHeight"]()).toBeLessThanOrEqual(game.scene.scaledCanvas.height - 48);

    // Scroll through the whole category list and back (crosses the scroll window edges)
    for (let i = 0; i < categoryCount + 5; i++) {
      handler.processInput(Button.DOWN);
    }
    for (let i = 0; i < categoryCount + 5; i++) {
      handler.processInput(Button.UP);
    }

    // Enter the first category's checklist (pin the cursor: wrap-around may have moved it)
    handler.setCursor(0);
    handler.processInput(Button.ACTION);
    handler = ui.getHandler() as BaseOptionSelectUiHandler;
    const checklistOptions = handler["config"]!.options;
    expect(checklistOptions.length).toBeGreaterThan(1);
    expect(checklistOptions.length).toBeLessThanOrEqual(41); // paginated: no giant text objects
    expect(handler["getWindowHeight"]()).toBeLessThanOrEqual(game.scene.scaledCanvas.height - 48);

    // Toggle the first item on and off; the label must repaint in place
    handler.setCursor(0);
    expect(wantedItems.size).toBe(0);
    handler.processInput(Button.ACTION);
    expect(wantedItems.size).toBe(1);
    expect(checklistOptions[0].label.startsWith("[x]")).toBe(true);
    handler.processInput(Button.ACTION);
    expect(wantedItems.size).toBe(0);
    expect(checklistOptions[0].label.startsWith("[x]")).toBe(false);

    // Scroll deep into the checklist and back out via the Back entry
    for (let i = 0; i < 60; i++) {
      handler.processInput(Button.DOWN);
    }
    expect(ui.getMode()).toBe(UiMode.MENU_OPTION_SELECT);
  }, 30000);

  it("should build a deduplicated catalog with specific TMs and berries", () => {
    const catalog = buildWantedCatalog();
    expect(catalog.length).toBeGreaterThan(100);

    const keys = catalog.map(e => e.key);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate keys
    expect(keys.some(k => k.startsWith("TM:"))).toBe(true);
    expect(keys.some(k => k.startsWith("BERRY:"))).toBe(true);
    expect(catalog.every(e => e.label.length > 0)).toBe(true);

    // Persistence round-trip
    const sample = keys[0];
    expect(wantedItems.has(sample)).toBe(false);
    expect(wantedItems.toggle(sample)).toBe(true);
    wantedItems.invalidate(); // force a reload from localStorage
    expect(wantedItems.has(sample)).toBe(true);
    expect(wantedItems.toggle(sample)).toBe(false);
  });
});
