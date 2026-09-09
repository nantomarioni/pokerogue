import { loggedInUser } from "#app/account";
import { globalScene } from "#app/global-scene";
import { bypassLogin } from "#constants/app-constants";
import type { ModifierTier } from "#enums/modifier-tier";
import type { MoveId } from "#enums/move-id";
import type { PokeballType } from "#enums/pokeball";
import type { Pokemon } from "#field/pokemon";
import { registerSpeedOverrideCanceller } from "#system/speed-overrides";
import type { SessionSaveData } from "#types/save-data";
import { decrypt, encrypt } from "#utils/data";
import i18next from "i18next";

/**
 * Serialized snapshot of the per-Pokemon transient layers that are NOT part of
 * the vanilla {@linkcode SessionSaveData} (which only covers `summonData` + `battleData`).
 */
interface PokemonTransientSnapshot {
  /** `Pokemon.id`, used to re-link on restore */
  id: number;
  /** {@linkcode PokemonWaveData} with `abilitiesApplied` converted to an array */
  waveData: {
    endured: boolean;
    abilitiesApplied: number[];
    abilityRevealed: boolean;
  };
  /** {@linkcode PokemonTempSummonData} (plain counters) */
  tempSummonData: {
    turnCount: number;
    waveTurnCount: number;
  };
}

/** Serialized mid-wave {@linkcode Battle} state dropped by vanilla saves. */
interface BattleSnapshot {
  turn: number;
  battleSeed: string;
  started: boolean;
  enemySwitchCounter: number;
  battleScore: number;
  escapeAttempts: number;
  lastMove: MoveId;
  moneyScattered: number;
  lastEnemyInvolved: number;
  lastPlayerInvolved: number;
  lastUsedPokeball: PokeballType | null;
  enemyFaints: number;
  failedRunAway: boolean;
  playerParticipantIds: number[];
  seenEnemyPartyMemberIds: number[];
  /** Faint histories serialized as `[pokemonId, turn]` tuples */
  playerFaintsHistory: [number, number][];
  enemyFaintsHistory: [number, number][];
}

/** Extra state captured for reward-screen (`SelectModifierPhase`) snapshots. */
interface RewardSnapshot {
  rerollCount: number;
  modifierTiers?: ModifierTier[] | undefined;
  lockModifierTiers: boolean;
  /** Whether a `SelectBiomePhase` was still pending behind the reward screen */
  biomeSelectPending: boolean;
}

export interface Savestate {
  kind: "turn" | "reward";
  /** Validity envelope: a snapshot may only be loaded into the run/wave it was taken in */
  seed: string;
  waveIndex: number;
  slotId: number;
  gameVersion: string;
  timestamp: number;
  /** The full vanilla session snapshot (already JSON-serializable) */
  session: SessionSaveData;
  /** Global Phaser RNG state string at capture time */
  rngState: string;
  battle: BattleSnapshot;
  pokemonTransients: PokemonTransientSnapshot[];
  reward?: RewardSnapshot | undefined;
}

/** @returns The localStorage key holding the manual savestate slot for the given session slot. */
export function getSavestateLocalStorageKey(slotId: number): string {
  return `savestate${slotId || ""}_${loggedInUser?.username}`;
}

/**
 * Register English fallback strings for the savestate UI at runtime.
 * Keeps the feature self-contained instead of requiring changes to the locales submodule;
 * real translations added there later take precedence (`overwrite: false`).
 */
export function registerSavestateI18nFallbacks(): void {
  i18next.addResourceBundle(
    "en",
    "menuUiHandler",
    {
      saveState: "Save State",
      loadState: "Load State",
      restartWave: "Restart Wave",
      wantedItems: "Wanted Items",
      back: "Back",
    },
    true,
    false,
  );
  i18next.addResourceBundle(
    "en",
    "settings",
    {
      buttonStateLoad: "Load Last State",
      buttonStatePrev: "Previous State",
      buttonStateNext: "Next State",
      buttonAutoPath: "Auto-Execute Reward Path",
    },
    true,
    false,
  );
}

function snapshotPokemonTransients(pokemon: Pokemon): PokemonTransientSnapshot {
  return {
    id: pokemon.id,
    waveData: {
      endured: pokemon.waveData.endured,
      abilitiesApplied: [...pokemon.waveData.abilitiesApplied],
      abilityRevealed: pokemon.waveData.abilityRevealed,
    },
    tempSummonData: {
      turnCount: pokemon.tempSummonData.turnCount,
      waveTurnCount: pokemon.tempSummonData.waveTurnCount,
    },
  };
}

