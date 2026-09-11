import { TileInstance } from './tiles.js';

/**
 * Player seat/wind position
 */
export type Wind = 'east' | 'south' | 'west' | 'north';

/**
 * Player ID
 */
export type PlayerId = string;

/**
 * Player state
 */
export interface PlayerState {
  id: PlayerId;
  seat: Wind;
  score: number;
  hand: TileInstance[];
  discards: TileInstance[];
  melds: Meld[];
  riichi: RiichiState;
  furiten: boolean;
  isDealer: boolean;
}

/**
 * Riichi state
 */
export interface RiichiState {
  declared: boolean;
  ippatsu: boolean;      // First turn after riichi
  doubleRiichi: boolean; // Riichi on first turn
  turn: number | null;   // Turn number when riichi was declared
  discardIndex?: number | null; // Personal discard index of the riichi declaration tile
}

/**
 * Meld type
 */
export type MeldType = 'chi' | 'pon' | 'kan' | 'ankan' | 'kakan';

/**
 * Meld (called set)
 */
export interface Meld {
  type: MeldType;
  tiles: TileInstance[];
  calledFrom?: Wind;  // Which player the tile was called from
  kakanTile?: TileInstance;  // For promoted kan (kakan)
}

/**
 * Round wind
 */
export type RoundWind = 'east' | 'south' | 'west' | 'north';

/**
 * Round number (局)
 */
export interface Round {
  wind: RoundWind;
  number: number;  // 1-4 for each wind
}

/**
 * Draw result type
 */
export type DrawType =
  | 'wall_exhausted'      // Normal exhaustive draw
  | 'nine_terminals'      // Nine different terminals/honors (九種九牌)
  | 'four_riichi'         // Four players riichi (四家立直)
  | 'four_kan'            // Four kans by different players (四槓散了)
  | 'four_wind'           // Four identical wind discards (四風連打)
  | 'triple_ron';         // Three players ron (三家和)

/**
 * Game phase
 */
export type GamePhase =
  | 'waiting'         // Waiting for players
  | 'dealing'         // Dealing tiles
  | 'playing'         // Normal play
  | 'ron_declared'    // Ron has been declared
  | 'tsumo_declared'  // Tsumo has been declared
  | 'draw'            // Draw
  | 'scoring'         // Calculating scores
  | 'round_end'       // Round ended
  | 'game_end';       // Game ended

/**
 * Action type
 */
export type ActionType =
  | 'draw'
  | 'discard'
  | 'chi'
  | 'pon'
  | 'kan'
  | 'ankan'
  | 'kakan'
  | 'riichi'
  | 'tsumo'
  | 'ron'
  | 'kyuushu_kyuuhai';  // Nine terminals abort

/**
 * Game state
 */
export interface GameState {
  // Game configuration
  ruleConfigPath: string;

  // Round information
  round: Round;
  honba: number;        // Repeat counter (本場)
  riichiSticks: number; // Riichi bet sticks on table (供託)

  // Players
  players: PlayerState[];

  // Wall and dora
  wall: TileInstance[];
  deadWall: TileInstance[];
  doraIndicators: TileInstance[];
  uraDoraIndicators: TileInstance[];

  // Current turn
  currentTurn: number;
  currentPlayer: Wind;
  lastDiscard: TileInstance | null;

  // Game phase
  phase: GamePhase;

  // Pending actions (for multiple ron, etc.)
  pendingActions: PendingAction[];

  // History
  actionHistory: GameAction[];
}

/**
 * Pending action (e.g., multiple players can ron)
 */
export interface PendingAction {
  player: Wind;
  actionType: ActionType;
  tile?: TileInstance;
}

/**
 * Game action (for history and replay)
 */
export interface GameAction {
  turn: number;
  player: Wind;
  actionType: ActionType;
  tile?: TileInstance;
  meld?: Meld;
  timestamp: number;
}

/**
 * Win declaration
 */
export interface WinDeclaration {
  player: Wind;
  isTsumo: boolean;
  winningTile: TileInstance;
  fromPlayer?: Wind;  // For ron
}

/**
 * Nagashi mangan declaration
 */
export interface NagashiManganDeclaration {
  player: Wind;
  discards: TileInstance[];
}
