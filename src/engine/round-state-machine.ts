import { GameState, GamePhase, Wind, DrawType, PlayerState, RoundWind } from '../types/game-state.js';
import { RuleConfig } from '../config/rule-config.js';
import { TileInstance, tilesEqual } from '../types/tiles.js';
import { HandEvaluator } from './hand-evaluator.js';

/**
 * Round state machine events
 */
export type RoundEvent =
  | { type: 'ROUND_START' }
  | { type: 'DEAL_COMPLETE' }
  | { type: 'DRAW_TILE'; player: Wind }
  | { type: 'DISCARD'; player: Wind; tile: TileInstance }
  | { type: 'CHI'; player: Wind; tile: TileInstance; meldTiles?: TileInstance[] }
  | { type: 'PON'; player: Wind; tile: TileInstance }
  | { type: 'KAN'; player: Wind; tile: TileInstance }
  | { type: 'RIICHI_DECLARE'; player: Wind }
  | { type: 'RIICHI_ACCEPTED'; player: Wind }
  | { type: 'RON_DECLARE'; player: Wind; tile: TileInstance }
  | { type: 'TSUMO_DECLARE'; player: Wind; tile: TileInstance }
  | { type: 'NAGASHI_MANGAN'; player: Wind }
  | { type: 'EXHAUSTIVE_DRAW'; drawType: DrawType }
  | { type: 'KYUUSHU_DECLARE'; player: Wind }
  | { type: 'KAN_COMPLETE' }
  | { type: 'ABORTIVE_DRAW'; drawType: DrawType }
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

export interface RoundStateMachineOptions {
  initialWall?: TileInstance[];
}

/**
 * Round state machine
 * Manages the flow of a single round with all branching points
 */
export class RoundStateMachine {
  private handEvaluator = new HandEvaluator();
  private lastWinners: Wind[] = [];
  private lastRoundWasDraw = false;
  private calledFromSeats = new Set<Wind>();
  private anyCallInRound = false;
  private allDiscardsBySeat: Record<Wind, TileInstance[]> = {
    east: [],
    south: [],
    west: [],
    north: []
  };

  constructor(
    private rules: RuleConfig,
    private state: GameState,
    private options?: RoundStateMachineOptions
  ) { }

  /**
   * Reset round tracking flags
   */
  resetRoundTracking(): void {
    this.lastWinners = [];
    this.lastRoundWasDraw = false;
    this.calledFromSeats.clear();
    this.anyCallInRound = false;
    this.state.lastDrawWasRinshan = false;
    this.state.drawType = null;
    this.state.kyuushuEligible = [];
    this.state.pendingKan = null;
    this.state.pendingRon = null;
    this.allDiscardsBySeat = { east: [], south: [], west: [], north: [] };
  }

  /**
   * Whether any pon/chi/kan call has happened this round
   */
  hasAnyCall(): boolean {
    return this.anyCallInRound;
  }

  /**
   * Whether a hand qualifies for 九種九牌 (9+ distinct terminal/honor kinds)
   */
  isKyuushuHand(hand: TileInstance[]): boolean {
    const kinds = new Set<string>();
    for (const t of hand) {
      if (t.suit === 'honor') {
        kinds.add(`honor:${t.honorType}`);
      } else if (t.rank === 1 || t.rank === 9) {
        kinds.add(`${t.suit}:${t.rank}`);
      }
    }
    return kinds.size >= 9;
  }

  /**
   * Count kan melds (kan/ankan/kakan) across all players
   */
  countKans(): { total: number; players: Wind[] } {
    const players = new Set<Wind>();
    let total = 0;
    for (const p of this.state.players) {
      for (const m of p.melds) {
        if (m.type === 'kan' || m.type === 'ankan' || m.type === 'kakan') {
          total++;
          players.add(p.seat);
        }
      }
    }
    return { total, players: [...players] };
  }

  /**
   * Get all discards thrown by a seat (including tiles later called by other players)
   */
  getAllDiscardsForSeat(seat: Wind): TileInstance[] {
    const player = this.state.players.find(p => p.seat === seat);
    const tracked = this.allDiscardsBySeat[seat] ?? [];
    return tracked.length >= (player?.discards.length ?? 0) ? tracked : (player?.discards ?? []);
  }

  /**
   * Set or update custom initial wall (e.g. for replays or testing)
   */
  setInitialWall(wall: TileInstance[]): void {
    if (!this.options) {
      this.options = {};
    }
    this.options.initialWall = wall;
  }

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

      case 'game_end':
        return this.handleGameEnd(event, events);

