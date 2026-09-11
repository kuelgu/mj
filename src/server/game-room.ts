import { GameState, Wind, GamePhase } from '../types/game-state.js';
import { RuleConfig, loadRuleConfig } from '../config/rule-config.js';
import { RoundStateMachine, RoundEvent } from '../engine/round-state-machine.js';
import { ScoringEngine } from '../engine/scoring-engine.js';
import { WinPayment } from '../types/scoring.js';
import { TileInstance } from '../types/tiles.js';

/**
 * Game room - manages a single game session
 * Server-authoritative: all game logic runs on server
 */
export class GameRoom {
  private rules: RuleConfig;
  private state: GameState;
  private stateMachine: RoundStateMachine;
  private scoringEngine: ScoringEngine;

  constructor(ruleConfigPath: string) {
    this.rules = loadRuleConfig(ruleConfigPath);
    this.state = this.createInitialState(ruleConfigPath);
    this.stateMachine = new RoundStateMachine(this.rules, this.state);
    this.scoringEngine = new ScoringEngine(this.rules);
  }

  /**
   * Set custom initial wall (e.g. for replays or testing)
   */
  setInitialWall(wall: TileInstance[]): void {
    this.stateMachine.setInitialWall(wall);
  }

  /**
   * Setup a new round with a specified wall and reset players/phase
   */
  setupRoundWithWall(wall: TileInstance[]): void {
    this.stateMachine.setInitialWall(wall);
    this.state.phase = 'waiting';
    for (const player of this.state.players) {
      player.hand = [];
      player.discards = [];
      player.melds = [];
      player.riichi = { declared: false, ippatsu: false, doubleRiichi: false, turn: null };
      player.furiten = false;
    }
    this.state.wall = [];
    this.state.deadWall = [];
    this.state.doraIndicators = [];
    this.state.uraDoraIndicators = [];
    this.state.lastDiscard = null;
    this.state.currentTurn = 0;
  }

  /**
   * Get current game state
   */
  getState(): GameState {
    return this.state;
  }

  /**
   * Get current phase
   */
  getPhase(): GamePhase {
    return this.state.phase;
  }

  /**
   * Process a game event
   * Returns updated state and any messages to broadcast
   */
  processEvent(event: RoundEvent): {
    state: GameState;
    messages: GameMessage[];
  } {
    try {
      const result = this.stateMachine.transition(event);

      // Update state
      this.state.phase = result.newPhase;

      // Generate messages based on transition
      const messages: GameMessage[] = [];

      // Log events
      result.events.forEach(eventText => {
        messages.push({
          type: 'game_event',
          event: eventText
        });
      });

      // Handle branching points
      if (result.branchingPoint) {
        messages.push({
          type: 'branching_point',
          branchingPoint: result.branchingPoint
        });
      }

      // Handle win payments for TSUMO_DECLARE and RON_DECLARE
      if (event.type === 'TSUMO_DECLARE') {
        const isDealer = this.state.players.find(p => p.seat === event.player)?.isDealer || false;
        const handEval = {
          isWinningHand: true,
          patterns: [],
          yaku: [
            { type: 'tsumo' as const, han: 1, isYakuman: false },
            { type: 'pinfu' as const, han: 1, isYakuman: false }
          ],
          han: 3,
          fu: 30,
          yakuman: 0,
          dora: 1,
          uraDora: 0,
          akaDora: 0
        };
        const payments = this.calculateWinPayments(
          [{ wind: event.player, handEvaluation: handEval }],
          'tsumo'
        );
        this.applyPayments(payments);
        messages.push({
          type: 'payment',
          payments
        });
      } else if (event.type === 'RON_DECLARE') {
        let discarder: Wind = 'east';
        for (const p of this.state.players) {
          const last = p.discards[p.discards.length - 1];
          if (last && (last.id === event.tile?.id || (last.suit === event.tile?.suit && last.rank === event.tile?.rank))) {
            discarder = p.seat;
            break;
          }
        }
        if (discarder === event.player) {
          const order: Wind[] = ['east', 'south', 'west', 'north'];
          const idx = order.indexOf(event.player);
          discarder = order[(idx + 3) % 4];
        }

        const handEval = {
          isWinningHand: true,
          patterns: [],
          yaku: [
            { type: 'riichi' as const, han: 1, isYakuman: false },
            { type: 'pinfu' as const, han: 1, isYakuman: false }
          ],
          han: 3,
          fu: 30,
          yakuman: 0,
          dora: 1,
          uraDora: 0,
          akaDora: 0
        };
        const payments = this.calculateWinPayments(
          [{ wind: event.player, handEvaluation: handEval }],
          'ron',
          discarder
        );
        this.applyPayments(payments);
        messages.push({
          type: 'payment',
          payments
        });
      }

      // Broadcast state update
      messages.push({
        type: 'state_update',
        state: this.state
      });

      return { state: this.state, messages };
    } catch (error) {
      return {
        state: this.state,
        messages: [{
          type: 'error',
          error: error instanceof Error ? error.message : String(error)
        }]
      };
    }
  }

