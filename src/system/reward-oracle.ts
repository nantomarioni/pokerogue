import { globalScene } from "#app/global-scene";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import type { ModifierTier } from "#enums/modifier-tier";
import { HealShopCostModifier } from "#modifiers/modifier";
import {
  getPlayerModifierTypeOptions,
  getPlayerShopModifierTypeOptionsForWave,
  type ModifierTypeOption,
  regenerateModifierPoolThresholds,
} from "#modifiers/modifier-type";
import { registerSpeedOverrideCanceller } from "#system/speed-overrides";
import { getWantedItemKey, wantedItems } from "#system/wanted-items";
import { NumberHolder } from "#utils/common";

/** Reroll cost per tier when rarities are locked (mirrors SelectModifierPhase.getRerollCost). */
const TIER_VALUES: readonly number[] = [50, 125, 300, 750, 2000];
/** Base reroll cost when rarities are unlocked. */
const BASE_REROLL_COST = 250;
/** How many rerolls past the current roll the oracle explores. */
const MAX_EXTRA_ROLLS = 8;
/** Safety cap on simulated nodes (a full depth-8 tree is 2^9 - 2 = 510 nodes). */
const MAX_NODES = 600;
/**
 * Game speed while auto-executing a path. The speed system is a plain duration divisor
 * (`Math.ceil(value / gameSpeed)`), and the whole test suite runs the game with
 * effectively instant animations, so aggressive compression is safe. Reverted when
 * the plan ends.
 */
const AUTOMATION_GAME_SPEED = 20;

/** An in-flight auto-executed reroll path. */
export interface PlannedPath {
  /** Wanted-item key the plan is driving toward */
  targetKey: string;
  /** Localized item name (overlay display) */
  label: string;
  /** Lock choice per remaining reroll */
  lockPath: boolean[];
  /** Next step to execute */
  stepIndex: number;
  /** rerollCount the shop must be at before executing step `stepIndex` (divergence guard) */
  startRerollCount: number;
}

/** A reachable future roll: RNG state at its entry + how we got there. */
interface OracleNode {
  /** Absolute reroll count of this roll */
  rerollCount: number;
  /** Global RNG state string at this roll's entry (i.e. after the parent roll generated) */
  rngState: string;
  /** Tiers of the parent roll's options (input to a locked generation) */
  parentTiers: ModifierTier[];
  /** Money spent on rerolls to reach this roll */
  costSoFar: number;
  /** Lock choice per reroll taken from the current screen (true = locked) */
  lockPath: boolean[];
}

export interface WantedItemPath {
  key: string;
  /** Localized item name */
  label: string;
  /** Where the item is: on the current screen, in the fixed shop row, or after rerolls */
  kind: "current" | "shop" | "reroll";
  /** Total money to get there (reroll costs; for "shop" the purchase price) */
  totalCost: number;
  /** Lock choices for each reroll, in order (empty for current/shop) */
  lockPath: boolean[];
}

export interface OracleResult {
  waveIndex: number;
  rerollCount: number;
  /** One entry per wanted key; null = not found within budget/depth */
  paths: Map<string, WantedItemPath | null>;
  /** True when the search hit the node cap before exhausting the money budget */
  truncated: boolean;
  /** Every simulated roll: lock path, cumulative cost and option identity keys (debug/tests) */
  trace: { lockPath: boolean[]; totalCost: number; optionKeys: string[] }[];
}

/** Compact human-readable path: `R` = reroll (rarities unlocked), `L` = locked reroll. */
export function describeLockPath(lockPath: boolean[]): string {
  return lockPath.map(locked => (locked ? "L" : "R")).join(" > ");
}

/**
 * Precomputes future reward rolls by re-running the game's own generation code with a
 * sandboxed RNG. Locking rarities changes RNG consumption, so each lock on/off choice
 * before a reroll diverges the stream — the search space is a binary tree, explored
 * cheapest-first (uniform-cost) so the first hit per wanted item is the cheapest path.
 *
 * Purely a client-side peek: nothing here mutates live game state (RNG, money and
 * pool thresholds are saved/restored around the simulation).
 */
export class RewardOracle {
  public result: OracleResult | null = null;
  /** Listener notified when a recompute finishes (used by the HUD overlay). */
  public onResults: ((oracle: RewardOracle) => void) | null = null;

  /** The path currently being auto-executed, if any. */
  public plan: PlannedPath | null = null;
  /**
   * Set when a plan completes: the player is about to pick the found item and move on,
   * so the overlay hides and recomputes stop (the common case needs no further searches).
   * Reset by a savestate load, a plan abort, or the shop closing.
   */
  public suppressed = false;
  /** Reverts the automation speed override (null when none is active). */
  private revertAutomationSpeed: (() => void) | null = null;

