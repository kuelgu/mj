import { z } from 'zod';
import { readFileSync } from 'fs';
import { resolve } from 'path';

/**
 * Multiple ron mode configuration
 */
export const MultipleRonModeSchema = z.enum([
  'allow_up_to_3',  // Allow up to 3 players to ron on the same discard
  'allow_double',   // Only allow 2 players (double ron)
  'head_bump'       // Head bump (atamahane) - only the closest player wins
]);

export type MultipleRonMode = z.infer<typeof MultipleRonModeSchema>;

/**
 * Riichi bet distribution mode for multiple ron
 */
export const RiichiBetDistributionSchema = z.enum([
  'seat_order_nearest_to_discarder',  // Closest player in seat order gets all riichi bets
  'split_equally',                     // Split riichi bets equally among winners
  'to_next_dealer'                     // All riichi bets go to next dealer
]);

export type RiichiBetDistribution = z.infer<typeof RiichiBetDistributionSchema>;

/**
 * Multiple ron configuration
 */
export const MultipleRonConfigSchema = z.object({
  mode: MultipleRonModeSchema,
  atamahane: z.boolean(),
  riichiBetDistribution: RiichiBetDistributionSchema
});

export type MultipleRonConfig = z.infer<typeof MultipleRonConfigSchema>;

/**
 * Kazoe yakuman mode
 */
export const KazoeYakumanModeSchema = z.enum([
  'yakuman',       // 13+ han counts as yakuman
  'limit',         // 13+ han counts as sanbaiman (limit)
  'unlimited'      // Count actual han value beyond 13
]);

export type KazoeYakumanMode = z.infer<typeof KazoeYakumanModeSchema>;

/**
 * Scoring configuration
 */
export const ScoringConfigSchema = z.object({
  kiriageMangan: z.boolean(),           // Round up 4-han 30-fu and 3-han 60-fu to mangan
  kazoeYakuman: KazoeYakumanModeSchema
});

export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;

/**
 * Pao payment style
 */
export const PaoPaymentStyleSchema = z.enum([
  'full',                           // Pao player pays full amount
  'split',                          // Pao player splits payment with discarder
  'configurable_full_or_split'      // Can be configured per yakuman
]);

export type PaoPaymentStyle = z.infer<typeof PaoPaymentStyleSchema>;

/**
 * Yakuman that can trigger pao
 */
export const PaoYakumanSchema = z.enum([
  'daisangen',              // Big three dragons
  'daisuushi',              // Big four winds
  'shousuushi',             // Little four winds
  'tsuuiisou',              // All honors
  'tsuuiisou_optional',     // All honors (optional in rules)
  'suukantsu',              // Four kans
  'suukantsu_optional'      // Four kans (optional in rules)
]);

export type PaoYakuman = z.infer<typeof PaoYakumanSchema>;

/**
 * Pao (責任払い) configuration
 */
export const PaoConfigSchema = z.object({
  enabled: z.boolean(),
  paymentStyle: PaoPaymentStyleSchema,
  applyTo: z.array(PaoYakumanSchema)
});

export type PaoConfig = z.infer<typeof PaoConfigSchema>;

/**
 * Nagashi mangan (流し満貫) configuration
 */
export const NagashiManganConfigSchema = z.object({
  enabled: z.boolean(),
  treatAsWin: z.boolean()  // If true, treat as win (ends round); if false, draw
});

export type NagashiManganConfig = z.infer<typeof NagashiManganConfigSchema>;

/**
 * Game variant
 */
export const GameVariantSchema = z.enum([
  'riichi-4p',    // 4-player riichi mahjong
  'riichi-3p'     // 3-player riichi mahjong
]);

export type GameVariant = z.infer<typeof GameVariantSchema>;

/**
 * Complete rule configuration schema
 */
export const RuleConfigSchema = z.object({
  variant: GameVariantSchema,
  multipleRon: MultipleRonConfigSchema,
  scoring: ScoringConfigSchema,
  pao: PaoConfigSchema,
  nagashiMangan: NagashiManganConfigSchema
});

export type RuleConfig = z.infer<typeof RuleConfigSchema>;

/**
 * Load and validate rule configuration from JSON file
 * @param filePath Path to the rule configuration file
 * @throws {Error} If file cannot be read or validation fails
 * @returns Validated RuleConfig
 */
export function loadRuleConfig(filePath: string): RuleConfig {
  try {
    const absolutePath = resolve(filePath);
    const fileContent = readFileSync(absolutePath, 'utf-8');
    const jsonData = JSON.parse(fileContent);

    // Validate and parse with Zod
    const config = RuleConfigSchema.parse(jsonData);

    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      const messages = error.errors.map(e => `  - ${e.path.join('.')}: ${e.message}`).join('\n');
      throw new Error(`Rule configuration validation failed:\n${messages}`);
    }
    throw error;
  }
}

/**
 * Validate rule configuration object
 * @param config Configuration object to validate
 * @returns True if valid, throws error otherwise
 */
export function validateRuleConfig(config: unknown): config is RuleConfig {
  RuleConfigSchema.parse(config);
  return true;
}

/**
 * Get default rule configuration file path
 */
export function getDefaultRuleConfigPath(): string {
  return resolve(process.cwd(), 'rules/default.rule.json');
}
