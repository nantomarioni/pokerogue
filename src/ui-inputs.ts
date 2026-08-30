import { audioManager } from "#app/global-audio-manager";
import { globalScene } from "#app/global-scene";
import type { InputsController } from "#app/inputs-controller";
import { isDev } from "#constants/app-constants";
import { Button } from "#enums/buttons";
import { UiMode } from "#enums/ui-mode";
import { savestateManager } from "#system/savestate-manager";
import { Setting, SettingKeys, settingIndex } from "#system/settings";
import { SettingsAudioUiHandler } from "#ui/audio-settings-ui-handler";
import { AwaitableUiHandler } from "#ui/awaitable-ui-handler";
import { SettingsDisplayUiHandler } from "#ui/display-settings-ui-handler";
import { SettingsGamepadUiHandler } from "#ui/gamepad-settings-ui-handler";
import { SettingsKeyboardUiHandler } from "#ui/keyboard-settings-ui-handler";
import type { MessageUiHandler } from "#ui/message-ui-handler";
import { PokedexPageUiHandler } from "#ui/pokedex-page-ui-handler";
import { PokedexUiHandler } from "#ui/pokedex-ui-handler";
import { RunInfoUiHandler } from "#ui/run-info-ui-handler";
import { SettingsUiHandler } from "#ui/settings-ui-handler";
import { StarterSelectUiHandler } from "#ui/starter-select-ui-handler";
import Phaser from "phaser";

type ActionKeys = Record<Button, () => void>;

export class UiInputs {
  private events: Phaser.Events.EventEmitter;
  private inputsController: InputsController;
  private savestateNavTimer: ReturnType<typeof setTimeout> | null = null;

  /** How long after the last prev/next press the pending savestate navigation commits (ms). */
  private static readonly SAVESTATE_NAV_COMMIT_DELAY_MS = 500;

  constructor(inputsController: InputsController) {
    this.inputsController = inputsController;
    this.init();
  }

  init(): void {
    this.events = this.inputsController.events;
    this.listenInputs();
  }

  detectInputMethod(evt): void {
    if (evt.controller_type === "keyboard") {
      //if the touch property is present and defined, then this is a simulated keyboard event from the touch screen
      if (Object.hasOwn(evt, "isTouch") && evt.isTouch) {
        globalScene.inputMethod = "touch";
      } else {
        globalScene.inputMethod = "keyboard";
      }
    } else if (evt.controller_type === "gamepad") {
      globalScene.inputMethod = "gamepad";
    }
  }

  listenInputs(): void {
    this.events.on(
      "input_down",
      event => {
        this.detectInputMethod(event);

        const actions = this.getActionsKeyDown();
        if (!Object.hasOwn(actions, event.button)) {
          return;
        }
        actions[event.button]();
      },
      this,
    );

    this.events.on(
      "input_up",
      event => {
        const actions = this.getActionsKeyUp();
        if (!Object.hasOwn(actions, event.button)) {
          return;
        }
        actions[event.button]();
      },
      this,
    );
  }

  doVibration(inputSuccess: boolean, vibrationLength: number): void {
    if (inputSuccess && globalScene.enableVibration && typeof navigator.vibrate !== "undefined") {
      navigator.vibrate(vibrationLength);
    }
  }

  getActionsKeyDown(): ActionKeys {
    const actions: ActionKeys = {
      [Button.UP]: () => this.buttonDirection(Button.UP),
      [Button.DOWN]: () => this.buttonDirection(Button.DOWN),
      [Button.LEFT]: () => this.buttonDirection(Button.LEFT),
      [Button.RIGHT]: () => this.buttonDirection(Button.RIGHT),
      [Button.SUBMIT]: () => this.buttonTouch(),
      [Button.ACTION]: () => this.buttonAb(Button.ACTION),
      [Button.CANCEL]: () => this.buttonAb(Button.CANCEL),
      [Button.MENU]: () => this.buttonMenu(),
      [Button.STATS]: () => this.buttonGoToFilter(Button.STATS),
      [Button.CYCLE_SHINY]: () => this.buttonCycleOption(Button.CYCLE_SHINY),
      [Button.CYCLE_FORM]: () => this.buttonCycleOption(Button.CYCLE_FORM),
      [Button.CYCLE_GENDER]: () => this.buttonCycleOption(Button.CYCLE_GENDER),
      [Button.CYCLE_ABILITY]: () => this.buttonCycleOption(Button.CYCLE_ABILITY),
      [Button.CYCLE_NATURE]: () => this.buttonCycleOption(Button.CYCLE_NATURE),
      [Button.CYCLE_TERA]: () => this.buttonCycleOption(Button.CYCLE_TERA),
      [Button.SPEED_UP]: () => this.buttonSpeedChange(),
      [Button.SLOW_DOWN]: () => this.buttonSpeedChange(false),
      [Button.STATE_LOAD]: () => this.buttonSavestate(Button.STATE_LOAD),
      [Button.STATE_PREV]: () => this.buttonSavestate(Button.STATE_PREV),
      [Button.STATE_NEXT]: () => this.buttonSavestate(Button.STATE_NEXT),
      [Button.DEV_CUSTOM]: () => {
        if (isDev) {
          import("./dev-function").then(m => m.customDevFunction());
        }
      },
    };
    return actions;
  }