  /**
   * The wanted items currently reachable via rerolls, cheapest first
   * (the auto-path candidates offered to the player).
   */
  public getPlanCandidates(): WantedItemPath[] {
    if (!this.result) {
      return [];
    }
    return [...this.result.paths.values()]
      .filter((p): p is WantedItemPath => p != null && p.kind === "reroll")
      .sort((a, b) => a.totalCost - b.totalCost);
  }

  /**
   * Begin auto-executing the recorded path for one specific wanted item.
   * The actual steps are driven reactively by {@linkcode SelectModifierPhase.continueAutoPath}
   * each time the shop becomes input-ready.
   * @returns Whether a plan was started
   */
  public startPlanFor(targetKey: string): boolean {
    if (this.plan || !this.result) {
      return false;
    }
    const target = this.getPlanCandidates().find(p => p.key === targetKey);
    if (!target) {
      return false;
    }
    this.plan = {
      targetKey: target.key,
      label: target.label,
      lockPath: [...target.lockPath],
      stepIndex: 0,
      startRerollCount: this.result.rerollCount,
    };
    this.applyAutomationSpeed();
    this.onResults?.(this);
    return true;
  }

  /**
   * Begin auto-executing the cheapest reroll path among the current wanted hits.
   * @returns Whether a plan was started
   */
  public startCheapestPlan(): boolean {
    const cheapest = this.getPlanCandidates()[0];
    return cheapest != null && this.startPlanFor(cheapest.key);
  }

  /** Mark the current plan step executed. */
  public advancePlanStep(): void {
    if (this.plan) {
      this.plan.stepIndex++;
    }
  }

  /**
   * Finish or abort the running plan, reverting the speed override.
   * @param completed - `true` when the plan arrived at its target: hides the overlay
   * and suppresses further recomputes until a savestate load or the shop closes
   */
  public endPlan(completed = false): void {
    if (!this.plan) {
      return;
    }
    this.plan = null;
    this.revertAutomationSpeed?.();
    if (completed) {
      this.suppressed = true;
      this.result = null;
    }
    this.onResults?.(this);
  }

  /** Re-enable recomputes/overlay after a completed plan (savestate loads call this). */
  public unsuppress(): void {
    this.suppressed = false;
  }

  /** Drop the automation speed override without reverting (an explicit player speed change wins). */
  public dropSpeedOverride(): void {
    this.revertAutomationSpeed = null;
  }

  private applyAutomationSpeed(): void {
    if (this.revertAutomationSpeed || globalScene.gameSpeed >= AUTOMATION_GAME_SPEED) {
      return;
    }
    const originalSpeed = globalScene.gameSpeed;
    globalScene.gameSpeed = AUTOMATION_GAME_SPEED;
    this.revertAutomationSpeed = () => {
      if (globalScene.gameSpeed === AUTOMATION_GAME_SPEED) {
        globalScene.gameSpeed = originalSpeed;
      }
      this.revertAutomationSpeed = null;
    };
  }

  /** Reroll cost for one step (mirrors SelectModifierPhase.getRerollCost, sans custom multipliers). */
  private getStepCost(locked: boolean, parentTiers: ModifierTier[], rerollCount: number): number {
    const baseValue = locked
      ? parentTiers.reduce((total, tier) => total + (TIER_VALUES[tier ?? 0] ?? 0), 0)
      : BASE_REROLL_COST;
    const multiplied = Math.min(
      Math.ceil(globalScene.currentBattle.waveIndex / 10) * baseValue * 2 ** rerollCount,
      Number.MAX_SAFE_INTEGER,
    );
    const holder = new NumberHolder(multiplied);
    globalScene.applyModifier(HealShopCostModifier, true, holder);
    return holder.value;
  }

  /**
   * Recompute all wanted-item paths from the current screen.
   * Must be called right after the live roll generated its options (so the live RNG
   * state is exactly the entry state of the next reroll).
   * @param currentOptions - The options shown on the current screen
   * @param currentRerollCount - The current roll's reroll count
   * @param optionCount - How many options a roll generates (ExtraModifierModifier etc.)
   */
  public recompute(currentOptions: ModifierTypeOption[], currentRerollCount: number, optionCount: number): void {
    const wantedKeys = new Set(wantedItems.getAll());
    if (wantedKeys.size === 0) {
      this.result = null;
      this.onResults?.(this);
      return;
    }

    const paths = new Map<string, WantedItemPath | null>();
    for (const key of wantedKeys) {
      paths.set(key, null);
    }
    let remaining = wantedKeys.size;

    const recordHit = (option: ModifierTypeOption, path: Omit<WantedItemPath, "key" | "label">): void => {
      for (const key of [getWantedItemKey(option.type), option.type.id]) {
        if (wantedKeys.has(key) && paths.get(key) === null) {
          paths.set(key, { key, label: option.type.name, ...path });
          remaining--;
        }
      }
    };

    // Hits on the current screen are free
    for (const option of currentOptions) {
      recordHit(option, { kind: "current", totalCost: 0, lockPath: [] });
    }

    // Fixed shop row: pure function of waveIndex + wave money, no RNG involved
    const waveIndex = globalScene.currentBattle.waveIndex;
    const baseShopCost = new NumberHolder(globalScene.getWaveMoneyAmount(1));
    globalScene.applyModifier(HealShopCostModifier, true, baseShopCost);
    for (const shopOption of getPlayerShopModifierTypeOptionsForWave(waveIndex, baseShopCost.value)) {
      // Shop types are fresh registry instances that never get `.id` assigned; their
      // locale key suffix equals the registry key (e.g. "...ModifierType.POTION")
      shopOption.type.id ??= shopOption.type.localeKey?.split(".").at(-1) ?? "";
      if (shopOption.cost <= globalScene.money) {
        recordHit(shopOption, { kind: "shop", totalCost: shopOption.cost, lockPath: [] });
      }
    }

    let truncated = false;
    const trace: OracleResult["trace"] = [];

    if (remaining > 0) {
      truncated = this.searchRerollTree(
        currentOptions,
        currentRerollCount,
        optionCount,
        recordHit,
        () => remaining <= 0,
        trace,
      );
    }

    this.result = { waveIndex, rerollCount: currentRerollCount, paths, truncated, trace };
    this.onResults?.(this);
  }