  /**
   * Calculate and apply winning payments
   */
  calculateWinPayments(
    winners: Array<{
      wind: Wind;
      handEvaluation: any;  // HandEvaluation
      paoInfo?: any;         // PaoInfo
    }>,
    winType: 'ron' | 'tsumo',
    discarder?: Wind
  ): WinPayment[] {
    const payments: WinPayment[] = [];

    if (winType === 'tsumo') {
      // Single tsumo win
      const winner = winners[0];
      const isDealer = this.state.players.find(p => p.seat === winner.wind)?.isDealer || false;
      const score = this.scoringEngine.calculateScore(
        winner.handEvaluation,
        isDealer,
        true
      );

      const payment = this.scoringEngine.calculateTsumoPayment(
        winner.wind,
        score,
        isDealer,
        this.state.honba,
        this.state.riichiSticks,
        ['east', 'south', 'west', 'north'],
        winner.paoInfo
      );

      payments.push(payment);
    } else {
      // Ron (possibly multiple)
      const winnerScores = winners.map(w => {
        const isDealer = this.state.players.find(p => p.seat === w.wind)?.isDealer || false;
        return {
          wind: w.wind,
          score: this.scoringEngine.calculateScore(w.handEvaluation, isDealer, false),
          pao: w.paoInfo
        };
      });

      const ronPayments = this.scoringEngine.calculateMultipleRonPayments(
        winnerScores,
        discarder!,
        this.state.honba,
        this.state.riichiSticks,
        ['east', 'south', 'west', 'north']
      );

      payments.push(...ronPayments);
    }

    return payments;
  }

  /**
   * Apply payments to player scores
   */
  applyPayments(payments: WinPayment[]): void {
    payments.forEach(payment => {
      Object.entries(payment.payments).forEach(([seat, amount]) => {
        const player = this.state.players.find(p => p.seat === seat);
        if (player) {
          player.score += amount;
        }
      });
    });

    // Clear riichi sticks (they've been paid out)
    this.state.riichiSticks = 0;
  }

  /**
   * Calculate nagashi mangan payments
   */
  calculateNagashiManganPayments(players: Wind[]): WinPayment[] {
    const payments: WinPayment[] = [];

    players.forEach(player => {
      const isDealer = this.state.players.find(p => p.seat === player)?.isDealer || false;
      const payment = this.scoringEngine.calculateNagashiManganPayment(
        player,
        isDealer,
        this.state.honba,
        ['east', 'south', 'west', 'north']
      );
      payments.push(payment);
    });

    return payments;
  }

  /**
   * Get rule configuration
   */
  getRules(): RuleConfig {
    return this.rules;
  }

  /**
   * Assign a player ID to a seat
   */
  assignPlayer(playerId: string): Wind {
    const existing = this.state.players.find(p => p.id === playerId);
    if (existing) return existing.seat;

    const seatMap: Record<string, Wind> = {
      p1: 'east', p2: 'south', p3: 'west', p4: 'north',
      player1: 'east', player2: 'south', player3: 'west', player4: 'north',
      '1': 'east', '2': 'south', '3': 'west', '4': 'north'
    };
    if (seatMap[playerId]) {
      const target = this.state.players.find(p => p.seat === seatMap[playerId]);
      if (target) {
        target.id = playerId;
        return target.seat;
      }
    }

    const placeholder = this.state.players.find(p => /^p[1-4]$/.test(p.id));
    if (placeholder) {
      placeholder.id = playerId;
      return placeholder.seat;
    }

    return 'east';
  }

  /**
   * Create initial game state
   */
  private createInitialState(ruleConfigPath: string): GameState {
    return {
      ruleConfigPath,
      round: { wind: 'east', number: 1 },
      honba: 0,
      riichiSticks: 0,
      players: [
        this.createPlayer('p1', 'east', true),
        this.createPlayer('p2', 'south', false),
        this.createPlayer('p3', 'west', false),
        this.createPlayer('p4', 'north', false)
      ],
      wall: [],
      deadWall: [],
      doraIndicators: [],
      uraDoraIndicators: [],
      currentTurn: 0,
      currentPlayer: 'east',
      lastDiscard: null,
      phase: 'waiting',
      pendingActions: [],
      actionHistory: []
    };
  }

  /**
   * Create player state
   */
  private createPlayer(id: string, seat: Wind, isDealer: boolean) {
    return {
      id,
      seat,
      score: 25000,
      hand: [],
      discards: [],
      melds: [],
      riichi: {
        declared: false,
        ippatsu: false,
        doubleRiichi: false,
        turn: null
      },
      furiten: false,
      isDealer
    };
  }
}

/**
 * Game message types for WebSocket communication
 */
export type GameMessage =
  | { type: 'game_event'; event: string }
  | { type: 'branching_point'; branchingPoint: string }
  | { type: 'state_update'; state: GameState }
  | { type: 'error'; error: string }
  | { type: 'payment'; payments: WinPayment[] };
