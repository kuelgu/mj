import { GameState, GamePhase, Wind, DrawType } from '../types/game-state.js';
import { RuleConfig } from '../config/rule-config.js';
import { TileInstance } from '../types/tiles.js';

/**
 * Round state machine events
 */
export type RoundEvent =
  | { type: 'ROUND_START' }
  | { type: 'DEAL_COMPLETE' }
  | { type: 'DRAW_TILE'; player: Wind }
  | { type: 'DISCARD'; player: Wind; tile: TileInstance }
  | { type: 'CHI'; player: Wind; tile: TileInstance }
  | { type: 'PON'; player: Wind; tile: TileInstance }
  | { type: 'KAN'; player: Wind; tile: TileInstance }
  | { type: 'RIICHI_DECLARE'; player: Wind }
  | { type: 'RIICHI_ACCEPTED'; player: Wind }
  | { type: 'RON_DECLARE'; player: Wind; tile: TileInstance }
  | { type: 'TSUMO_DECLARE'; player: Wind; tile: TileInstance }
  | { type: 'NAGASHI_MANGAN'; player: Wind }
  | { type: 'EXHAUSTIVE_DRAW'; drawType: DrawType }
  | { type: 'MULTIPLE_RON_RESOLVED'; winners: Wind[] }
  | { type: 'SCORING_COMPLETE' }
  | { type: 'ROUND_END' };

/**
 * State machine transition result
 */
export interface TransitionResult {
  newState: GameState;
  newPhase: GamePhase;
  events: string[];  // Log of what happened
  branchingPoint?: BranchingPoint;
}

/**
 * Branching points in the state machine
 * These represent decision points where special rules apply
 */
export type BranchingPoint =
  | 'MULTIPLE_RON_CHECK'           // Check if multiple players can ron
  | 'RIICHI_BET_DISTRIBUTION'      // Distribute riichi bets (multiple ron)
  | 'PAO_CHECK'                    // Check if pao applies
  | 'PAO_PAYMENT_CALCULATION'      // Calculate pao payments
  | 'KIRIAGE_MANGAN_CHECK'         // Check for kiriage mangan
  | 'KAZOE_YAKUMAN_CHECK'          // Check for kazoe yakuman
  | 'NAGASHI_MANGAN_CHECK'         // Check for nagashi mangan
  | 'EXHAUSTIVE_DRAW_CHECK'        // Check for exhaustive draw conditions
  | 'ABORTIVE_DRAW_CHECK'          // Check for abortive draw (四風連打, etc.)
  | 'HONBA_UPDATE'                 // Update honba counter
  | 'DEALER_ROTATION';             // Determine if dealer continues

/**
 * Round state machine
 * Manages the flow of a single round with all branching points
 */
export class RoundStateMachine {
  constructor(
    private rules: RuleConfig,
    private state: GameState
  ) {}

  /**
   * Get current state
   */
  getState(): GameState {
    return this.state;
  }

  /**
   * Process an event and transition to new state
   */
  transition(event: RoundEvent): TransitionResult {
    const events: string[] = [];

    switch (this.state.phase) {
      case 'waiting':
        return this.handleWaiting(event, events);

      case 'dealing':
        return this.handleDealing(event, events);

      case 'playing':
        return this.handlePlaying(event, events);

      case 'ron_declared':
        return this.handleRonDeclared(event, events);

      case 'tsumo_declared':
        return this.handleTsumoDeclared(event, events);

      case 'draw':
        return this.handleDraw(event, events);

      case 'scoring':
        return this.handleScoring(event, events);

      case 'round_end':
        return this.handleRoundEnd(event, events);

      default:
        throw new Error(`Unknown phase: ${this.state.phase}`);
    }
  }