  /** Drop stale results (called when a new encounter starts and the shop is gone). */
  public clear(): void {
    this.endPlan();
    this.suppressed = false;
    if (this.result == null) {
      return;
    }
    this.result = null;
    this.onResults?.(this);
  }

  /** @returns Whether the search was truncated by the node cap */
  private searchRerollTree(
    currentOptions: ModifierTypeOption[],
    currentRerollCount: number,
    optionCount: number,
    recordHit: (option: ModifierTypeOption, path: Omit<WantedItemPath, "key" | "label">) => boolean | void,
    isDone: () => boolean,
    trace: OracleResult["trace"],
  ): boolean {
    const party = globalScene.getPlayerParty();
    const budget = globalScene.money;

    // Sandbox: everything below must leave live state untouched
    const liveRngState = Phaser.Math.RND.state();
    const liveMoney = globalScene.money;
    // Generation logs verbosely; silence it for the simulation burst
    const liveConsoleLog = console.log;
    console.log = () => {};

    let simulated = 0;
    let truncated = false;

    try {
      // Cheapest-first frontier: the first hit per item is the cheapest path
      const frontier: OracleNode[] = [
        {
          rerollCount: currentRerollCount,
          rngState: liveRngState,
          parentTiers: currentOptions.map(o => o.type?.tier).filter(t => t !== undefined) as ModifierTier[],
          costSoFar: 0,
          lockPath: [],
        },
      ];

      while (frontier.length > 0 && !isDone()) {
        frontier.sort((a, b) => a.costSoFar - b.costSoFar);
        const node = frontier.shift()!;

        for (const locked of [false, true]) {
          const stepCost = this.getStepCost(locked, node.parentTiers, node.rerollCount);
          const totalCost = node.costSoFar + stepCost;
          const lockPath = [...node.lockPath, locked];
          if (stepCost < 0 || totalCost > budget || lockPath.length > MAX_EXTRA_ROLLS) {
            continue;
          }
          if (++simulated > MAX_NODES) {
            truncated = true;
            return truncated;
          }

          // Simulate the child roll: money is decremented along the path because
          // pool weight functions may read it
          Phaser.Math.RND.state(node.rngState);
          globalScene.money = liveMoney - totalCost;
          regenerateModifierPoolThresholds(party, ModifierPoolType.PLAYER, node.rerollCount + 1);
          const options = getPlayerModifierTypeOptions(optionCount, party, locked ? node.parentTiers : undefined);

          for (const option of options) {
            recordHit(option, { kind: "reroll", totalCost, lockPath });
          }
          trace.push({ lockPath, totalCost, optionKeys: options.map(o => getWantedItemKey(o.type)) });

          frontier.push({
            rerollCount: node.rerollCount + 1,
            rngState: Phaser.Math.RND.state(),
            parentTiers: options.map(o => o.type?.tier).filter(t => t !== undefined) as ModifierTier[],
            costSoFar: totalCost,
            lockPath,
          });
        }
      }
    } finally {
      // Restore live state exactly as the phase left it. The pool *thresholds* are
      // deliberately left as the last simulation set them: regenerating them here would
      // consume RNG (generator probes) and pollute the restored stream, and every
      // consumer (the next reroll, enemy generation) re-runs
      // regenerateModifierPoolThresholds before reading them anyway.
      console.log = liveConsoleLog;
      globalScene.money = liveMoney;
      Phaser.Math.RND.state(liveRngState);
    }

    return truncated;
  }
}

export const rewardOracle = new RewardOracle();
// An explicit player speed change always beats the automation speed override
registerSpeedOverrideCanceller(() => rewardOracle.dropSpeedOverride());