  getActionsKeyUp(): ActionKeys {
    const actions: ActionKeys = {
      [Button.UP]: () => {},
      [Button.DOWN]: () => {},
      [Button.LEFT]: () => {},
      [Button.RIGHT]: () => {},
      [Button.SUBMIT]: () => {},
      [Button.ACTION]: () => {},
      [Button.CANCEL]: () => {},
      [Button.MENU]: () => {},
      [Button.STATS]: () => this.buttonStats(false),
      [Button.CYCLE_SHINY]: () => {},
      [Button.CYCLE_FORM]: () => {},
      [Button.CYCLE_GENDER]: () => {},
      [Button.CYCLE_ABILITY]: () => {},
      [Button.CYCLE_NATURE]: () => {},
      [Button.CYCLE_TERA]: () => this.buttonInfo(false),
      [Button.SPEED_UP]: () => {},
      [Button.SLOW_DOWN]: () => {},
      [Button.STATE_LOAD]: () => {},
      [Button.STATE_PREV]: () => {},
      [Button.STATE_NEXT]: () => {},
      [Button.DEV_CUSTOM]: () => {},
    };
    return actions;
  }

  buttonDirection(direction: Button): void {
    const inputSuccess = globalScene.ui.processInput(direction);
    const vibrationLength = 5;
    this.doVibration(inputSuccess, vibrationLength);
  }

  buttonAb(button: Button): void {
    globalScene.ui.processInput(button);
  }

  buttonTouch(): void {
    globalScene.ui.processInput(Button.SUBMIT) || globalScene.ui.processInput(Button.ACTION);
  }

  buttonStats(pressed = true): void {
    // allow access to Button.STATS as a toggle for other elements
    for (const t of globalScene.getInfoToggles(true)) {
      t.toggleInfo(pressed);
    }
    // handle normal pokemon battle ui
    for (const p of globalScene.getField().filter(p => p?.isActive(true))) {
      p.toggleStats(pressed);
    }
  }

  buttonGoToFilter(button: Button): void {
    const whitelist = [StarterSelectUiHandler, PokedexUiHandler, PokedexPageUiHandler];
    const uiHandler = globalScene.ui?.getHandler();
    if (whitelist.some(handler => uiHandler instanceof handler)) {
      globalScene.ui.processInput(button);
    } else {
      this.buttonStats(true);
    }
  }

  buttonInfo(pressed = true): void {
    if (globalScene.showMovesetFlyout) {
      for (const p of globalScene.getEnemyField().filter(p => p?.isActive(true))) {
        p.toggleFlyout(pressed);
      }
    }

    if (globalScene.showArenaFlyout) {
      globalScene.ui.processInfoButton(pressed);
    }
  }

  buttonMenu(): void {
    if (globalScene.disableMenu) {
      return;
    }
    switch (globalScene.ui?.getMode()) {
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: falls through to show menu overlay
      case UiMode.MESSAGE: {
        const messageHandler = globalScene.ui.getHandler<MessageUiHandler>();
        if (!messageHandler.pendingPrompt || messageHandler.isTextAnimationInProgress()) {
          return;
        }
      }
      case UiMode.TITLE:
      case UiMode.COMMAND:
      case UiMode.MODIFIER_SELECT:
      case UiMode.MYSTERY_ENCOUNTER:
        globalScene.ui.setOverlayMode(UiMode.MENU);
        break;
      case UiMode.STARTER_SELECT:
      case UiMode.POKEDEX_PAGE:
        this.buttonTouch();
        break;
      case UiMode.MENU:
        globalScene.ui.revertMode();
        audioManager.playSound("ui/select");
        break;
      default:
        return;
    }
  }

