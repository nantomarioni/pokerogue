import { loggedInUser } from "#app/account";
import { EvolutionItem } from "#balance/pokemon-evolutions";
import { tmPoolTiers } from "#balance/tm-pool-tiers";
import { allMoves } from "#data/data-lists";
import { BerryType } from "#enums/berry-type";
import { FormChangeItem } from "#enums/form-change-item";
import { ModifierPoolType } from "#enums/modifier-pool-type";
import { ModifierTier } from "#enums/modifier-tier";
import { Nature } from "#enums/nature";
import { PokemonType } from "#enums/pokemon-type";
import { PERMANENT_STATS, TEMP_BATTLE_STATS } from "#enums/stat";
import {
  AttackTypeBoosterModifierType,
  BaseStatBoosterModifierType,
  BerryModifierType,
  EvolutionItemModifierType,
  FormChangeItemModifierType,
  type ModifierType,
  ModifierTypeGenerator,
  PokemonNatureChangeModifierType,
  SpeciesStatBoosterModifierType,
  TempStatStageBoosterModifierType,
  TerastallizeModifierType,
  TmModifierType,
} from "#modifiers/modifier-type";
import { getEnumValues } from "#utils/enums";
import { getModifierPoolForType } from "#utils/modifier-utils";

/**
 * Stable identity key for a (possibly generated) {@linkcode ModifierType}.
 *
 * `ModifierType.id` alone is not unique: all TMs share `TM_<tier>`, all berries share
 * `BERRY`, etc. Generated types carry their discriminator (moveId/berryType/stat/...),
 * which is folded into the key. Prefixes are deliberately independent of the generator
 * id so e.g. an item from `RARE_EVOLUTION_ITEM` matches the same wanted entry as one
 * from `EVOLUTION_ITEM`.
 */
export function getWantedItemKey(type: ModifierType): string {
  if (type instanceof TmModifierType) {
    return `TM:${type.moveId}`;
  }
  if (type instanceof BerryModifierType) {
    return `BERRY:${type.getPregenArgs()[0]}`;
  }
  if (type instanceof TempStatStageBoosterModifierType) {
    return `TEMP_STAT:${type.getPregenArgs()[0]}`;
  }
  if (type instanceof AttackTypeBoosterModifierType) {
    return `ATTACK_TYPE:${type.getPregenArgs()[0]}`;
  }
  if (type instanceof BaseStatBoosterModifierType) {
    return `BASE_STAT:${type.getPregenArgs()[0]}`;
  }
  if (type instanceof SpeciesStatBoosterModifierType) {
    return `SPECIES_BOOST:${type.key}`;
  }
  if (type instanceof EvolutionItemModifierType) {
    return `EVO_ITEM:${type.getPregenArgs()[0]}`;
  }
  if (type instanceof FormChangeItemModifierType) {
    return `FORM_CHANGE:${type.getPregenArgs()[0]}`;
  }
  if (type instanceof TerastallizeModifierType) {
    return `TERA_SHARD:${type.getPregenArgs()[0]}`;
  }
  if (type instanceof PokemonNatureChangeModifierType) {
    return `MINT:${type["nature"]}`;
  }
  return type.id;
}

export interface WantedCatalogEntry {
  key: string;
  /** Localized display name */
  label: string;
  category: string;
}

/** Pregen-arg expansions for the parameterized generators found in the player pool. */
const GENERATOR_EXPANSIONS: Record<string, { category: string; args: () => (number | string)[] }> = {
  TM_COMMON: { category: "TMs (Common)", args: () => tmMovesForTier(ModifierTier.COMMON) },
  TM_GREAT: { category: "TMs (Great)", args: () => tmMovesForTier(ModifierTier.GREAT) },
  TM_ULTRA: { category: "TMs (Ultra)", args: () => tmMovesForTier(ModifierTier.ULTRA) },
  BERRY: { category: "Berries", args: () => getEnumValues(BerryType) },
  TEMP_STAT_STAGE_BOOSTER: { category: "Battle Items", args: () => [...TEMP_BATTLE_STATS] },
  BASE_STAT_BOOSTER: { category: "Vitamins", args: () => [...PERMANENT_STATS] },
  ATTACK_TYPE_BOOSTER: {
    category: "Type Boosters",
    args: () => getEnumValues(PokemonType).filter(t => t !== PokemonType.UNKNOWN && t !== PokemonType.STELLAR),
  },
  MINT: { category: "Mints", args: () => getEnumValues(Nature) },
  TERA_SHARD: {
    category: "Tera Shards",
    args: () => getEnumValues(PokemonType).filter(t => t !== PokemonType.UNKNOWN),
  },
  EVOLUTION_ITEM: { category: "Evolution Items", args: () => getEnumValues(EvolutionItem).filter(i => i !== 0) },
  RARE_EVOLUTION_ITEM: {
    category: "Evolution Items",
    args: () => getEnumValues(EvolutionItem).filter(i => i !== 0),
  },
  SPECIES_STAT_BOOSTER: {
    category: "Species Items",
    args: () => ["LIGHT_BALL", "THICK_CLUB", "METAL_POWDER", "QUICK_POWDER", "DEEP_SEA_SCALE", "DEEP_SEA_TOOTH"],
  },
  RARE_SPECIES_STAT_BOOSTER: {
    category: "Species Items",
    args: () => ["LIGHT_BALL", "THICK_CLUB", "METAL_POWDER", "QUICK_POWDER"],
  },
  FORM_CHANGE_ITEM: {
    category: "Form Change Items",
    args: () => getEnumValues(FormChangeItem).filter(i => i !== FormChangeItem.NONE),
  },
};

