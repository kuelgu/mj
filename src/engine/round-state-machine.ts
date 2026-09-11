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

      case 'PON': {
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);

        const targetTile = event.tile || this.state.lastDiscard;
        if (!targetTile) throw new Error('No target tile to call pon on');

        // 手牌から同種牌を2枚探す
        const matchingIndices: number[] = [];
        for (let i = 0; i < player.hand.length; i++) {
          const t = player.hand[i];
          if (t.suit === targetTile.suit && t.rank === targetTile.rank && t.honorType === targetTile.honorType) {
            matchingIndices.push(i);
            if (matchingIndices.length === 2) break;
          }
        }

        if (matchingIndices.length < 2) {
          throw new Error(`Player ${event.player} does not have 2 matching tiles for PON`);
        }

        // 捨て牌を捨てたプレイヤーを特定して、その捨て牌を取り除く
        let fromPlayer: Wind | undefined;
        for (const p of this.state.players) {
          const lastIdx = p.discards.length - 1;
          if (lastIdx >= 0 && (p.discards[lastIdx].id === targetTile.id || 
              (p.discards[lastIdx].suit === targetTile.suit && p.discards[lastIdx].rank === targetTile.rank && p.discards[lastIdx].honorType === targetTile.honorType))) {
            fromPlayer = p.seat;
            p.discards.splice(lastIdx, 1);
            break;
          }
        }

        // 大きいインデックスからspliceして消費
        const consumed: TileInstance[] = [];
        matchingIndices.sort((a, b) => b - a);
        for (const idx of matchingIndices) {
          consumed.push(player.hand.splice(idx, 1)[0]);
        }

        const meld = {
          type: 'pon' as const,
          tiles: [...consumed, targetTile],
          calledFrom: fromPlayer
        };
        player.melds.push(meld);

        // 手番を鳴いたプレイヤーに移動（14枚相当なので打牌待ち）
        this.state.currentPlayer = event.player;
        this.clearIppatsu();

        events.push(`${event.player} called PON on ${targetTile.id} from ${fromPlayer ?? 'unknown'}`);
        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'CHI': {
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);

        const targetTile = event.tile || this.state.lastDiscard;
        if (!targetTile || targetTile.suit === 'honor' || typeof targetTile.rank !== 'number') {
          throw new Error('Invalid target tile for CHI');
        }

        // 手牌から順子になる2枚を探す
        let consumed: TileInstance[] = [];
        if ('meldTiles' in event && Array.isArray((event as any).meldTiles) && (event as any).meldTiles.length === 2) {
          const reqTiles = (event as any).meldTiles as TileInstance[];
          for (const req of reqTiles) {
            const idx = player.hand.findIndex(t => t.id === req.id || (t.suit === req.suit && t.rank === req.rank));
            if (idx === -1) throw new Error('Required tile for CHI not found in hand');
            consumed.push(player.hand.splice(idx, 1)[0]);
          }
        } else {
          // 自動探索: (r-2, r-1), (r-1, r+1), (r+1, r+2)
          const r = targetTile.rank;
          const s = targetTile.suit;
          const combinations = [
            [r - 2, r - 1],
            [r - 1, r + 1],
            [r + 1, r + 2]
          ];
          let foundPair: [number, number] | null = null;
          for (const [r1, r2] of combinations) {
            if (r1 >= 1 && r1 <= 9 && r2 >= 1 && r2 <= 9) {
              const has1 = player.hand.some(t => t.suit === s && t.rank === r1);
              const has2 = player.hand.some(t => t.suit === s && t.rank === r2);
              if (has1 && has2) {
                foundPair = [r1, r2];
                break;
              }
            }
          }
          if (!foundPair) throw new Error(`Player ${event.player} cannot form sequence for CHI`);

          const idx1 = player.hand.findIndex(t => t.suit === s && t.rank === foundPair![0]);
          const t1 = player.hand.splice(idx1, 1)[0];
          const idx2 = player.hand.findIndex(t => t.suit === s && t.rank === foundPair![1]);
          const t2 = player.hand.splice(idx2, 1)[0];
          consumed = [t1, t2];
        }

        // 直前の打牌者の河から対象牌を除去
        let fromPlayer: Wind | undefined;
        for (const p of this.state.players) {
          const lastIdx = p.discards.length - 1;
          if (lastIdx >= 0 && (p.discards[lastIdx].id === targetTile.id || 
              (p.discards[lastIdx].suit === targetTile.suit && p.discards[lastIdx].rank === targetTile.rank))) {
            fromPlayer = p.seat;
            p.discards.splice(lastIdx, 1);
            break;
          }
        }

        const meld = {
          type: 'chi' as const,
          tiles: [...consumed, targetTile].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
          calledFrom: fromPlayer
        };
        player.melds.push(meld);

        this.state.currentPlayer = event.player;
        this.clearIppatsu();

        events.push(`${event.player} called CHI on ${targetTile.id} from ${fromPlayer ?? 'unknown'}`);
        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'KAN': {
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);

        const targetTile = event.tile || this.state.lastDiscard;
        if (!targetTile) throw new Error('No target tile for KAN');

        // 加槓チェック (ポン済みの牌に追加)
        const existingPon = player.melds.find(m => 
          m.type === 'pon' && 
          m.tiles.some(t => t.suit === targetTile.suit && t.rank === targetTile.rank && t.honorType === targetTile.honorType)
        );

        // 手牌内での枚数チェック
        const handMatches = player.hand.filter(t => 
          t.suit === targetTile.suit && t.rank === targetTile.rank && t.honorType === targetTile.honorType
        );

        if (existingPon && handMatches.length >= 1) {
          // 加槓 (Kakan)
          const idx = player.hand.findIndex(t => t.id === handMatches[0].id);
          const [kakanTile] = player.hand.splice(idx, 1);
          existingPon.type = 'kakan';
          existingPon.tiles.push(kakanTile);
          existingPon.kakanTile = kakanTile;
          events.push(`${event.player} called Kakan with ${kakanTile.id}`);
        } else if (handMatches.length === 4 && this.state.currentPlayer === event.player) {
          // 暗槓 (Ankan)
          const consumed: TileInstance[] = [];
          for (const match of handMatches) {
            const idx = player.hand.findIndex(t => t.id === match.id);
            consumed.push(player.hand.splice(idx, 1)[0]);
          }
          player.melds.push({
            type: 'ankan',
            tiles: consumed
          });
          events.push(`${event.player} called Ankan with ${targetTile.id}`);
        } else if (handMatches.length >= 3) {
          // 大明槓 (Daiminkan)
          const consumed: TileInstance[] = [];
          for (let i = 0; i < 3; i++) {
            const idx = player.hand.findIndex(t => t.id === handMatches[i].id);
            consumed.push(player.hand.splice(idx, 1)[0]);
          }

          // 捨て牌者の河から除去
          let fromPlayer: Wind | undefined;
          for (const p of this.state.players) {
            const lastIdx = p.discards.length - 1;
            if (lastIdx >= 0 && (p.discards[lastIdx].id === targetTile.id || 
                (p.discards[lastIdx].suit === targetTile.suit && p.discards[lastIdx].rank === targetTile.rank && p.discards[lastIdx].honorType === targetTile.honorType))) {
              fromPlayer = p.seat;
              p.discards.splice(lastIdx, 1);
              break;
            }
          }

          player.melds.push({
            type: 'kan',
            tiles: [...consumed, targetTile],
            calledFrom: fromPlayer
          });
          events.push(`${event.player} called Daiminkan on ${targetTile.id} from ${fromPlayer ?? 'unknown'}`);
        } else {
          throw new Error(`Player ${event.player} does not have enough tiles for KAN`);
        }

        // カン後の嶺上牌ツモ
        let rinshanTile: TileInstance | undefined;
        if (this.state.deadWall.length > 0) {
          rinshanTile = this.state.deadWall.shift();
        } else if (this.state.wall.length > 0) {
          rinshanTile = this.state.wall.pop();
        }

        if (rinshanTile) {
          player.hand.push(rinshanTile);
          events.push(`${event.player} drew rinshan tile: ${rinshanTile.id}`);
        }

        // 新カンドラめくり
        if (this.state.deadWall.length > 0) {
          const newDora = this.state.deadWall.shift()!;
          this.state.doraIndicators.push(newDora);
          events.push(`New dora indicator revealed: ${newDora.id}`);
        }

        this.state.currentPlayer = event.player;
        this.clearIppatsu();

        return { newState: this.state, newPhase: 'playing', events };
      }


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
   * 鳴き発生時の一発消し
   */
  private clearIppatsu(): void {
    for (const p of this.state.players) {
      if (p.riichi.declared) {
        p.riichi.ippatsu = false;
      }
    }
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