  buttonCycleOption(button: Button): void {
    const whitelist = [
      StarterSelectUiHandler,
      PokedexUiHandler,
      PokedexPageUiHandler,
      SettingsUiHandler,
      RunInfoUiHandler,
      SettingsDisplayUiHandler,
      SettingsAudioUiHandler,
      SettingsGamepadUiHandler,
      SettingsKeyboardUiHandler,
    ];
    const uiHandler = globalScene.ui?.getHandler();
    if (whitelist.some(handler => uiHandler instanceof handler)) {
      globalScene.ui.processInput(button);
    } else if (!this.tryGamepadSavestateAlias(button) && button === Button.CYCLE_TERA) {
      this.buttonInfo(true);
    }
  }

  /**
   * Map dead-in-battle gamepad cycle buttons to savestate actions
   * (LB -> previous state, RB -> next state, LT -> load last state).
   * Keyboard input is unaffected (it has dedicated savestate keys).
   * @returns Whether the button was handled as a savestate action
   */
  private tryGamepadSavestateAlias(button: Button): boolean {
    if (globalScene.inputMethod !== "gamepad") {
      return false;
    }
    switch (button) {
      case Button.CYCLE_FORM:
        this.buttonSavestate(Button.STATE_PREV);
        return true;
      case Button.CYCLE_SHINY:
        this.buttonSavestate(Button.STATE_NEXT);
        return true;
      case Button.CYCLE_GENDER:
        this.buttonSavestate(Button.STATE_LOAD);
        return true;
      default:
        return false;
    }
  }

  /** Handle savestate navigation, only while the game is waiting for input at a safe boundary. */
  buttonSavestate(button: Button): void {
    if (!this.canTriggerSavestate()) {
      return;
    }

    if (button === Button.STATE_LOAD) {
      this.clearSavestateNavTimer();
      savestateManager.cancelPreview();
      if (!savestateManager.loadLast()) {
        globalScene.ui.playError();
      }
      return;
    }

    // Prev/next only move a preview cursor; the actual (single) restore fires
    // shortly after the last press, so stepping N states back costs one reload
    const target = savestateManager.stepPreview(button === Button.STATE_PREV ? -1 : 1);
    if (target == null) {
      globalScene.ui.playError();
      return;
    }
    // Each press resets the commit window, so you can keep stepping at a relaxed pace
    this.clearSavestateNavTimer();
    this.savestateNavTimer = setTimeout(() => {
      this.savestateNavTimer = null;
      // Conditions were checked at press time; re-check before committing
      if (this.canTriggerSavestate()) {
        savestateManager.commitPreview();
      } else {
        savestateManager.cancelPreview();
      }
    }, UiInputs.SAVESTATE_NAV_COMMIT_DELAY_MS);
  }

  /** @returns Whether a savestate action may run right now (input-ready safe boundary). */
  private canTriggerSavestate(): boolean {
    // Only act while a phase is blocked waiting for player input (no animations in flight)
    const safeModes = [
      UiMode.COMMAND,
      UiMode.FIGHT,
      UiMode.BALL,
      UiMode.TARGET_SELECT,
      UiMode.MODIFIER_SELECT,
      UiMode.CONFIRM,
    ];
    if (!safeModes.includes(globalScene.ui?.getMode()) || savestateManager.restorePending) {
      return false;
    }
    // The mode is set when a screen *starts* animating in; wait until it accepts input,
    // otherwise tearing it down mid-tween can crash Phaser's game loop
    const handler = globalScene.ui?.getHandler();
    return !(handler instanceof AwaitableUiHandler && !handler["awaitingActionInput"]);
  }

  private clearSavestateNavTimer(): void {
    if (this.savestateNavTimer) {
      clearTimeout(this.savestateNavTimer);
      this.savestateNavTimer = null;
    }
  }

  buttonSpeedChange(up = true): void {
    const settingGameSpeed = settingIndex(SettingKeys.Game_Speed);
    const settingOptions = Setting[settingGameSpeed].options;
    let currentSetting = settingOptions.findIndex(item => item.value === globalScene.gameSpeed.toString());
    // if current setting is -1, then the current game speed is not a valid option, so default to index 1 (3x)
    if (currentSetting === -1) {
      currentSetting = 1;
    }
    let direction: number;
    if (up && globalScene.gameSpeed < 5) {
      direction = 1;
    } else if (!up && globalScene.gameSpeed > 2) {
      direction = -1;
    } else {
      return;
    }
    globalScene.gameData.saveSetting(
      SettingKeys.Game_Speed,
      Phaser.Math.Clamp(currentSetting + direction, 0, settingOptions.length - 1),
    );
    if (globalScene.ui?.getMode() === UiMode.SETTINGS) {
      (globalScene.ui.getHandler() as SettingsUiHandler).show([]);
    }
  }
}
