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
  ) { }

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

  // ============================================================
  // フェーズハンドラー
  // ============================================================

  /**
   * Handle waiting phase
   * ROUND_START: 山牌を生成してシャッフル → dealing へ
   */
  private handleWaiting(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'ROUND_START') {
      events.push('Round starting');

      // 山牌を構築してシャッフル
      this.buildAndShuffleWall();
      events.push(`Wall built: ${this.state.wall.length} tiles`);

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
   * DEAL_COMPLETE: 各プレイヤーに13枚配牌 → playing へ
   */
  private handleDealing(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'DEAL_COMPLETE') {
      events.push('Dealing complete');

      // 各プレイヤーに13枚配る（東→南→西→北の順に4枚×3 + 1枚）
      this.dealTiles();
      events.push('Tiles dealt to all players');

      // 東家（dealer）から開始
      const dealer = this.state.players.find(p => p.isDealer);
      this.state.currentPlayer = dealer?.seat ?? 'east';
      this.state.currentTurn = 1;

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
      case 'DRAW_TILE': {
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);

        if (this.state.wall.length === 0) {
          // 山が尽きた → 流局
          events.push('Wall exhausted during draw');
          return {
            newState: this.state,
            newPhase: 'draw',
            events,
            branchingPoint: 'EXHAUSTIVE_DRAW_CHECK'
          };
        }

        // 山の一番上から1枚ツモる
        const drawnTile = this.state.wall.shift()!;
        player.hand.push(drawnTile);
        this.state.currentPlayer = event.player;
        events.push(`${event.player} drew ${drawnTile.id} (wall: ${this.state.wall.length} left)`);

        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'DISCARD': {
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);

        // 手牌から指定牌を除去
        const tileIdx = player.hand.findIndex(t => t.id === event.tile.id);
        if (tileIdx === -1) {
          // IDで見つからなければスーツ・数字で照合（クライアント互換のため）
          const fallbackIdx = player.hand.findIndex(
            t => t.suit === event.tile.suit &&
              t.rank === event.tile.rank &&
              t.honorType === event.tile.honorType
          );
          if (fallbackIdx === -1) {
            throw new Error(`Tile ${event.tile.id} not found in ${event.player}'s hand`);
          }
          const [discarded] = player.hand.splice(fallbackIdx, 1);
          player.discards.push(discarded);
          this.state.lastDiscard = discarded;
          events.push(`${event.player} discarded ${discarded.id}`);
        } else {
          const [discarded] = player.hand.splice(tileIdx, 1);
          player.discards.push(discarded);
          this.state.lastDiscard = discarded;
          events.push(`${event.player} discarded ${discarded.id}`);
        }

        this.state.currentTurn++;

        // 次のプレイヤーへ（打牌後はロンの機会のためフェーズ維持）
        // 実際はここで他プレイヤーの鳴き・ロン受付をすべきだが、
        // 状態機械の簡略実装として次プレイヤーが自動でツモる形にする
        const nextSeat = this.getNextSeat(event.player);
        this.state.currentPlayer = nextSeat;

        // 打牌後に山が尽きていたら流局判定
        if (this.isExhaustiveDraw()) {
          return {
            newState: this.state,
            newPhase: 'draw',
            events,
            branchingPoint: 'NAGASHI_MANGAN_CHECK'
          };
        }

        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'RON_DECLARE':
        events.push(`${event.player} declared ron`);
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

      case 'RIICHI_DECLARE': {
        const player = this.state.players.find(p => p.seat === event.player);
        if (player) {
          player.riichi.declared = true;
          player.riichi.turn = this.state.currentTurn;
          player.score -= 1000;
          this.state.riichiSticks++;
          events.push(`${event.player} declared riichi`);
        }
        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'EXHAUSTIVE_DRAW':
        events.push('Exhaustive draw');
        return {
          newState: this.state,
          newPhase: 'draw',
          events,
          branchingPoint: 'NAGASHI_MANGAN_CHECK'
        };

      default:
        return { newState: this.state, newPhase: 'playing', events };
    }
  }

  /**
   * Handle ron declared phase
   */
  private handleRonDeclared(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'MULTIPLE_RON_RESOLVED') {
      events.push(`Multiple ron resolved: ${event.winners.join(', ')}`);

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
   */
  private handleDraw(_event: RoundEvent, events: string[]): TransitionResult {
    const nagashiPlayers = this.checkNagashiMangan();
    if (nagashiPlayers.length > 0 && this.rules.nagashiMangan.enabled) {
      events.push(`Nagashi mangan by: ${nagashiPlayers.join(', ')}`);
      if (this.rules.nagashiMangan.treatAsWin) {
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
   */
  private handleRoundEnd(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'ROUND_END') {
      events.push('Round ended');

      // プレイヤーの手牌・捨て牌をリセット
      this.resetPlayersForNextRound();

      return {
        newState: this.state,
        newPhase: 'waiting',
        events
      };
    }
    throw new Error(`Invalid event ${event.type} in round_end phase`);
  }

  // ============================================================
  // 牌操作ロジック
  // ============================================================

  /**
   * 136枚の山牌を生成してシャッフル、王牌(14枚)を分離、ドラ表示牌を設定
   */
  private buildAndShuffleWall(): void {
    const tiles: TileInstance[] = [];
    let idCounter = 0;

    const suits = ['man', 'pin', 'sou'] as const;
    for (const suit of suits) {
      for (let rank = 1; rank <= 9; rank++) {
        for (let copy = 0; copy < 4; copy++) {
          const isRed = rank === 5 && copy === 0;
          tiles.push({ id: `${rank}${suit[0]}-${idCounter++}`, suit, rank, isRed });
        }
      }
    }

    const honors = ['east', 'south', 'west', 'north', 'white', 'green', 'red'] as const;
    for (const honorType of honors) {
      for (let copy = 0; copy < 4; copy++) {
        tiles.push({ id: `${honorType}-${idCounter++}`, suit: 'honor', honorType });
      }
    }

    // Fisher-Yates シャッフル
    for (let i = tiles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
    }

    // 末尾14枚を王牌に
    this.state.deadWall = tiles.splice(tiles.length - 14, 14);
    this.state.wall = tiles;  // 残り122枚

    // ドラ表示牌: 王牌の先頭
    this.state.doraIndicators = [this.state.deadWall[0]];
    this.state.uraDoraIndicators = [this.state.deadWall[1]];
  }

  /**
   * 各プレイヤーに13枚配牌する
   * 配順: 東→南→西→北 を 4枚ずつ3回、最後に1枚ずつ
   */
  private dealTiles(): void {
    // 手牌・捨て牌・副露をリセット
    for (const player of this.state.players) {
      player.hand = [];
      player.discards = [];
      player.melds = [];
      player.riichi = { declared: false, ippatsu: false, doubleRiichi: false, turn: null };
      player.furiten = false;
    }

    const seats: Wind[] = ['east', 'south', 'west', 'north'];

    // 4枚×3ラウンド
    for (let round = 0; round < 3; round++) {
      for (const seat of seats) {
        const player = this.state.players.find(p => p.seat === seat)!;
        for (let i = 0; i < 4; i++) {
          const tile = this.state.wall.shift();
          if (tile) player.hand.push(tile);
        }
      }
    }

    // 最後に1枚ずつ（東家は2枚目も引いて14枚 → 最初にツモ済み扱い）
    for (const seat of seats) {
      const player = this.state.players.find(p => p.seat === seat)!;
      const tile = this.state.wall.shift();
      if (tile) player.hand.push(tile);
    }

    // 東家（親）はもう1枚引いて14枚（第一ツモ済み）
    const dealer = this.state.players.find(p => p.isDealer);
    if (dealer) {
      const extraTile = this.state.wall.shift();
      if (extraTile) dealer.hand.push(extraTile);
    }
  }

  /**
   * 次のプレイヤーの座席を返す
   */
  private getNextSeat(current: Wind): Wind {
    const order: Wind[] = ['east', 'south', 'west', 'north'];
    const idx = order.indexOf(current);
    return order[(idx + 1) % 4];
  }

  /**
   * 次の局に向けてプレイヤー状態をリセット
   */
  private resetPlayersForNextRound(): void {
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
   * 山牌が尽きたかチェック（王牌は除く）
   */
  private isExhaustiveDraw(): boolean {
    return this.state.wall.length === 0;
  }

  /**
   * 流し満貫チェック
   */
  private checkNagashiMangan(): Wind[] {
    if (!this.rules.nagashiMangan.enabled) return [];
    return this.state.players
      .filter(p => this.isNagashiManganValid(p.discards))
      .map(p => p.seat);
  }

  private isNagashiManganValid(discards: TileInstance[]): boolean {
    return discards.length > 0 && discards.every(tile => {
      if (tile.suit === 'honor') return true;
      return tile.rank === 1 || tile.rank === 9;
    });
  }
}

/**
 * Branching point documentation
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
    outcomes: ['No pao: Normal payment calculation', 'Pao applies: Proceed to PAO_PAYMENT_CALCULATION']
  },
  PAO_PAYMENT_CALCULATION: {
    description: 'Calculate payment when pao applies',
    triggers: ['Pao check passed'],
    rules: ['pao.paymentStyle'],
    outcomes: ['full: Pao player pays full amount', 'split: Pao player splits with discarder']
  },
  KIRIAGE_MANGAN_CHECK: {
    description: 'Check if hand qualifies for kiriage mangan',
    triggers: ['Scoring calculation'],
    rules: ['scoring.kiriageMangan'],
    outcomes: ['4 han 30 fu → mangan', '3 han 60 fu → mangan', 'Otherwise: normal']
  },
  KAZOE_YAKUMAN_CHECK: {
    description: 'Check if 13+ han counts as yakuman',
    triggers: ['Scoring calculation with 13+ han'],
    rules: ['scoring.kazoeYakuman'],
    outcomes: ['yakuman', 'limit: sanbaiman', 'unlimited']
  },
  NAGASHI_MANGAN_CHECK: {
    description: 'Check if any player achieved nagashi mangan at exhaustive draw',
    triggers: ['Exhaustive draw'],
    rules: ['nagashiMangan.enabled', 'nagashiMangan.treatAsWin'],
    outcomes: ['Not enabled: Normal draw', 'Enabled + treatAsWin=true: Score as win']
  },
  EXHAUSTIVE_DRAW_CHECK: {
    description: 'Check if round ends in exhaustive draw (wall exhausted)',
    triggers: ['Wall empty'],
    outcomes: ['Proceed to NAGASHI_MANGAN_CHECK']
  },
  ABORTIVE_DRAW_CHECK: {
    description: 'Check for abortive draw conditions during play',
    triggers: ['Special conditions during play'],
    conditions: ['四風連打', '四家立直', '四槓散了', '九種九牌'],
    outcomes: ['Abortive draw', 'Continue play']
  },
  HONBA_UPDATE: {
    description: 'Update honba counter after round ends',
    triggers: ['Round end'],
    outcomes: ['Dealer wins or draw: Increment honba', 'Non-dealer wins: Reset honba']
  },
  DEALER_ROTATION: {
    description: 'Determine if dealer seat rotates',
    triggers: ['Round end'],
    outcomes: ['Dealer wins or tenpai at draw: Dealer continues', 'Non-dealer wins: Rotate']
  }
};