/** Game speed applied while a restore's animations play (the native "Turbo" setting value). */
const RESTORE_GAME_SPEED = 5;

/**
 * Manages emulator-style savestates scoped to the current wave.
 *
 * Snapshots are auto-captured at every turn boundary ({@linkcode TurnInitPhase} start) and at
 * every reward-screen roll ({@linkcode SelectModifierPhase} start), forming a linear history
 * with a cursor. Loading an older state only moves the cursor; the first *organic* capture
 * afterwards (i.e. completing a turn / rerolling) truncates the stale "future" entries.
 *
 * The history is wiped whenever a new wave is persisted by the vanilla save pipeline,
 * enforcing that no state can be loaded from before the current wave's start.
 */
export class SavestateManager {
  private history: Savestate[] = [];
  private cursor = -1;

  /** Set while a savestate restore is in progress; suppresses capture + post-summon effects. */
  public restoring = false;
  /** Set right after a restore completes so the re-entered boundary phase repositions the cursor instead of appending. */
  private pendingCursorSync: Savestate | null = null;

  /**
   * Whether a restore is in progress or its target boundary phase hasn't re-run yet.
   * Used to suppress `PostSummonPhase` queuing while the field is being rebuilt.
   */
  public get restorePending(): boolean {
    return this.restoring || this.pendingCursorSync != null;
  }

  /** Listeners notified whenever the history/cursor changes (used by the HUD overlay). */
  public onChange: ((manager: SavestateManager, action: string) => void) | null = null;

  /** Preview index while the player is stepping through states before the load commits. */
  private navPreview: number | null = null;
  /** Reverts the temporary restore-time game-speed boost (null when no boost is active). */
  private revertSpeedBoost: (() => void) | null = null;
  private revertSpeedBoostTimer: ReturnType<typeof setTimeout> | null = null;

  public get states(): readonly Savestate[] {
    return this.history;
  }

  public get cursorIndex(): number {
    return this.cursor;
  }

  public get current(): Savestate | null {
    return this.history[this.cursor] ?? null;
  }

  public get tip(): Savestate | null {
    return this.history.at(-1) ?? null;
  }

  /** The pending navigation target while stepping through states, or `null` when none. */
  public get preview(): number | null {
    return this.navPreview;
  }

  /**
   * Move the navigation preview one step without loading anything.
   * Lets rapid presses coalesce into a single restore (committed via {@linkcode commitPreview}).
   * @returns The new preview index, or `null` if the step is impossible
   */
  public stepPreview(direction: -1 | 1): number | null {
    if (this.restorePending || this.history.length === 0) {
      return null;
    }
    const target = (this.navPreview ?? this.cursor) + direction;
    if (target < 0 || target > this.history.length - 1) {
      return null;
    }
    this.navPreview = target;
    this.notify("preview");
    return target;
  }

  /** Commit the pending navigation preview, triggering at most one restore. */
  public commitPreview(): boolean {
    const target = this.navPreview;
    this.navPreview = null;
    if (target == null) {
      return false;
    }
    if (target === this.cursor) {
      // Stepped back and forth to the state the game is already in: nothing to load
      this.notify("load");
      return true;
    }
    return this.loadIndex(target);
  }

  public cancelPreview(): void {
    this.navPreview = null;
  }

  private notify(action: string): void {
    this.onChange?.(this, action);
  }

  /** Whether snapshots can currently be captured (not during MEs or special reward screens). */
  private canCapture(): boolean {
    const battle = globalScene.currentBattle;
    if (!battle) {
      return false;
    }
    // Mystery encounters hold function-laden runtime state that cannot be serialized
    if (battle.isBattleMysteryEncounter() || battle.mysteryEncounter != null) {
      return false;
    }
    return true;
  }

  /**
   * Capture a snapshot at the current boundary and append it to the history.
   * If the cursor was rewound, all stale "future" entries are truncated first.
   * No-op while a restore is in progress (the cursor is repositioned instead).
   * @param reward - Reward-screen context when capturing at a `SelectModifierPhase` boundary
   */
  public capture(reward?: RewardSnapshot): void {
    if (this.pendingCursorSync) {
      // Re-entering the boundary phase as part of a restore: keep history intact,
      // just point the cursor at the state that was loaded.
      const idx = this.history.indexOf(this.pendingCursorSync);
      this.pendingCursorSync = null;
      // The target screen is settling: let its entrance animation finish boosted, then revert
      this.scheduleSpeedBoostRevert(1200);
      if (idx >= 0) {
        this.cursor = idx;
        this.notify("load");
        return;
      }
    }
    if (this.restoring || !this.canCapture()) {
      return;
    }
    if (!reward && globalScene.currentBattle.turn < 1) {
      return;
    }

    const snapshot = this.buildSnapshot(reward);
    if (!snapshot) {
      return;
    }

    // Organic capture while rewound: the old future is dead (linear history, no branches)
    if (this.cursor < this.history.length - 1) {
      this.history.splice(this.cursor + 1);
    }
    this.history.push(snapshot);
    this.cursor = this.history.length - 1;
    this.notify("save");
  }