  /**
   * Handle waiting phase
   */
  private handleWaiting(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'ROUND_START') {
      events.push('Round starting');
      return {
        newState: this.state,
        newPhase: 'dealing',
        events
      };
    }
    throw new Error(`Invalid event ${event.type} in waiting phase`);
  }

  /**
   * Handle dealing phase
   */
  private handleDealing(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'DEAL_COMPLETE') {
      events.push('Dealing complete');
      return {
        newState: this.state,
        newPhase: 'playing',
        events
      };
    }
    throw new Error(`Invalid event ${event.type} in dealing phase`);
  }

  /**
   * Handle playing phase
   * BRANCHING POINTS:
   * - MULTIPLE_RON_CHECK: When ron is declared
   * - NAGASHI_MANGAN_CHECK: At exhaustive draw
   * - ABORTIVE_DRAW_CHECK: During play
   */
  private handlePlaying(event: RoundEvent, events: string[]): TransitionResult {
    switch (event.type) {
      case 'DRAW_TILE':
        events.push(`${event.player} drew a tile`);
        return { newState: this.state, newPhase: 'playing', events };

      case 'DISCARD':
        events.push(`${event.player} discarded ${event.tile.id}`);
        // Check for nagashi mangan at end of round
        if (this.isExhaustiveDraw()) {
          return {
            newState: this.state,
            newPhase: 'draw',
            events,
            branchingPoint: 'NAGASHI_MANGAN_CHECK'
          };
        }
        return { newState: this.state, newPhase: 'playing', events };

      case 'RON_DECLARE':
        events.push(`${event.player} declared ron`);
        // BRANCHING POINT: Check for multiple ron
        return {
          newState: this.state,
          newPhase: 'ron_declared',
          events,
          branchingPoint: 'MULTIPLE_RON_CHECK'
        };

      case 'TSUMO_DECLARE':
        events.push(`${event.player} declared tsumo`);
        return {
          newState: this.state,
          newPhase: 'tsumo_declared',
          events
        };

      default:
        return { newState: this.state, newPhase: 'playing', events };
    }
  }

  /**
   * Handle ron declared phase
   * BRANCHING POINTS:
   * - MULTIPLE_RON_CHECK: Already triggered
   * - RIICHI_BET_DISTRIBUTION: If multiple ron
   * - PAO_CHECK: Check if pao applies to any winner
   */
  private handleRonDeclared(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'MULTIPLE_RON_RESOLVED') {
      events.push(`Multiple ron resolved: ${event.winners.join(', ')}`);

      // BRANCHING POINT: Distribute riichi bets for multiple ron
      const branchingPoint: BranchingPoint = event.winners.length > 1
        ? 'RIICHI_BET_DISTRIBUTION'
        : 'PAO_CHECK';

      return {
        newState: this.state,
        newPhase: 'scoring',
        events,
        branchingPoint
      };
    }
    throw new Error(`Invalid event ${event.type} in ron_declared phase`);
  }

  /**
   * Handle tsumo declared phase
   * BRANCHING POINTS:
   * - PAO_CHECK: Check if pao applies
   */
  private handleTsumoDeclared(_event: RoundEvent, events: string[]): TransitionResult {
    events.push('Proceeding to scoring');
    return {
      newState: this.state,
      newPhase: 'scoring',
      events,
      branchingPoint: 'PAO_CHECK'
    };
  }

  /**
   * Handle draw phase
   * BRANCHING POINTS:
   * - NAGASHI_MANGAN_CHECK: Check for nagashi mangan
   */
  private handleDraw(_event: RoundEvent, events: string[]): TransitionResult {
    // Check for nagashi mangan
    const nagashiPlayers = this.checkNagashiMangan();
    if (nagashiPlayers.length > 0 && this.rules.nagashiMangan.enabled) {
      events.push(`Nagashi mangan by: ${nagashiPlayers.join(', ')}`);
      if (this.rules.nagashiMangan.treatAsWin) {
        // Treat as win - go to scoring
        return {
          newState: this.state,
          newPhase: 'scoring',
          events,
          branchingPoint: 'NAGASHI_MANGAN_CHECK'
        };
      }
    }

    events.push('Round ended in draw');
    return {
      newState: this.state,
      newPhase: 'round_end',
      events,
      branchingPoint: 'HONBA_UPDATE'
    };
  }

  /**
   * Handle scoring phase
   * BRANCHING POINTS:
   * - PAO_PAYMENT_CALCULATION: If pao applies
   * - KIRIAGE_MANGAN_CHECK: Check for kiriage mangan
   * - KAZOE_YAKUMAN_CHECK: Check for kazoe yakuman
   */
  private handleScoring(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'SCORING_COMPLETE') {
      events.push('Scoring complete');
      return {
        newState: this.state,
        newPhase: 'round_end',
        events,
        branchingPoint: 'DEALER_ROTATION'
      };
    }
    throw new Error(`Invalid event ${event.type} in scoring phase`);
  }

  /**
   * Handle round end phase
   * BRANCHING POINTS:
   * - DEALER_ROTATION: Determine if dealer continues
   * - HONBA_UPDATE: Update honba counter
   */
  private handleRoundEnd(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'ROUND_END') {
      events.push('Round ended');
      return {
        newState: this.state,
        newPhase: 'waiting',
        events
      };
    }
    throw new Error(`Invalid event ${event.type} in round_end phase`);
  }

  /**
   * Check if exhaustive draw (wall exhausted)
   */
  private isExhaustiveDraw(): boolean {
    // 14 tiles must remain in dead wall (dora indicators + rinshan tiles)
    return this.state.wall.length === 0;
  }

  /**
   * Check for nagashi mangan
   * Returns players who achieved nagashi mangan
   */
  private checkNagashiMangan(): Wind[] {
    if (!this.rules.nagashiMangan.enabled) {
      return [];
    }

    const nagashiPlayers: Wind[] = [];

    for (const player of this.state.players) {
      // Check if all discards are terminals/honors and not called by anyone
      const isNagashi = this.isNagashiManganValid(player.discards);
      if (isNagashi) {
        nagashiPlayers.push(player.seat);
      }
    }

    return nagashiPlayers;
  }

  /**
   * Check if discards form valid nagashi mangan
   */
  private isNagashiManganValid(discards: TileInstance[]): boolean {
    // All discards must be terminals or honors
    return discards.every(tile => {
      if (tile.suit === 'honor') return true;
      return tile.rank === 1 || tile.rank === 9;
    });
    // Note: In real implementation, also need to check that none were called
  }
}

