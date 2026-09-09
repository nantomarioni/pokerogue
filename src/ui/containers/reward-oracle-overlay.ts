import { globalScene } from "#app/global-scene";
import { TextStyle } from "#enums/text-style";
import type { RewardOracle, WantedItemPath } from "#system/reward-oracle";
import { addBBCodeTextObject, addTextObject, getTextColor } from "#ui/text";
import { addWindow } from "#ui/ui-theme";
import i18next from "i18next";
import type BBCodeText from "phaser3-rex-plugins/plugins/gameobjects/tagtext/bbcodetext/BBCodeText";

const MAX_LINES = 12;

/** BBCode-wrap a fragment in the given text style (color + shadow). */
function bb(text: string, style: TextStyle): string {
  return `[shadow=${getTextColor(style, true)}][color=${getTextColor(style, false)}]${text}[/color][/shadow]`;
}

/**
 * HUD panel listing, for each wanted item, the cheapest way to obtain it from the
 * current reward screen. Two aligned columns — item names (right-aligned) and their
 * paths (left-aligned at a shared x) — so path depths compare at a glance:
 *
 *     Leftovers  HERE
 *   TM Ice Beam  R > L > R  (1,250)
 *        Potion  shop (98)
 *
 * `R` = reroll (white), `L` = locked reroll (blue). Costs are path totals; anything
 * that would exceed the current money never reaches this overlay (the oracle's
 * search prunes by budget). Never takes input focus.
 */
export class RewardOracleOverlay extends Phaser.GameObjects.Container {
  private bg: Phaser.GameObjects.NineSlice;
  private titleText: Phaser.GameObjects.Text;
  private namesText: Phaser.GameObjects.Text;
  private pathsText: BBCodeText;

  constructor() {
    // Top-right corner, below the money/wave text
    super(globalScene, globalScene.scaledCanvas.width - 2, 30);
  }

  public setup(): void {
    this.bg = addWindow(0, 0, 90, 24);
    this.bg.setOrigin(1, 0);
    this.add(this.bg);

    this.titleText = addTextObject(-4, 3, "", TextStyle.MESSAGE, { fontSize: "48px" });
    this.titleText.setOrigin(1, 0);
    this.add(this.titleText);

    this.namesText = addTextObject(0, 12, "", TextStyle.WINDOW_ALT, { fontSize: "44px" });
    this.namesText.setOrigin(1, 0);
    this.namesText.setAlign("right");
    this.namesText.setLineSpacing(2);
    this.add(this.namesText);

    this.pathsText = addBBCodeTextObject(0, 12, "", TextStyle.WINDOW_ALT, {
      fontSize: "44px",
      lineSpacing: 2,
    });
    this.pathsText.setOrigin(0, 0);
    this.add(this.pathsText);

    this.setVisible(false);
  }

  /** The colored path column for one wanted-item hit. */
  private static formatPath(path: WantedItemPath): string {
    switch (path.kind) {
      case "current":
        return bb(i18next.t("rewardOracle:here", { defaultValue: "HERE" }), TextStyle.SUMMARY_GREEN);
      case "shop":
        return bb(
          i18next.t("rewardOracle:shop", { defaultValue: "shop ({{cost}})", cost: path.totalCost.toLocaleString() }),
          TextStyle.WINDOW_ALT,
        );
      case "reroll": {
        const steps = path.lockPath
          .map(locked => (locked ? bb("L", TextStyle.SUMMARY_BLUE) : bb("R", TextStyle.WINDOW_ALT)))
          .join(bb(" > ", TextStyle.WINDOW_ALT));
        return `${steps}${bb(`  (${path.totalCost.toLocaleString()})`, TextStyle.WINDOW_ALT)}`;
      }
    }
  }

  /** Listener registered on {@linkcode RewardOracle.onResults}. */
  public onOracleResults(oracle: RewardOracle): void {
    const result = oracle.result;
    if (!result || result.paths.size === 0) {
      this.setVisible(false);
      return;
    }

    const names: string[] = [];
    const paths: string[] = [];
    // Cheapest first, so shallow paths cluster at the top
    const hits = [...result.paths.values()]
      .filter((p): p is WantedItemPath => p != null)
      .sort((a, b) => a.totalCost - b.totalCost);
    for (const path of hits.slice(0, MAX_LINES)) {
      names.push(path.label);
      paths.push(RewardOracleOverlay.formatPath(path));
    }
    if (hits.length > MAX_LINES) {
      names.push("…");
      paths.push("");
    }

    const misses = [...result.paths.values()].filter(p => p == null).length;
    if (misses > 0) {
      names.push(
        result.truncated
          ? i18next.t("rewardOracle:missesTruncated", { defaultValue: "{{count}} not found (capped)", count: misses })
          : i18next.t("rewardOracle:misses", { defaultValue: "{{count}} not within budget", count: misses }),
      );
      paths.push("");
    }

    if (names.length === 0) {
      this.setVisible(false);
      return;
    }

    this.titleText.setText(i18next.t("rewardOracle:title", { defaultValue: "Wanted items" }));
    this.pathsText.setText(paths.join("\n"));
    this.namesText.setText(names.join("\n"));

    // Layout: paths column left-aligned at a shared x; names right-aligned against it
    const pathsWidth = Math.ceil(this.pathsText.displayWidth);
    this.pathsText.setPosition(-4 - pathsWidth, 12);
    this.namesText.setPosition(-4 - pathsWidth - 6, 12);

    const totalWidth = Math.ceil(this.namesText.displayWidth) + 6 + pathsWidth + 12;
    const totalHeight = Math.ceil(Math.max(this.namesText.displayHeight, this.pathsText.displayHeight)) + 16;
    this.bg.setSize(Math.max(60, totalWidth), Math.max(24, totalHeight));

    this.setVisible(true);
  }
}