  private buildSnapshot(reward?: RewardSnapshot): Savestate | null {
    try {
      const battle = globalScene.currentBattle;
      // Round-trip through JSON so the stored session is decoupled from live objects
      const session = globalScene.gameData.parseSessionData(JSON.stringify(globalScene.gameData.getSessionSaveData()));
      return {
        kind: reward ? "reward" : "turn",
        seed: globalScene.seed,
        waveIndex: battle.waveIndex,
        slotId: globalScene.sessionSlotId,
        gameVersion: globalScene.game.config.gameVersion,
        timestamp: Date.now(),
        session,
        rngState: Phaser.Math.RND.state(),
        battle: {
          turn: battle.turn,
          battleSeed: battle.battleSeed,
          started: battle.started,
          enemySwitchCounter: battle.enemySwitchCounter,
          battleScore: battle.battleScore,
          escapeAttempts: battle.escapeAttempts,
          lastMove: battle.lastMove,
          moneyScattered: battle.moneyScattered,
          lastEnemyInvolved: battle.lastEnemyInvolved,
          lastPlayerInvolved: battle.lastPlayerInvolved,
          lastUsedPokeball: battle.lastUsedPokeball,
          enemyFaints: battle.enemyFaints,
          failedRunAway: battle.failedRunAway,
          playerParticipantIds: [...battle.playerParticipantIds],
          seenEnemyPartyMemberIds: [...battle.seenEnemyPartyMemberIds],
          playerFaintsHistory: battle.playerFaintsHistory.map(e => [e.pokemon.id, e.turn]),
          enemyFaintsHistory: battle.enemyFaintsHistory.map(e => [e.pokemon.id, e.turn]),
        },
        pokemonTransients: [...globalScene.getPlayerParty(), ...globalScene.getEnemyParty()].map(
          snapshotPokemonTransients,
        ),
        reward,
      };
    } catch (err) {
      console.error("Failed to capture savestate:", err);
      return null;
    }
  }

  /**
   * Wipe the wave-scoped history (called when a new wave gets persisted by the vanilla
   * save pipeline, on game over, and when a different session is loaded).
   */
  public clear(): void {
    if (this.history.length === 0 && this.cursor === -1) {
      return;
    }
    this.history = [];
    this.cursor = -1;
    this.pendingCursorSync = null;
    this.navPreview = null;
    this.notify("clear");
  }

  /** @returns Whether the given snapshot may be loaded into the live session. */
  public isValid(state: Savestate | null): state is Savestate {
    const battle = globalScene.currentBattle;
    return (
      state != null
      && battle != null
      && state.seed === globalScene.seed
      && state.waveIndex === battle.waveIndex
      && state.slotId === globalScene.sessionSlotId
      && state.gameVersion === globalScene.game.config.gameVersion
    );
  }

  /** Load the newest snapshot (soft reset of the current turn / reward roll). */
  public loadLast(): boolean {
    return this.loadIndex(this.history.length - 1);
  }

  /** Step one snapshot back in the history (floored at the wave's first entry). */
  public loadPrevious(): boolean {
    return this.loadIndex(this.cursor - 1);
  }

  /**
   * Step one snapshot forward in the history (capped at the tip).
   * A no-op when already at the newest state.
   */
  public loadNext(): boolean {
    if (this.cursor >= this.history.length - 1) {
      return false;
    }
    return this.loadIndex(this.cursor + 1);
  }

  public loadIndex(index: number): boolean {
    const state = this.history[index];
    if (this.restoring || !this.isValid(state ?? null)) {
      return false;
    }
    this.cursor = index;
    this.beginRestore(state);
    return true;
  }

  /**
   * Copy the newest snapshot into the manual slot in localStorage
   * (mirrors the vanilla session persistence: same key scheme + encryption).
   */
  public saveManualSlot(): boolean {
    const state = this.tip;
    if (!this.isValid(state)) {
      return false;
    }
    try {
      localStorage.setItem(
        getSavestateLocalStorageKey(globalScene.sessionSlotId),
        encrypt(JSON.stringify(state), bypassLogin),
      );
      this.notify("manual-save");
      return true;
    } catch (err) {
      console.error("Failed to persist savestate:", err);
      return false;
    }
  }

