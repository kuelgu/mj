import { Wind } from './game-state.js';
import { TileInstance } from './tiles.js';

/**
 * Yaku (役) types
 */
export type YakuType =
  // 1 Han
  | 'riichi'
  | 'ippatsu'
  | 'tsumo'
  | 'tanyao'
  | 'pinfu'
  | 'iipeikou'
  | 'bakaze'      // Prevailing wind
  | 'jikaze'      // Seat wind
  | 'haku'        // White dragon
  | 'hatsu'       // Green dragon
  | 'chun'        // Red dragon
  | 'rinshan'     // After kan
  | 'chankan'     // Robbing kan
  | 'haitei'      // Last tile from wall
  | 'houtei'      // Last discard
  // 2 Han
  | 'double_riichi'
  | 'sanshoku_doujun'
  | 'ittsu'
  | 'chanta'
  | 'chitoitsu'
  | 'toitoi'
  | 'sanankou'
  | 'sanshoku_doukou'
  | 'sankantsu'
  | 'honroutou'
  | 'shousangen'
  // 3 Han
  | 'honitsu'
  | 'junchanta'
  | 'ryanpeikou'
  // 6 Han
  | 'chinitsu'
  // Yakuman
  | 'kokushi'         // Thirteen orphans
  | 'suuankou'        // Four concealed triplets
  | 'daisangen'       // Big three dragons
  | 'shousuushi'      // Little four winds
  | 'daisuushi'       // Big four winds
  | 'tsuuiisou'       // All honors
  | 'chinroutou'      // All terminals
  | 'ryuuiisou'       // All green
  | 'chuuren'         // Nine gates
  | 'suukantsu'       // Four kans
  | 'tenhou'          // Heavenly hand (dealer)
  | 'chiihou';        // Earthly hand (non-dealer)

/**
 * Yaku definition
 */
export interface Yaku {
  type: YakuType;
  han: number;
  isYakuman: boolean;
}

/**
 * Hand pattern (mentsu + jantou)
 */
export interface HandPattern {
  melds: TileSet[];
  pair: TileSet;
  isChitoitsu: boolean;
  isKokushi: boolean;
}

/**
 * Tile set (mentsu or pair)
 */
export interface TileSet {
  type: 'shuntsu' | 'koutsu' | 'kantsu' | 'jantou';
  tiles: TileInstance[];
  isConcealed: boolean;
}

/**
 * Hand evaluation result
 */
export interface HandEvaluation {
  isWinningHand: boolean;
  patterns: HandPattern[];
  yaku: Yaku[];
  han: number;
  fu: number;
  yakuman: number;
  dora: number;
  uraDora: number;
  akaDora: number;
}

/**
 * Score calculation result
 */
export interface ScoreCalculation {
  hand: HandEvaluation;
  basicPoints: number;  // Base points (符)
  han: number;          // Total han
  fu: number;           // Fu
  score: number;        // Final score
  dealerScore?: {       // Dealer payment amounts
    tsumo: number;
    ron: number;
  };
  nonDealerScore?: {    // Non-dealer payment amounts
    tsumo: number;      // Payment from each player
    tsumoFromDealer: number;  // Payment from dealer specifically
    ron: number;
  };
  isKiriageMangan: boolean;
  isKazoeYakuman: boolean;
  limitName?: 'mangan' | 'haneman' | 'baiman' | 'sanbaiman' | 'yakuman' | 'double_yakuman' | 'triple_yakuman';
}

/**
 * Payment structure for a single win
 */
export interface WinPayment {
  winner: Wind;
  winType: 'tsumo' | 'ron';
  fromPlayer?: Wind;    // For ron
  payments: Record<Wind, number>;  // How much each player pays (negative) or receives (positive)
  honba: number;        // Honba counter
  riichiSticksWon: number;
  paoPlayer?: Wind;     // If pao applies
  paoPaymentStyle?: 'full' | 'split';
}

/**
 * Round result
 */
export interface RoundResult {
  type: 'win' | 'draw' | 'nagashi_mangan';
  wins: WinPayment[];   // Can be multiple for multiple ron
  scoreChanges: Record<Wind, number>;  // Net score change for each player
  newHonba: number;
  newRiichiSticks: number;
  dealerContinues: boolean;
  drawType?: string;
}

/**
 * Pao information
 */
export interface PaoInfo {
  responsiblePlayer: Wind;
  yakumanType: YakuType;
  paymentStyle: 'full' | 'split';
}