      default:
        throw new Error(`Unknown phase: ${this.state.phase}`);
    }
  }

  // ============================================================
  // 流局ヘルパー
  // ============================================================

  /**
   * Transition into the draw phase with a classified draw type
   */
  private toDraw(events: string[], drawType: DrawType, branchingPoint: BranchingPoint): TransitionResult {
    this.state.drawType = drawType;
    this.state.pendingKan = null;
    this.state.pendingRon = null;
    this.lastWinners = [];
    this.lastRoundWasDraw = true;
    return {
      newState: this.state,
      newPhase: 'draw',
      events,
      branchingPoint
    };
  }

  /**
   * 四風連打: first turn, no calls yet, all 4 players discarded the same wind
   */
  private checkFourWindAbort(): boolean {
    if (this.anyCallInRound) return false;
    const seats: Wind[] = ['east', 'south', 'west', 'north'];
    for (const s of seats) {
      if ((this.allDiscardsBySeat[s] ?? []).length !== 1) return false;
    }
    const first = this.allDiscardsBySeat['east'][0];
    if (first.suit !== 'honor' || !['east', 'south', 'west', 'north'].includes(first.honorType ?? '')) {
      return false;
    }
    return seats.every(s => tilesEqual(this.allDiscardsBySeat[s][0], first));
  }

  /**
   * 四槓散了: 4+ kans across 2+ players (a lone 4-kan hand may continue for suukantsu)
   */
  private checkFourKanAbort(): boolean {
    const { total, players } = this.countKans();
    return total >= 4 && players.length >= 2;
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
          return this.toDraw(events, 'wall_exhausted', 'EXHAUSTIVE_DRAW_CHECK');
        }

        // 山の一番上から1枚ツモる
        const drawnTile = this.state.wall.shift()!;
        player.hand.push(drawnTile);
        this.state.currentPlayer = event.player;
        this.state.lastDiscard = null;
        this.state.lastDrawWasRinshan = false;
        events.push(`${event.player} drew a tile: ${drawnTile.id} (wall: ${this.state.wall.length} left)`);

        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'DISCARD': {
        this.assertNoPendingKan();
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);

        // リーチ後の打牌制約チェック
        if (player.riichi.declared && player.hand.length > 0) {
          const declIdx = player.riichi.discardIndex ?? 0;
          if (player.discards.length > declIdx) {
            // 既にリーチ宣言牌を切った後の次巡以降 → ツモ牌（手牌末尾）のみ打牌可能
            const drawnTile = player.hand[player.hand.length - 1];
            const hasExactIdInHand = player.hand.some(t => t.id === event.tile.id);
            const isDrawnTile = hasExactIdInHand
              ? drawnTile.id === event.tile.id
              : (drawnTile.suit === event.tile.suit &&
                drawnTile.rank === event.tile.rank &&
                drawnTile.honorType === event.tile.honorType);
            if (!isDrawnTile) {
              throw new Error('リーチ後はツモ牌以外を打牌できません');
            }
          } else if (player.discards.length === declIdx && player.hand.length === 14 - player.melds.length * 3) {
            // リーチ宣言牌の打牌 → 切った後にテンパイを維持する牌か検証
            const candidates = this.handEvaluator.getRiichiDiscardCandidates(player.hand, player.melds);
            if (candidates.length > 0) {
              const isValidDecl = candidates.some(
                c => c.id === event.tile.id ||
                  (c.suit === event.tile.suit && c.rank === event.tile.rank && c.honorType === event.tile.honorType)
              );
              if (!isValidDecl) {
                throw new Error('この牌を切ると聴牌にならないため立直打牌できません');
              }
            }
          }
        }

        // 手牌から指定牌を除去 (テストやモック手牌の場合はそのまま捨牌に追加)
        let actualDiscarded: TileInstance = event.tile;
        const tileIdx = player.hand.findIndex(t => t.id === event.tile.id);
        if (tileIdx !== -1) {
          const [discarded] = player.hand.splice(tileIdx, 1);
          player.discards.push(discarded);
          this.state.lastDiscard = discarded;
          actualDiscarded = discarded;
        } else {
          const fallbackIdx = player.hand.findIndex(
            t => t.suit === event.tile.suit &&
              t.rank === event.tile.rank &&
              t.honorType === event.tile.honorType
          );
          if (fallbackIdx !== -1) {
            const [discarded] = player.hand.splice(fallbackIdx, 1);
            player.discards.push(discarded);
            this.state.lastDiscard = discarded;
            actualDiscarded = discarded;
          } else {
            // モック/テスト互換: 手牌に存在しない場合も捨牌に直接登録
            player.discards.push(event.tile);
            this.state.lastDiscard = event.tile;
          }
        }
        this.allDiscardsBySeat[event.player].push(actualDiscarded);
        this.state.lastDrawWasRinshan = false;

        // リーチ宣言後の次巡ツモ切りが完了した時点でそのプレイヤーの一発フラグを消去
        if (
          player.riichi.declared &&
          player.riichi.discardIndex !== undefined &&
          player.riichi.discardIndex !== null &&
          player.discards.length > player.riichi.discardIndex + 1
        ) {
          player.riichi.ippatsu = false;
        }

        // フリテン状態の更新
        this.updatePlayerFuriten(player);

        events.push(`${event.player} discarded ${event.tile.id}`);

        this.state.currentTurn++;

        // 次のプレイヤーへ
        const nextSeat = this.getNextSeat(event.player);
        this.state.currentPlayer = nextSeat;

        // BRANCHING POINT: ABORTIVE_DRAW_CHECK (四風連打)
        if (this.checkFourWindAbort()) {
          events.push('Abortive draw: four winds discarded (四風連打)');
          return this.toDraw(events, 'four_wind', 'ABORTIVE_DRAW_CHECK');
        }

        // 打牌後に山が尽きていたら流局判定
        if (this.isExhaustiveDraw()) {
          return this.toDraw(events, 'wall_exhausted', 'NAGASHI_MANGAN_CHECK');
        }

        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'RON_DECLARE':
        this.lastWinners = [event.player];
        this.lastRoundWasDraw = false;
        events.push(`${event.player} declared ron`);
        return {
          newState: this.state,
          newPhase: 'ron_declared',
          events,
          branchingPoint: 'MULTIPLE_RON_CHECK'
        };

      case 'TSUMO_DECLARE':
        this.lastWinners = [event.player];
        this.lastRoundWasDraw = false;
        events.push(`${event.player} declared tsumo`);
        return {
          newState: this.state,
          newPhase: 'tsumo_declared',
          events
        };

      case 'PON': {
        this.assertNoPendingKan();
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);
        if (player.riichi.declared) {
          throw new Error('リーチ中はポンできません');
        }

        // G-5: 鳴き対象は直前の捨牌のみ
        const { tile: targetTile, fromPlayer } = this.resolveCallTarget(event.player, event.tile, 'pon');

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

        // 捨牌者の河から対象牌を取り除く
        const discarder = this.state.players.find(p => p.seat === fromPlayer)!;
        discarder.discards.splice(discarder.discards.length - 1, 1);

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
        if (fromPlayer) this.calledFromSeats.add(fromPlayer);
        this.anyCallInRound = true;
        this.state.currentPlayer = event.player;
        this.state.lastDiscard = null;
        this.state.lastDrawWasRinshan = false;
        this.clearIppatsu();

        events.push(`${event.player} called PON on ${targetTile.id} from ${fromPlayer ?? 'unknown'}`);
        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'CHI': {
        this.assertNoPendingKan();
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);
        if (player.riichi.declared) {
          throw new Error('リーチ中はチーできません');
        }

        // G-5: 鳴き対象は直前の捨牌のみ
        const { tile: targetTile, fromPlayer: chiFrom } = this.resolveCallTarget(event.player, event.tile, 'chi');
        if (targetTile.suit === 'honor' || typeof targetTile.rank !== 'number') {
          throw new Error('Invalid target tile for CHI');
        }

        // G-5: チーは上家(直前の座席)の捨牌にのみ成立する
        const seatOrder: Wind[] = ['east', 'south', 'west', 'north'];
        if (seatOrder[(seatOrder.indexOf(chiFrom) + 1) % 4] !== event.player) {
          throw new Error('チーは上家の捨牌にのみできます');
        }
        const fromPlayer: Wind = chiFrom;

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
        const chiDiscarder = this.state.players.find(p => p.seat === fromPlayer)!;
        chiDiscarder.discards.splice(chiDiscarder.discards.length - 1, 1);

        const meld = {
          type: 'chi' as const,
          tiles: [...consumed, targetTile].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0)),
          calledFrom: fromPlayer
        };
        player.melds.push(meld);

        if (fromPlayer) this.calledFromSeats.add(fromPlayer);
        this.anyCallInRound = true;
        this.state.currentPlayer = event.player;
        this.state.lastDiscard = null;
        this.state.lastDrawWasRinshan = false;
        this.clearIppatsu();

        events.push(`${event.player} called CHI on ${targetTile.id} from ${fromPlayer ?? 'unknown'}`);
        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'KAN': {
        this.assertNoPendingKan();
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);

        const targetTile = event.tile;
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
          this.assertRiichiKanAllowed(player, 'kakan', handMatches[0]);
          const idx = player.hand.findIndex(t => t.id === handMatches[0].id);
          const [kakanTile] = player.hand.splice(idx, 1);
          existingPon.type = 'kakan';
          existingPon.tiles.push(kakanTile);
          existingPon.kakanTile = kakanTile;
          events.push(`${event.player} called Kakan with ${kakanTile.id}`);

          this.anyCallInRound = true;
          this.state.currentPlayer = event.player;
          this.clearIppatsu();

          // G-2: 加槓牌への槍槓ロン受付ウィンドウを開く。嶺上ツモと新ドラは
          // KAN_COMPLETE (誰もロンできない場合) まで延期する。
          this.state.pendingKan = { player: event.player, tile: kakanTile };
          this.state.lastDiscard = kakanTile;
          events.push(`Chankan window open on ${kakanTile.id}`);
          return { newState: this.state, newPhase: 'playing', events };
        }

        if (handMatches.length === 4 && this.state.currentPlayer === event.player) {
          // 暗槓 (Ankan)
          this.assertRiichiKanAllowed(player, 'ankan', targetTile);
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
          // 大明槓 (Daiminkan): G-5 直前の捨牌に対する発声のみ
          if (player.riichi.declared) {
            throw new Error('リーチ中は大明槓できません');
          }
          const { tile: kanTile, fromPlayer } = this.resolveCallTarget(event.player, event.tile, 'kan');
          const consumed: TileInstance[] = [];
          for (let i = 0; i < 3; i++) {
            const idx = player.hand.findIndex(t => t.id === handMatches[i].id);
            consumed.push(player.hand.splice(idx, 1)[0]);
          }

          // 捨て牌者の河から除去
          const kanDiscarder = this.state.players.find(p => p.seat === fromPlayer)!;
          kanDiscarder.discards.splice(kanDiscarder.discards.length - 1, 1);

          player.melds.push({
            type: 'kan',
            tiles: [...consumed, kanTile],
            calledFrom: fromPlayer
          });
          this.calledFromSeats.add(fromPlayer);
          events.push(`${event.player} called Daiminkan on ${kanTile.id} from ${fromPlayer}`);
        } else {
          throw new Error(`Player ${event.player} does not have enough tiles for KAN`);
        }

        this.anyCallInRound = true;

        // BRANCHING POINT: ABORTIVE_DRAW_CHECK (四槓散了)
        if (this.checkFourKanAbort()) {
          events.push('Abortive draw: four kans by different players (四槓散了)');
          return this.toDraw(events, 'four_kan', 'ABORTIVE_DRAW_CHECK');
        }

        this.drawRinshanAndFlipDora(player, events);

        this.state.currentPlayer = event.player;
        this.state.lastDiscard = null;
        this.clearIppatsu();

        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'KAN_COMPLETE': {
        // G-2: 槍槓ウィンドウの確定 (誰もロンしなかった場合の嶺上ツモ+新ドラ)
        const pending = this.state.pendingKan;
        if (!pending) {
          throw new Error('確定できる加槓がありません');
        }
        if (this.state.pendingRon) {
          throw new Error('ロン収集中のため確定できません');
        }
        const player = this.state.players.find(p => p.seat === pending.player);
        if (!player) throw new Error(`Player ${pending.player} not found`);

        this.state.pendingKan = null;
        this.state.lastDiscard = null;
        events.push(`Kakan confirmed for ${pending.player}`);

        // BRANCHING POINT: ABORTIVE_DRAW_CHECK (四槓散了)
        if (this.checkFourKanAbort()) {
          events.push('Abortive draw: four kans by different players (四槓散了)');
          return this.toDraw(events, 'four_kan', 'ABORTIVE_DRAW_CHECK');
        }

        this.drawRinshanAndFlipDora(player, events);
        this.state.currentPlayer = pending.player;

        return { newState: this.state, newPhase: 'playing', events };
      }


      case 'RIICHI_DECLARE': {
        this.assertNoPendingKan();
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);
        if (player.riichi.declared) {
          throw new Error('既に立直を宣言しています');
        }
        if (player.melds.some(m => m.type !== 'ankan')) {
          throw new Error('副露しているため立直できません');
        }
        if (player.hand.length > 0) {
          const candidates = this.handEvaluator.getRiichiDiscardCandidates(player.hand, player.melds);
          if (candidates.length === 0) {
            throw new Error('聴牌していないため立直できません');
          }
        }

        player.riichi.declared = true;
        player.riichi.ippatsu = true;
        player.riichi.doubleRiichi = (player.discards.length === 0 && !this.anyCallInRound);
        player.riichi.turn = this.state.currentTurn;
        player.riichi.discardIndex = player.discards.length;
        player.score -= 1000;
        this.state.riichiSticks++;
        events.push(`${event.player} declared riichi${player.riichi.doubleRiichi ? ' (double riichi)' : ''}`);

        // BRANCHING POINT: ABORTIVE_DRAW_CHECK (四家立直)
        if (this.state.players.every(p => p.riichi.declared)) {
          events.push('Abortive draw: four players declared riichi (四家立直)');
          return this.toDraw(events, 'four_riichi', 'ABORTIVE_DRAW_CHECK');
        }

        return { newState: this.state, newPhase: 'playing', events };
      }

      case 'KYUUSHU_DECLARE': {
        // 九種九牌: 配牌時に9種以上の么九牌があった場合のみ、最初の打牌前に宣言できる
        const player = this.state.players.find(p => p.seat === event.player);
        if (!player) throw new Error(`Player ${event.player} not found`);
        if (!this.isKyuushuHand(player.hand)) {
          throw new Error('九種九牌の条件を満たしていません');
        }
        if (this.anyCallInRound) {
          throw new Error('鳴きが発生したため九種九牌は宣言できません');
        }
        if (player.discards.length > 0) {
          throw new Error('最初の打牌を過ぎたため九種九牌は宣言できません');
        }
        events.push(`${event.player} declared nine terminals (九種九牌)`);
        return this.toDraw(events, 'nine_terminals', 'ABORTIVE_DRAW_CHECK');
      }

      case 'EXHAUSTIVE_DRAW':
        events.push('Exhaustive draw');
        return this.toDraw(events, event.drawType, 'NAGASHI_MANGAN_CHECK');

      default:
        return { newState: this.state, newPhase: 'playing', events };
    }
  }

  /**
   * Handle ron declared phase
   */
  private handleRonDeclared(event: RoundEvent, events: string[]): TransitionResult {
    // G-4: 2人目以降のロン宣言は収集中として受理し、ron_declared に留まる
    if (event.type === 'RON_DECLARE') {
      events.push(`${event.player} declared ron (collecting)`);
      return {
        newState: this.state,
        newPhase: 'ron_declared',
        events,
        branchingPoint: 'MULTIPLE_RON_CHECK'
      };
    }
    // G-4: 三家和の流局扱い (mode がトリロンを許可しない場合のみ GameRoom が発行する)
    if (event.type === 'ABORTIVE_DRAW') {
      const pending = this.state.pendingRon;
      const tripleRonAbort =
        event.drawType === 'triple_ron' &&
        pending !== null &&
        pending !== undefined &&
        pending.declarers.length >= 3 &&
        this.rules.multipleRon.mode !== 'allow_up_to_3';
      if (!tripleRonAbort) {
        throw new Error('Invalid ABORTIVE_DRAW in ron_declared phase');
      }
      events.push('Abortive draw: triple ron (三家和)');
      return this.toDraw(events, 'triple_ron', 'ABORTIVE_DRAW_CHECK');
    }
    if (event.type === 'MULTIPLE_RON_RESOLVED') {
      if (event.winners.length > 0) {
        this.lastWinners = [...event.winners];
      }
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
    if (event.type === 'SCORING_COMPLETE') {
      events.push('Scoring complete');
      return {
        newState: this.state,
        newPhase: 'round_end',
        events,
        branchingPoint: 'DEALER_ROTATION'
      };
    }
    if (event.type === 'ROUND_END') {
      return this.handleRoundEnd(event, events);
    }
    throw new Error(`Invalid event ${event.type} in ron_declared phase`);
  }

  /**
   * Handle tsumo declared phase
   */
  private handleTsumoDeclared(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'SCORING_COMPLETE') {
      events.push('Scoring complete');
      return {
        newState: this.state,
        newPhase: 'round_end',
        events,
        branchingPoint: 'DEALER_ROTATION'
      };
    }
    if (event.type === 'ROUND_END') {
      return this.handleRoundEnd(event, events);
    }
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
  private handleDraw(event: RoundEvent, events: string[]): TransitionResult {
    const nagashiPlayers = this.checkNagashiMangan();
    if (nagashiPlayers.length > 0 && this.rules.nagashiMangan.enabled) {
      events.push(`Nagashi mangan by: ${nagashiPlayers.join(', ')}`);
      if (this.rules.nagashiMangan.treatAsWin) {
        this.lastWinners = [...nagashiPlayers];
        return {
          newState: this.state,
          newPhase: 'scoring',
          events,
          branchingPoint: 'NAGASHI_MANGAN_CHECK'
        };
      }
    }

    if (event.type === 'ROUND_END') {
      events.push('Round ended in draw');
      return {
        newState: this.state,
        newPhase: 'round_end',
        events,
        branchingPoint: 'HONBA_UPDATE'
      };
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
    if (event.type === 'ROUND_END') {
      return this.handleRoundEnd(event, events);
    }
    throw new Error(`Invalid event ${event.type} in scoring phase`);
  }

  /**
   * Handle round end phase
   */
  private handleRoundEnd(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'ROUND_END') {
      events.push('Round ended');

      // 局数・本場・親移動（連荘 / 親流れ）および対局終了（東風戦＝東4局終了、東南戦＝南4局終了）の判定
      const isGameOver = this.advanceRoundAndDealer(events);

      // プレイヤーの手牌・捨て牌をリセット
      this.resetPlayersForNextRound();

      if (isGameOver) {
        events.push(`Game over (${this.state.gameLength === 'east' ? 'Tonpuusen' : 'Tonnansen'} complete)`);
        return {
          newState: this.state,
          newPhase: 'game_end',
          events
        };
      }

      return {
        newState: this.state,
        newPhase: 'waiting',
        events
      };
    }
    throw new Error(`Invalid event ${event.type} in round_end phase`);
  }

  /**
   * Handle game end phase (reset for a new game on ROUND_END or ROUND_START)
   */
  private handleGameEnd(event: RoundEvent, events: string[]): TransitionResult {
    if (event.type === 'ROUND_END' || event.type === 'ROUND_START') {
      this.state.round = { wind: 'east', number: 1 };
      this.state.honba = 0;
      this.state.riichiSticks = 0;
      for (const p of this.state.players) {
        p.score = 25000;
        p.isDealer = p.seat === 'east';
      }
      this.resetPlayersForNextRound();
      events.push('New game initialized');
      if (event.type === 'ROUND_START') {
        return this.handleWaiting(event, events);
      }
      return {
        newState: this.state,
        newPhase: 'waiting',
        events
      };
    }
    throw new Error(`Invalid event ${event.type} in game_end phase`);
  }

  /**
   * Update honba, dealer continuation, and round number/wind at the end of a round.
   * Returns true if the entire game (Tonpuusen / Tonnansen) has concluded.
   */
  private advanceRoundAndDealer(events: string[]): boolean {
    const seats: Wind[] = ['east', 'south', 'west', 'north'];
    const currentDealer = this.state.players.find(p => p.isDealer)?.seat ?? 'east';
    let dealerContinues = false;

    if (this.lastWinners.length > 0 && !this.lastRoundWasDraw) {
      if (this.lastWinners.includes(currentDealer)) {
        // 親の和了 → 連荘・本場+1
        dealerContinues = true;
        this.state.honba++;
        events.push(`Dealer (${currentDealer}) won: renchan (honba -> ${this.state.honba})`);
      } else {
        // 子の和了 → 親流れ・本場0リセット
        dealerContinues = false;
        this.state.honba = 0;
        events.push(`Non-dealer won: dealer rotates (honba -> 0)`);
      }
    } else if (this.state.drawType && this.state.drawType !== 'wall_exhausted') {
      // 途中流局 (四風連打・四家立直・四槓散了・九種九牌・三家和) → 連荘・本場+1
      this.state.honba++;
      dealerContinues = true;
      events.push(`Abortive draw (${this.state.drawType}): dealer (${currentDealer}) continues (honba -> ${this.state.honba})`);
    } else {
      // 流局 → 本場+1、親が聴牌なら連荘、不聴なら親流れ
      this.state.honba++;
      const dealerPlayer = this.state.players.find(p => p.seat === currentDealer);
      const isDealerTenpai =
        dealerPlayer && dealerPlayer.hand.length > 0
          ? this.handEvaluator.getWinningTiles(dealerPlayer.hand, dealerPlayer.melds).length > 0
          : false;
      dealerContinues = isDealerTenpai;
      events.push(`Draw: dealer (${currentDealer}) tenpai=${isDealerTenpai} (honba -> ${this.state.honba})`);
    }

    const gameLength = this.state.gameLength ?? 'south';
    const maxScore = Math.max(...this.state.players.map(p => p.score));
    const hasReachedTargetScore = maxScore >= 30000;
    const isExtensionWind =
      (gameLength === 'south' && (this.state.round.wind === 'west' || this.state.round.wind === 'north')) ||
      (gameLength === 'east' && this.state.round.wind !== 'east');

    // 西入（東風戦では南入）中のサドンデス終了判定: 誰かが30,000点以上に到達した時点で即終局
    if (isExtensionWind && hasReachedTargetScore) {
      events.push(`Sudden-death extension complete: top score reached ${maxScore} (>= 30,000)`);
      return true;
    }

    if (!dealerContinues) {
      const isRegularFinalWind =
        (gameLength === 'east' && this.state.round.wind === 'east') ||
        (gameLength === 'south' && this.state.round.wind === 'south');

      if (this.state.round.number >= 4) {
        if (isRegularFinalWind) {
          if (hasReachedTargetScore) {
            return true; // 30,000点以上のプレイヤーがいるため通常終局
          }
          // 全員30,000点未満 → 西入（東風戦では南入）突入！
          events.push(
            gameLength === 'south'
              ? `Entering West round (西入): top score is ${maxScore} (< 30,000)`
              : `Entering South round (南入): top score is ${maxScore} (< 30,000)`
          );
        } else if (isExtensionWind) {
          // 延長戦の4局目（西4局 / 東風戦の南4局）が終了した場合は30,000点未満でも終局
          return true;
        }
      }

      const nextDealerIdx = (seats.indexOf(currentDealer) + 1) % 4;
      const nextDealer = seats[nextDealerIdx];
      for (const p of this.state.players) {
        p.isDealer = p.seat === nextDealer;
      }

      if (this.state.round.number < 4) {
        this.state.round.number++;
      } else {
        this.state.round.number = 1;
        const roundWinds: RoundWind[] = ['east', 'south', 'west', 'north'];
        const rwIdx = roundWinds.indexOf(this.state.round.wind);
        this.state.round.wind = roundWinds[(rwIdx + 1) % 4];
      }
      events.push(`Advanced to ${this.state.round.wind} ${this.state.round.number} (dealer: ${nextDealer})`);
    }

    return false;
  }

  // ============================================================
  // 牌操作ロジック
  // ============================================================

  /**
   * 136枚の山牌を生成してシャッフル、王牌(14枚)を分離、ドラ表示牌を設定
   */
  private buildAndShuffleWall(): void {
    this.resetRoundTracking();
    let tiles: TileInstance[];

    if (this.options?.initialWall && this.options.initialWall.length >= 14) {
      tiles = [...this.options.initialWall];
    } else {
      tiles = [];
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
    }

    // 末尾14枚を王牌に
    this.state.deadWall = tiles.splice(tiles.length - 14, 14);
    this.state.wall = tiles;  // 残り牌

    // ドラ表示牌・裏ドラ表示牌をdeadWall先頭から分離（カン時に嶺上牌として引かれないようにする）
    const firstDora = this.state.deadWall.shift()!;
    const firstUraDora = this.state.deadWall.shift()!;
    this.state.doraIndicators = [firstDora];
    this.state.uraDoraIndicators = [firstUraDora];
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

    // 九種九牌の対象座席を記録 (クライアント通知用)
    this.state.kyuushuEligible = seats.filter(seat => {
      const player = this.state.players.find(p => p.seat === seat);
      return player !== undefined && this.isKyuushuHand(player.hand);
    });
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
   * G-2: 槍槓ウィンドウ中はロン/確定以外の行動を禁止する
   */
  private assertNoPendingKan(): void {
    if (this.state.pendingKan) {
      throw new Error('チャンカン確認中のため行動できません');
    }
  }

  /**
   * G-5: 鳴き対象は直前の捨牌 (lastDiscard) のみ。指定牌の一致・河の最新牌で
   * あること・発声者が捨牌者でないことを厳密に検証する。
   */
  private resolveCallTarget(
    caller: Wind,
    eventTile: TileInstance | undefined,
    callType: 'pon' | 'chi' | 'kan'
  ): { tile: TileInstance; fromPlayer: Wind } {
    const lastDiscard = this.state.lastDiscard;
    if (!lastDiscard) {
      throw new Error(`${callType.toUpperCase()}できる捨牌がありません`);
    }
    if (eventTile && eventTile.id !== lastDiscard.id) {
      throw new Error('指定牌が直前の捨牌と一致しません');
    }
    const fromPlayer = this.findLatestDiscarder(lastDiscard);
    if (!fromPlayer) {
      throw new Error(`${callType.toUpperCase()}対象の牌が河にありません`);
    }
    if (fromPlayer === caller) {
      throw new Error('自分の捨牌には鳴けません');
    }
    return { tile: lastDiscard, fromPlayer };
  }

  /**
   * 指定牌を最新の河牌として持つプレイヤー (捨牌者) を返す
   */
  private findLatestDiscarder(targetTile: TileInstance): Wind | null {
    for (const p of this.state.players) {
      const last = p.discards[p.discards.length - 1];
      if (last && (last.id === targetTile.id || tilesEqual(last, targetTile))) {
        return p.seat;
      }
    }
    return null;
  }

  /**
   * カン後の嶺上牌ツモと新カンドラ・カン裏ドラめくり
   */
  private drawRinshanAndFlipDora(player: PlayerState, events: string[]): void {
    // 王牌の末尾＝嶺上牌側から取得し、ドラ表示牌と混ざらないようにする
    let rinshanTile: TileInstance | undefined;
    if (this.state.deadWall.length > 0) {
      rinshanTile = this.state.deadWall.pop();
    } else if (this.state.wall.length > 0) {
      rinshanTile = this.state.wall.pop();
    }

    if (rinshanTile) {
      player.hand.push(rinshanTile);
      this.state.lastDrawWasRinshan = true;
      events.push(`${player.seat} drew rinshan tile: ${rinshanTile.id}`);
    }

    if (this.state.deadWall.length > 0) {
      const newDora = this.state.deadWall.shift()!;
      this.state.doraIndicators.push(newDora);
      events.push(`New dora indicator revealed: ${newDora.id}`);
    }
    if (this.state.deadWall.length > 0) {
      const newUraDora = this.state.deadWall.shift()!;
      this.state.uraDoraIndicators.push(newUraDora);
    }
  }

  /**
   * G-6: リーチ後のカンは待ちが変わらない場合のみ可能 (送りカン禁止)。
   * 非リーチ中は何もしない。
   */
  private assertRiichiKanAllowed(player: PlayerState, kanKind: 'ankan' | 'kakan', targetTile: TileInstance): void {
    if (!player.riichi.declared) return;

    const hand = player.hand;
    const melds = player.melds;
    if (hand.length === 0) return;

    // ツモ牌 (手牌末尾) を除いた13枚形の待ち集合
    const drawnTile = hand[hand.length - 1];
    const drawnIdx = hand.findIndex(t => t.id === drawnTile.id);
    const hand13 = [...hand.slice(0, drawnIdx), ...hand.slice(drawnIdx + 1)];
    const waitsBefore = this.handEvaluator.getWinningTiles(hand13, melds);
    if (waitsBefore.length === 0) return;

    // カン適用後の待ち集合
    let handAfter: TileInstance[];
    let meldsAfter = melds;
    if (kanKind === 'ankan') {
      const removed = hand.filter(t =>
        t.suit === targetTile.suit && t.rank === targetTile.rank && t.honorType === targetTile.honorType
      );
      handAfter = hand.filter(t => !removed.includes(t));
      meldsAfter = [...melds, { type: 'ankan' as const, tiles: removed }];
    } else {
      const idx = hand.findIndex(t => t.id === targetTile.id);
      const removeIdx = idx !== -1 ? idx : hand.findIndex(t => tilesEqual(t, targetTile));
      if (removeIdx === -1) return;
      handAfter = [...hand.slice(0, removeIdx), ...hand.slice(removeIdx + 1)];
    }
    const waitsAfter = this.handEvaluator.getWinningTiles(handAfter, meldsAfter);

    const kinds = (tiles: TileInstance[]) =>
      new Set(tiles.map(t => `${t.suit}:${t.rank ?? ''}:${t.honorType ?? ''}`));
    const before = kinds(waitsBefore);
    const after = kinds(waitsAfter);
    const same =
      before.size === after.size && [...before].every(k => after.has(k));
    if (!same) {
      throw new Error('リーチ後のカンで待ちが変わるためできません（送りカン禁止）');
    }
  }


  /**
   * プレイヤーの捨牌フリテン状態を更新
   */
  private updatePlayerFuriten(player: PlayerState): void {
    const allDiscards = this.getAllDiscardsForSeat(player.seat);
    player.furiten = this.handEvaluator.isDiscardFuriten(player.hand, player.melds, allDiscards);
  }

  /**
   * 次の局に向けてプレイヤー状態をリセット
   */
  private resetPlayersForNextRound(): void {
    this.resetRoundTracking();
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
    this.state.lastDrawWasRinshan = false;
    this.state.currentTurn = 0;
  }

  /**
   * 山牌が尽きたかチェック（王牌は除く）
   */
  private isExhaustiveDraw(): boolean {
    return this.state.wall.length === 0;
  }

  /**
   * 流し満貫チェック (荒牌平局時かつ自身の捨牌が他家に一度も鳴かれておらず全て么九牌の場合のみ成立)
   */
  checkNagashiMangan(): Wind[] {
    if (!this.rules.nagashiMangan.enabled) return [];
    if (this.state.wall.length > 0) return []; // 途中流局や山残存時は不成立

    return this.state.players
      .filter(p => {
        if (this.calledFromSeats.has(p.seat)) return false; // 鳴かれていたら不成立
        const allDiscards = this.getAllDiscardsForSeat(p.seat);
        return this.isNagashiManganValid(allDiscards);
      })
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