function tmMovesForTier(tier: ModifierTier): number[] {
  return Object.entries(tmPoolTiers)
    .filter(([, t]) => t === tier)
    .map(([moveId]) => Number(moveId))
    .filter(moveId => !allMoves[moveId].name.endsWith(" (N)"));
}

function tierCategory(tier: ModifierTier): string {
  return `Items (${ModifierTier[tier][0]}${ModifierTier[tier].slice(1).toLowerCase()})`;
}

/**
 * Enumerate every item the player reward pool can produce, as checklist entries.
 * Built lazily: the pool and i18n must be initialized first.
 */
export function buildWantedCatalog(): WantedCatalogEntry[] {
  const pool = getModifierPoolForType(ModifierPoolType.PLAYER);

  const entries: WantedCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const tierStr of Object.keys(pool)) {
    const tier = Number(tierStr) as ModifierTier;
    for (const weighted of pool[tier]) {
      const modifierType = weighted.modifierType;
      if (modifierType instanceof ModifierTypeGenerator) {
        const expansion = GENERATOR_EXPANSIONS[modifierType.id];
        if (!expansion) {
          continue;
        }
        for (const arg of expansion.args()) {
          const generated = modifierType.generateType([], [arg]);
          if (!generated) {
            continue;
          }
          const key = getWantedItemKey(generated);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          entries.push({ key, label: generated.name, category: expansion.category });
        }
      } else {
        const key = getWantedItemKey(modifierType);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        entries.push({ key, label: modifierType.name, category: tierCategory(tier) });
      }
    }
  }
  return entries;
}

/** @returns The catalog grouped by category, preserving catalog order. */
export function buildWantedCatalogByCategory(): Map<string, WantedCatalogEntry[]> {
  const grouped = new Map<string, WantedCatalogEntry[]>();
  for (const entry of buildWantedCatalog()) {
    const list = grouped.get(entry.category) ?? [];
    list.push(entry);
    grouped.set(entry.category, list);
  }
  return grouped;
}

function getWantedItemsLocalStorageKey(): string {
  return `wantedItems_${loggedInUser?.username}`;
}

/**
 * The player's persisted wanted-item list (checked entries of the catalog).
 * Plain JSON in localStorage, per user — purely a client-side convenience.
 */
class WantedItemsConfig {
  private keys: Set<string> | null = null;

  private load(): Set<string> {
    if (this.keys) {
      return this.keys;
    }
    try {
      const raw = localStorage.getItem(getWantedItemsLocalStorageKey());
      this.keys = new Set(raw ? (JSON.parse(raw) as string[]) : []);
    } catch (err) {
      console.warn("Failed to load wanted items:", err);
      this.keys = new Set();
    }
    return this.keys;
  }

  private save(): void {
    try {
      localStorage.setItem(getWantedItemsLocalStorageKey(), JSON.stringify([...this.load()]));
    } catch (err) {
      console.warn("Failed to persist wanted items:", err);
    }
  }

  public get size(): number {
    return this.load().size;
  }

  public has(key: string): boolean {
    return this.load().has(key);
  }

  public getAll(): string[] {
    return [...this.load()];
  }

  /** @returns The new checked state */
  public toggle(key: string): boolean {
    const keys = this.load();
    if (keys.has(key)) {
      keys.delete(key);
    } else {
      keys.add(key);
    }
    this.save();
    return keys.has(key);
  }

  /** Drop the memory cache (e.g. after a user switch) so the next read reloads. */
  public invalidate(): void {
    this.keys = null;
  }
}

export const wantedItems = new WantedItemsConfig();
