import { globalScene } from "#app/global-scene";
import { TextStyle } from "#enums/text-style";
import { describeLockPath, type RewardOracle } from "#system/reward-oracle";
import { addTextObject } from "#ui/text";
import { addWindow } from "#ui/ui-theme";
import i18next from "i18next";

/** Widest the overlay grows before text wraps awkwardly; matches HUD proportions. */
const MAX_LINES = 12;

/**
 * HUD panel listing, for each wanted item, the cheapest way to obtain it from the
 * current reward screen (already here / buy from shop / a reroll+lock sequence).
 *
 * Fed by {@linkcode RewardOracle.onResults}; visible only while results exist
 * (i.e. while a reward screen with a non-empty wanted list is open). Never takes
 * input focus — same pattern as the savestate overlay.
 */
export class RewardOracleOverlay extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.NineSlice;
  private titleText: Phaser.GameObjects.Text;
  private bodyText: Phaser.GameObjects.Text;

  constructor() {
    // Top-right corner, below the money/wave text
    super(globalScene, globalScene.scaledCanvas.width - 2, 30);
  }

  public setup(): void {
    this.bg = addWindow(0, 0, 90, 24);
    this.bg.setOrigin(1, 0);
    this.add(this.bg);

    this.titleText = addTextObject(0, 3, "", TextStyle.MESSAGE, { fontSize: "48px" });
    this.titleText.setOrigin(1, 0);
    this.add(this.titleText);

    this.bodyText = addTextObject(0, 12, "", TextStyle.WINDOW_ALT, { fontSize: "44px" });
    this.bodyText.setOrigin(1, 0);
    this.bodyText.setLineSpacing(2);
    this.add(this.bodyText);

    this.setVisible(false);
  }

  /** Listener registered on {@linkcode RewardOracle.onResults}. */
  public onOracleResults(oracle: RewardOracle): void {
    const result = oracle.result;
    if (!result || result.paths.size === 0) {
      this.setVisible(false);
      return;
    }

    const lines: string[] = [];
    for (const [, path] of result.paths) {
      if (lines.length >= MAX_LINES) {
        lines.push("…");
        break;
      }
      if (path == null) {
        continue;
      }
      switch (path.kind) {
        case "current":
          lines.push(i18next.t("rewardOracle:here", { defaultValue: "{{item}}: HERE (free)", item: path.label }));
          break;
        case "shop":
          lines.push(
            i18next.t("rewardOracle:shop", {
              defaultValue: "{{item}}: in shop ({{cost}})",
              item: path.label,
              cost: path.totalCost.toLocaleString(),
            }),
          );
          break;
        case "reroll":
          lines.push(
            i18next.t("rewardOracle:reroll", {
              defaultValue: "{{item}}: {{path}} ({{cost}})",
              item: path.label,
              path: describeLockPath(path.lockPath),
              cost: path.totalCost.toLocaleString(),
            }),
          );
          break;
      }
    }
    const misses = [...result.paths.values()].filter(p => p == null).length;
    if (misses > 0) {
      lines.push(
        result.truncated
          ? i18next.t("rewardOracle:missesTruncated", {
              defaultValue: "{{count}} not found (search capped)",
              count: misses,
            })
          : i18next.t("rewardOracle:misses", { defaultValue: "{{count}} not within budget", count: misses }),
      );
    }

    if (lines.length === 0) {
      this.setVisible(false);
      return;
    }

    this.titleText.setText(i18next.t("rewardOracle:title", { defaultValue: "Wanted items" }));
    this.bodyText.setText(lines.join("\n"));

    const width = Math.ceil(Math.max(this.titleText.displayWidth, this.bodyText.displayWidth)) + 8;
    const height = Math.ceil(this.bodyText.displayHeight) + 16;
    this.bg.setSize(Math.max(60, width), Math.max(24, height));
    this.titleText.setPosition(-4, 3);
    this.bodyText.setPosition(-4, 12);

    this.setVisible(true);
  }
}
