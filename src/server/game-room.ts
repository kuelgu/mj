import { GameState, Wind, GamePhase } from '../types/game-state.js';
import { RuleConfig, loadRuleConfig } from '../config/rule-config.js';
import { RoundStateMachine, RoundEvent } from '../engine/round-state-machine.js';
import { ScoringEngine } from '../engine/scoring-engine.js';
import { WinPayment } from '../types/scoring.js';

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