/**
 * Branching point documentation
 * This serves as the "map" of all decision points in the state machine
 */
export const BRANCHING_POINTS_DOCUMENTATION = {
  MULTIPLE_RON_CHECK: {
    description: 'Check if multiple players declared ron on the same discard',
    triggers: ['RON_DECLARE event'],
    rules: ['multipleRon.mode', 'multipleRon.atamahane'],
    outcomes: [
      'Single ron - proceed to PAO_CHECK',
      'Double ron - proceed to RIICHI_BET_DISTRIBUTION',
      'Triple ron - proceed to RIICHI_BET_DISTRIBUTION or abort if not allowed'
    ]
  },

  RIICHI_BET_DISTRIBUTION: {
    description: 'Distribute riichi bets on table when multiple players win',
    triggers: ['Multiple ron resolved'],
    rules: ['multipleRon.riichiBetDistribution'],
    outcomes: [
      'seat_order_nearest_to_discarder: Closest player gets all',
      'split_equally: Split among winners',
      'to_next_dealer: All go to next dealer'
    ]
  },

  PAO_CHECK: {
    description: 'Check if pao (responsibility payment) applies to the winning hand',
    triggers: ['Winning hand contains specific yakuman'],
    rules: ['pao.enabled', 'pao.applyTo'],
    outcomes: [
      'No pao: Normal payment calculation',
      'Pao applies: Proceed to PAO_PAYMENT_CALCULATION'
    ]
  },

  PAO_PAYMENT_CALCULATION: {
    description: 'Calculate payment when pao applies',
    triggers: ['Pao check passed'],
    rules: ['pao.paymentStyle'],
    outcomes: [
      'full: Pao player pays full amount',
      'split: Pao player splits with discarder',
      'configurable_full_or_split: Depends on specific yakuman'
    ]
  },

  KIRIAGE_MANGAN_CHECK: {
    description: 'Check if hand qualifies for kiriage mangan (round up to mangan)',
    triggers: ['Scoring calculation'],
    rules: ['scoring.kiriageMangan'],
    outcomes: [
      '4 han 30 fu → mangan (if enabled)',
      '3 han 60 fu → mangan (if enabled)',
      'Otherwise: Use normal score table'
    ]
  },

  KAZOE_YAKUMAN_CHECK: {
    description: 'Check if 13+ han counts as yakuman',
    triggers: ['Scoring calculation with 13+ han'],
    rules: ['scoring.kazoeYakuman'],
    outcomes: [
      'yakuman: Treat as yakuman',
      'limit: Treat as sanbaiman',
      'unlimited: Count actual han value'
    ]
  },

  NAGASHI_MANGAN_CHECK: {
    description: 'Check if any player achieved nagashi mangan at exhaustive draw',
    triggers: ['Exhaustive draw'],
    rules: ['nagashiMangan.enabled', 'nagashiMangan.treatAsWin'],
    outcomes: [
      'Not enabled: Normal draw',
      'Enabled + treatAsWin=true: Score as win, end round',
      'Enabled + treatAsWin=false: Score as draw'
    ]
  },

  EXHAUSTIVE_DRAW_CHECK: {
    description: 'Check if round ends in exhaustive draw (wall exhausted)',
    triggers: ['Wall empty (14 tiles remain in dead wall)'],
    outcomes: [
      'Proceed to NAGASHI_MANGAN_CHECK',
      'Then to draw or win scoring'
    ]
  },

  ABORTIVE_DRAW_CHECK: {
    description: 'Check for abortive draw conditions during play',
    triggers: ['Special conditions during play'],
    conditions: [
      'Four identical wind discards (四風連打)',
      'Four riichi declarations (四家立直)',
      'Four kans by different players (四槓散了)',
      'Nine different terminals/honors in starting hand (九種九牌)'
    ],
    outcomes: [
      'Abortive draw: End round immediately',
      'Continue play'
    ]
  },

  HONBA_UPDATE: {
    description: 'Update honba (repeat) counter after round ends',
    triggers: ['Round end'],
    outcomes: [
      'Dealer wins or draw: Increment honba',
      'Non-dealer wins: Reset honba to 0'
    ]
  },

  DEALER_ROTATION: {
    description: 'Determine if dealer seat rotates',
    triggers: ['Round end'],
    outcomes: [
      'Dealer wins or tenpai at draw: Dealer continues',
      'Non-dealer wins or dealer not tenpai: Rotate dealer'
    ]
  }
};