  /** Read (but do not load) the manual slot for the current session, if present and valid. */
  public peekManualSlot(): Savestate | null {
    try {
      const raw = localStorage.getItem(getSavestateLocalStorageKey(globalScene.sessionSlotId));
      if (!raw) {
        return null;
      }
      const state: Savestate = JSON.parse(decrypt(raw, bypassLogin));
      // Re-wrap the session through the vanilla parser to revive class instances
      state.session = globalScene.gameData.parseSessionData(JSON.stringify(state.session));
      return this.isValid(state) ? state : null;
    } catch (err) {
      console.warn("Failed to read manual savestate slot:", err);
      return null;
    }
  }

  /** Load the manual slot (e.g. after a page refresh mid-wave). */
  public loadManualSlot(): boolean {
    const state = this.peekManualSlot();
    if (!state || this.restoring) {
      return false;
    }
    // Adopt it into the in-memory history if it isn't there already
    if (!this.history.some(s => s.timestamp === state.timestamp && s.kind === state.kind)) {
      this.history.push(state);
      this.history.sort((a, b) => a.timestamp - b.timestamp);
    }
    this.cursor = this.history.indexOf(state);
    this.beginRestore(state);
    return true;
  }

  /** Delete the manual slot (called alongside {@linkcode clear} on new-wave persist). */
  public clearManualSlot(): void {
    localStorage.removeItem(getSavestateLocalStorageKey(globalScene.sessionSlotId));
  }

  /**
   * Kick off the in-process restore: tear down the running phase queue and hand control
   * to a {@linkcode SavestateRestorePhase} which rebuilds the scene from the snapshot.
   */
  private beginRestore(state: Savestate): void {
    this.restoring = true;
    this.pendingCursorSync = state;
    this.navPreview = null;
    this.notify("loading");

    // Play the restore's animations at the game's native Turbo speed
    // (reverted shortly after the target screen settles; failsafe below)
    this.applySpeedBoost();
    this.scheduleSpeedBoostRevert(5000);

    const phaseManager = globalScene.phaseManager;
    const interrupted = phaseManager.getCurrentPhase();
    phaseManager.clearAllPhases();
    phaseManager.unshiftNew("SavestateRestorePhase", state);
    // End the interrupted (UI-waiting) phase so the restore phase starts immediately
    interrupted.end();
  }

  /**
   * Called by {@linkcode SavestateRestorePhase} once the scene has been rebuilt.
   * The cursor sync flag stays set until the target boundary phase re-runs.
   */
  public finishRestore(): void {
    this.restoring = false;
  }

  /**
   * Temporarily raise the game speed to Turbo while a restore's animations play.
   * Uses the exact mechanism behind the official speed setting (see `initGameSpeed`),
   * so timing-scaled behavior is identical to a player running at 5x.
   */
  private applySpeedBoost(): void {
    if (this.revertSpeedBoost || globalScene.gameSpeed >= RESTORE_GAME_SPEED) {
      return;
    }
    const originalSpeed = globalScene.gameSpeed;
    globalScene.gameSpeed = RESTORE_GAME_SPEED;
    this.revertSpeedBoost = () => {
      // Don't clobber the setting if the player changed speed themselves in the meantime
      if (globalScene.gameSpeed === RESTORE_GAME_SPEED) {
        globalScene.gameSpeed = originalSpeed;
      }
      this.revertSpeedBoost = null;
    };
  }

  /** (Re)schedule the speed-boost revert; wall-clock so it is unaffected by the boost itself. */
  private scheduleSpeedBoostRevert(delayMs: number): void {
    if (!this.revertSpeedBoost) {
      return;
    }
    if (this.revertSpeedBoostTimer) {
      clearTimeout(this.revertSpeedBoostTimer);
    }
    this.revertSpeedBoostTimer = setTimeout(() => {
      this.revertSpeedBoostTimer = null;
      this.revertSpeedBoost?.();
    }, delayMs);
  }

  /**
   * Drop any pending restore-time speed boost without reverting.
   * Called when the player explicitly changes the game speed: their choice always wins
   * over a stale revert (otherwise picking Turbo right after a boosted restore would be
   * indistinguishable from the boost itself and get knocked back down).
   */
  public cancelSpeedBoost(): void {
    if (this.revertSpeedBoostTimer) {
      clearTimeout(this.revertSpeedBoostTimer);
      this.revertSpeedBoostTimer = null;
    }
    this.revertSpeedBoost = null;
  }
}

export const savestateManager = new SavestateManager();
// An explicit player speed change always beats a pending restore speed boost
registerSpeedOverrideCanceller(() => savestateManager.cancelSpeedBoost());
