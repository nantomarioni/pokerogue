import { globalScene } from "#app/global-scene";
import { TextStyle } from "#enums/text-style";
import type { Savestate, SavestateManager } from "#system/savestate-manager";
import { addTextObject } from "#ui/text";
import { addWindow } from "#ui/ui-theme";
import i18next from "i18next";

/** How long the overlay lingers before fading out (ms) */
const OVERLAY_LINGER_MS = 2500;

/**
 * Lightweight HUD strip visualizing the wave's savestate history.
 *
 * Shows one entry per snapshot (`T<turn>` for turn boundaries, `R<reroll>` for reward
 * rolls) with the cursor entry highlighted, plus a one-line action toast. Appears on any
 * savestate action and fades out shortly after; it never takes input focus.
 */
export class SavestateOverlay extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.NineSlice;
  private titleText: Phaser.GameObjects.Text;
  private stripText: Phaser.GameObjects.Text;

  private hideTween: Phaser.Tweens.Tween | null = null;
  private hideTimer: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super(globalScene, 2, 2);
  }

  public setup(): void {
    this.bg = addWindow(0, 0, 120, 26);
    this.bg.setOrigin(0);
    this.add(this.bg);

    this.titleText = addTextObject(4, 3, "", TextStyle.MESSAGE, { fontSize: "48px" });
    this.titleText.setOrigin(0);
    this.add(this.titleText);

    this.stripText = addTextObject(4, 13, "", TextStyle.WINDOW_ALT, { fontSize: "48px" });
    this.stripText.setOrigin(0);
    this.add(this.stripText);

    this.setVisible(false);
    this.setAlpha(0);
  }

  /** Listener registered on {@linkcode SavestateManager.onChange}. */
  public onSavestateChange(manager: SavestateManager, action: string): void {
    if (action === "clear") {
      this.hideNow();
      return;
    }
    // Turn-by-turn autosaves shouldn't nag; only surface explicit actions
    if (action === "save" && !manager.restorePending) {
      return;
    }
    this.showFor(manager, action);
  }

  private static labelFor(state: Savestate): string {
    return state.kind === "turn" ? `T${state.battle.turn}` : `R${state.reward?.rerollCount ?? 0}`;
  }

  public showFor(manager: SavestateManager, action: string): void {
    const entries = manager.states.map((s, i) => {
      const label = SavestateOverlay.labelFor(s);
      return i === manager.cursorIndex ? `[${label}]` : label;
    });

    let title: string;
    switch (action) {
      case "loading":
        title = i18next.t("savestate:loading", { defaultValue: "Loading state…" });
        break;
      case "load":
        title = i18next.t("savestate:loaded", {
          defaultValue: "State loaded ({{state}})",
          state: manager.current ? SavestateOverlay.labelFor(manager.current) : "?",
        });
        break;
      case "manual-save":
        title = i18next.t("savestate:manualSaved", { defaultValue: "State saved to slot" });
        break;
      default:
        title = i18next.t("savestate:states", { defaultValue: "States" });
        break;
    }

    this.titleText.setText(title);
    this.stripText.setText(entries.join(" ") || "—");

    const width = Math.max(60, Math.ceil(Math.max(this.titleText.displayWidth, this.stripText.displayWidth)) + 8);
    this.bg.setSize(width, 26);

    this.hideTween?.stop();
    this.hideTween = null;
    this.setVisible(true);
    this.setAlpha(1);

    this.hideTimer?.remove();
    // Keep the overlay pinned while a restore is running; fade out afterwards
    if (action !== "loading") {
      this.hideTimer = globalScene.time.delayedCall(OVERLAY_LINGER_MS, () => this.fadeOut());
    }
  }

  private fadeOut(): void {
    this.hideTween = globalScene.tweens.add({
      targets: this,
      alpha: 0,
      duration: 350,
      ease: "Sine.easeIn",
      onComplete: () => this.setVisible(false),
    });
  }

  private hideNow(): void {
    this.hideTimer?.remove();
    this.hideTween?.stop();
    this.setVisible(false);
    this.setAlpha(0);
  }
}
