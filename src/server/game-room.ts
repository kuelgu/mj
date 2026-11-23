import { GameState, Wind, GamePhase, GameLength, PendingRonState } from '../types/game-state.js';
import { RuleConfig, loadRuleConfig } from '../config/rule-config.js';
import { RoundStateMachine, RoundEvent } from '../engine/round-state-machine.js';
import { ScoringEngine } from '../engine/scoring-engine.js';
import { NpcAi } from '../engine/npc-ai.js';
import { WinPayment, HandEvaluation, PaoInfo } from '../types/scoring.js';
import { TileInstance } from '../types/tiles.js';

const NPC_NAMES: Record<Wind, string> = {
  east: 'CPU-東',
  south: 'CPU-南',
  west: 'CPU-西',
  north: 'CPU-北'
};

export interface GameRoomOptions {
  /**
   * Allow fixed test seat IDs (p1-p4, player1-player4, 1-4) to claim specific seats.
   * Test-only: keep false in production so arbitrary IDs cannot target seats.
   */
  enableFixedTestSeats?: boolean;
}

/**
 * Game room - manages a single game session
 * Server-authoritative: all game logic runs on server
 */
export class GameRoom {
  private rules: RuleConfig;
  private state: GameState;
  private stateMachine: RoundStateMachine;
  private scoringEngine: ScoringEngine;
  private npcAi = new NpcAi();
  private passedCallPlayers = new Set<Wind>();
  private enableFixedTestSeats: boolean;

  constructor(ruleConfigPath: string, options?: GameRoomOptions) {
    this.rules = loadRuleConfig(ruleConfigPath);
    this.state = this.createInitialState(ruleConfigPath);
    this.stateMachine = new RoundStateMachine(this.rules, this.state);
    this.scoringEngine = new ScoringEngine(this.rules);
    this.enableFixedTestSeats = options?.enableFixedTestSeats ?? false;
  }

  /**
   * Set game length mode ('east' = 東風戦, 'south' = 東南戦)
   */
  setGameLength(gameLength: GameLength): void {
    this.state.gameLength = gameLength;
  }

  /**
   * Get game length mode
   */
  getGameLength(): GameLength {
    return this.state.gameLength ?? 'south';
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
    this.stateMachine.resetRoundTracking();
    this.state.phase = 'waiting';
    this.state.round = { wind: 'east', number: 1 };
    this.state.honba = 0;
    this.state.riichiSticks = 0;
    for (const player of this.state.players) {
      player.score = 25000;
      player.hand = [];
      player.discards = [];
      player.melds = [];
      player.riichi = { declared: false, ippatsu: false, doubleRiichi: false, turn: null };
      player.furiten = false;
      player.isDealer = player.seat === 'east';
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
      const wasRinshan = Boolean(this.state.lastDrawWasRinshan);
      if (['DISCARD', 'DRAW_TILE', 'PON', 'CHI', 'KAN', 'ROUND_START', 'DEAL_COMPLETE'].includes(event.type)) {
        this.passedCallPlayers.clear();
      }
      if (event.type === 'ROUND_START') {
        this.fillEmptySeatsWithNpcs();
        this.state.autoStartDeadline = null;
      }
      // G-2: 槍槓ウィンドウの確定はロン可能者の確認を先に行う
      if (event.type === 'KAN_COMPLETE') {
        const preCheck = this.tryCompletePendingKan();
        if (preCheck) {
          return { state: this.state, messages: preCheck };
        }
        if (this.state.pendingKan && this.state.phase === 'playing') {
          return {
            state: this.state,
            messages: [{ type: 'error', error: 'チャンカンの確認待ちです' }]
          };
        }
      }
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
        const winnerPlayer = this.state.players.find(p => p.seat === event.player);
        const winningTile = event.tile || winnerPlayer?.hand[winnerPlayer.hand.length - 1];
        const handEval = winnerPlayer && winnerPlayer.hand.length > 0
          ? this.scoringEngine.evaluateHand({
              hand: winnerPlayer.hand,
              melds: winnerPlayer.melds,
              winningTile,
              isTsumo: true,
              seatWind: this.getPlayerSeatWind(event.player),
              roundWind: this.state.round.wind,
              riichi: winnerPlayer.riichi.declared,
              doubleRiichi: winnerPlayer.riichi.doubleRiichi,
              ippatsu: winnerPlayer.riichi.ippatsu,
              rinshan: wasRinshan,
              haitei: this.state.wall.length === 0 && this.state.deadWall.length > 0 && !wasRinshan,
              doraIndicators: this.state.doraIndicators,
              uraDoraIndicators: this.state.uraDoraIndicators
            })
          : {
              isWinningHand: true,
              patterns: [],
              yaku: [{ type: 'tsumo' as const, han: 1, isYakuman: false }],
              han: 1,
              fu: 30,
              yakuman: 0,
              dora: 0,
              uraDora: 0,
              akaDora: 0
            };

        if (!handEval.isWinningHand) {
          this.state.phase = 'playing';
          return {
            state: this.state,
            messages: [{
              type: 'error',
              error: 'ツモ和了できません（和了形でないか、役がありません）'
            }]
          };
        }

        // G-3: パオ検出
        const paoInfo = this.scoringEngine.detectPao(winnerPlayer?.melds ?? [], handEval.yaku, 'tsumo');
        const payments = this.calculateWinPayments(
          [{ wind: event.player, handEvaluation: handEval, paoInfo }],
          'tsumo'
        );
        payments.forEach(p => { p.winningTile = winningTile; });
        this.applyPayments(payments);
        messages.push({
          type: 'payment',
          payments
        });
      } else if (event.type === 'RON_DECLARE') {
        // G-4: 複数ロンの宣言収集フロー
        messages.push(...this.processRonDeclaration(event.player, event.tile));
      } else if (event.type === 'KAN' && this.state.pendingKan && !this.state.pendingRon) {
        // G-2: 加槓直後の槍槓確認 (誰もロンできなければ即時確定する)
        const kanMessages = this.tryCompletePendingKan();
        if (kanMessages) {
          messages.push(...kanMessages);
        } else {
          messages.push({
            type: 'game_event',
            event: 'Waiting for chankan ron declarations...'
          });
        }
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
   * G-4: ロン宣言の受理と収集。宣言者を検証して pendingRon に追加し、
   * NPC の宣言を即時収集したうえで、待機者がいなければ確定する。
   */
  private processRonDeclaration(player: Wind, tile: TileInstance): GameMessage[] {
    const pending = this.state.pendingRon;

    if (pending && !this.tilesMatchKind(pending.tile, tile)) {
      return [{ type: 'error', error: '収集中のロン牌と異なる牌への宣言です' }];
    }
    if (pending && pending.declarers.some(d => d.wind === player)) {
      return [{ type: 'error', error: '既にロンを宣言済みです' }];
    }

    const validation = this.validateRonDeclarer(player, tile);
    if ('error' in validation) {
      if (!pending) {
        this.state.phase = 'playing';
      }
      return [{ type: 'error', error: validation.error }];
    }

    if (!this.state.pendingRon) {
      this.state.pendingRon = {
        discarder: validation.discarder,
        tile,
        chankan: validation.chankan,
        declarers: []
      };
    }
    const collection = this.state.pendingRon;
    collection.declarers.push({
      wind: player,
      handEvaluation: validation.handEvaluation,
      paoInfo: validation.paoInfo
    });

    const out: GameMessage[] = [{
      type: 'game_event',
      event: `${player} declared ron (${collection.declarers.length} declarer(s))`
    }];

    // NPC の宣言を即時収集する (NPC はロン可能な牌を常に見逃さない)
    for (;;) {
      const declared = new Set(collection.declarers.map(d => d.wind));
      const npc = this.findAbleNpcRon(collection.tile, collection.discarder, collection.chankan, declared);
      if (!npc) break;
      const npcValidation = this.validateRonDeclarer(npc, collection.tile);
      if ('error' in npcValidation) break;
      collection.declarers.push({
        wind: npc,
        handEvaluation: npcValidation.handEvaluation,
        paoInfo: npcValidation.paoInfo
      });
      out.push({
        type: 'game_event',
        event: `${npc} declared ron (${collection.declarers.length} declarer(s))`
      });
    }

    const finalized = this.tryFinalizeRonCollection();
    if (finalized) {
      out.push(...finalized);
    } else {
      out.push({ type: 'game_event', event: 'Waiting for other ron declarations...' });
    }
    return out;
  }

  /**
   * ロン宣言者を検証する (通常ロン・槍槓ロンの共通処理)
   */
  private validateRonDeclarer(player: Wind, tile: TileInstance):
    | { discarder: Wind; handEvaluation: HandEvaluation; chankan: boolean; paoInfo?: PaoInfo }
    | { error: string } {
    const winnerPlayer = this.state.players.find(p => p.seat === player);
    if (!winnerPlayer) return { error: `Player ${player} not found` };

    // 槍槓ロンか通常ロンかの判定
    const pendingKan = this.state.pendingKan;
    const chankan = pendingKan !== null &&
      pendingKan !== undefined &&
      this.tilesMatchKind(pendingKan.tile, tile);

    let discarder: Wind | null = null;
    if (chankan && pendingKan) {
      discarder = pendingKan.player;
    } else if (this.state.lastDiscard && this.tilesMatchKind(this.state.lastDiscard, tile)) {
      discarder = this.findLatestDiscarder(this.state.lastDiscard);
    } else {
      return { error: 'ロンできる捨牌がありません' };
    }
    if (!discarder) return { error: 'ロンできる捨牌がありません' };
    if (discarder === player) return { error: '自分の捨牌にはロンできません' };

    // フリテンチェック
    if (winnerPlayer.hand.length > 0) {
      const allDiscards = this.stateMachine.getAllDiscardsForSeat(player);
      const isFuriten =
        winnerPlayer.furiten ||
        this.scoringEngine.getHandEvaluator().isDiscardFuriten(winnerPlayer.hand, winnerPlayer.melds, allDiscards);
      if (isFuriten) {
        return { error: 'フリテンのためロン和了できません' };
      }
    }

    const handEval: HandEvaluation = winnerPlayer.hand.length > 0
      ? this.scoringEngine.evaluateHand({
          hand: winnerPlayer.hand,
          melds: winnerPlayer.melds,
          winningTile: tile,
          isTsumo: false,
          seatWind: this.getPlayerSeatWind(player),
          roundWind: this.state.round.wind,
          riichi: winnerPlayer.riichi.declared,
          doubleRiichi: winnerPlayer.riichi.doubleRiichi,
          ippatsu: winnerPlayer.riichi.ippatsu,
          chankan,
          houtei: !chankan && this.state.wall.length === 0 && this.state.deadWall.length > 0,
          doraIndicators: this.state.doraIndicators,
          uraDoraIndicators: this.state.uraDoraIndicators
        })
      : {
          isWinningHand: true,
          patterns: [],
          yaku: [{ type: 'riichi' as const, han: 1, isYakuman: false }],
          han: 1,
          fu: 30,
          yakuman: 0,
          dora: 0,
          uraDora: 0,
          akaDora: 0
        };

    if (!handEval.isWinningHand) {
      return { error: 'ロン和了できません（和了形でないか、役がありません）' };
    }

    // G-3: パオ検出
    const paoInfo = this.scoringEngine.detectPao(winnerPlayer.melds, handEval.yaku, 'ron');
    return { discarder, handEvaluation: handEval, chankan, paoInfo };
  }

  /**
   * G-4: 待機者がいなければロン収集を確定する。待機中は null を返す。
   */
  private tryFinalizeRonCollection(): GameMessage[] | null {
    const pending = this.state.pendingRon;
    if (!pending || this.state.phase !== 'ron_declared') return null;
    const declared = new Set(pending.declarers.map(d => d.wind));
    if (this.canHumanRon(pending.tile, pending.discarder, pending.chankan, declared)) {
      return null;
    }
    return this.finalizeRonCollection(pending);
  }

  /**
   * G-4: mode 判定 (allow_up_to_3 / allow_double / head_bump) と精算・遷移
   */
  private finalizeRonCollection(pending: PendingRonState): GameMessage[] {
    const out: GameMessage[] = [];
    const mode = this.rules.multipleRon.mode;
    const headBump = mode === 'head_bump' || this.rules.multipleRon.atamahane;
    let winners = pending.declarers;

    if (winners.length >= 3 && mode !== 'allow_up_to_3') {
      // 三家和 → 流局 (先に遷移して検証を通し、toDraw が収集状態を掃除する)
      const result = this.stateMachine.transition({ type: 'ABORTIVE_DRAW', drawType: 'triple_ron' });
      this.state.phase = result.newPhase;
      result.events.forEach(eventText => out.push({ type: 'game_event', event: eventText }));
      if (result.branchingPoint) {
        out.push({ type: 'branching_point', branchingPoint: result.branchingPoint });
      }
      out.push({ type: 'state_update', state: this.state });
      return out;
    }

    if (headBump && winners.length > 1) {
      // 頭ハネ: 捨牌者に最も近い宣言者のみ和了
      const order: Wind[] = ['east', 'south', 'west', 'north'];
      const discarderIdx = order.indexOf(pending.discarder);
      winners = [...winners].sort((a, b) =>
        ((order.indexOf(a.wind) - discarderIdx + 4) % 4) -
        ((order.indexOf(b.wind) - discarderIdx + 4) % 4)
      ).slice(0, 1);
      out.push({ type: 'game_event', event: `Head bump (頭ハネ): only ${winners[0].wind} wins` });
    }

    const payments = this.calculateWinPayments(
      winners.map(w => ({ wind: w.wind, handEvaluation: w.handEvaluation, paoInfo: w.paoInfo })),
      'ron',
      pending.discarder
    );
    payments.forEach(p => { p.winningTile = pending.tile; });
    this.applyPayments(payments);
    out.push({ type: 'payment', payments });

    this.state.pendingRon = null;
    this.state.pendingKan = null;
    const result = this.stateMachine.transition({
      type: 'MULTIPLE_RON_RESOLVED',
      winners: winners.map(w => w.wind)
    });
    this.state.phase = result.newPhase;
    result.events.forEach(eventText => out.push({ type: 'game_event', event: eventText }));
    if (result.branchingPoint) {
      out.push({ type: 'branching_point', branchingPoint: result.branchingPoint });
    }
    out.push({ type: 'state_update', state: this.state });
    return out;
  }

  /**
   * G-2: 槍槓ウィンドウの進行。NPC のロンを宣言させるか、待機者がいなければ
   * 加槓を確定する。待機中・対象外の場合は null を返す。
   */
  private tryCompletePendingKan(): GameMessage[] | null {
    const pending = this.state.pendingKan;
    if (!pending || this.state.phase !== 'playing' || this.state.pendingRon) return null;

    // NPC が槍槓ロンできるなら確定せずロンさせる
    const npcDeclarer = this.findAbleNpcRon(pending.tile, pending.player, true);
    if (npcDeclarer) {
      return this.processEvent({ type: 'RON_DECLARE', player: npcDeclarer, tile: pending.tile }).messages;
    }
    // ロン可能な人間が残っていれば待機
    if (this.canHumanRon(pending.tile, pending.player, true)) return null;

    // 誰もロンできない → 嶺上ツモへ進む
    const result = this.stateMachine.transition({ type: 'KAN_COMPLETE' });
    this.state.phase = result.newPhase;
    const messages: GameMessage[] = [];
    result.events.forEach(eventText => messages.push({ type: 'game_event', event: eventText }));
    if (result.branchingPoint) {
      messages.push({ type: 'branching_point', branchingPoint: result.branchingPoint });
    }
    messages.push({ type: 'state_update', state: this.state });
    return messages;
  }

  /**
   * パス・宣言後に保留中のロン収集・槍槓ウィンドウを進める (WebSocket の pass_call から呼ぶ)
   */
  resolvePendingDeclarations(): GameMessage[] {
    const out: GameMessage[] = [];
    if (this.state.pendingRon) {
      const finalized = this.tryFinalizeRonCollection();
      if (finalized) out.push(...finalized);
    } else if (this.state.pendingKan) {
      const completed = this.tryCompletePendingKan();
      if (completed) out.push(...completed);
    }
    return out;
  }

  /**
   * 指定牌にロンできる NPC を手番順で探す
   */
  private findAbleNpcRon(
    tile: TileInstance,
    discarder: Wind,
    chankan: boolean,
    exclude: Set<Wind> = new Set()
  ): Wind | null {
    const order: Wind[] = ['east', 'south', 'west', 'north'];
    const discarderIdx = order.indexOf(discarder);
    for (let offset = 1; offset <= 3; offset++) {
      const seat = order[(discarderIdx + offset) % 4];
      if (exclude.has(seat)) continue;
      const p = this.state.players.find(pl => pl.seat === seat);
      if (p && p.isNpc) {
        const allDiscards = this.stateMachine.getAllDiscardsForSeat(p.seat);
        const seatWind = this.getPlayerSeatWind(p.seat);
        if (this.npcAi.shouldRon(p, tile, this.state, allDiscards, seatWind, chankan)) {
          return seat;
        }
      }
    }
    return null;
  }

  /**
   * 指定牌にロンできる (未パス・未宣言の) 人間がいるか
   */
  private canHumanRon(
    tile: TileInstance,
    discarder: Wind,
    chankan: boolean,
    exclude: Set<Wind> = new Set()
  ): boolean {
    for (const p of this.state.players) {
      if (!p.isOccupied || p.isNpc || p.seat === discarder) continue;
      if (exclude.has(p.seat) || this.passedCallPlayers.has(p.seat)) continue;
      const allDiscards = this.stateMachine.getAllDiscardsForSeat(p.seat);
      const seatWind = this.getPlayerSeatWind(p.seat);
      if (this.npcAi.shouldRon(p, tile, this.state, allDiscards, seatWind, chankan)) {
        return true;
      }
    }
    return false;
  }

  /**
   * ロン後の次局の親座席 (to_next_dealer 配分用)
   */
  private getNextDealerAfterWin(winners: Wind[]): Wind {
    const dealer = this.state.players.find(p => p.isDealer)?.seat ?? 'east';
    if (winners.includes(dealer)) return dealer;
    const order: Wind[] = ['east', 'south', 'west', 'north'];
    return order[(order.indexOf(dealer) + 1) % 4];
  }

  private tilesMatchKind(a: TileInstance, b: TileInstance): boolean {
    return a.suit === b.suit && a.rank === b.rank && a.honorType === b.honorType;
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

      const dealerSeat = this.state.players.find(p => p.isDealer)?.seat ?? 'east';
      const payment = this.scoringEngine.calculateTsumoPayment(
        winner.wind,
        score,
        isDealer,
        this.state.honba,
        this.state.riichiSticks,
        ['east', 'south', 'west', 'north'],
        winner.paoInfo,
        dealerSeat
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
        ['east', 'south', 'west', 'north'],
        this.getNextDealerAfterWin(winners.map(w => w.wind))
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

    // Clear riichi sticks (they've been paid out), unless carried over (to_next_dealer)
    const carryOver = payments.find(p => p.riichiSticksCarryOver !== undefined)?.riichiSticksCarryOver;
    this.state.riichiSticks = carryOver ?? 0;
  }

  /**
   * Calculate nagashi mangan payments
   */
  calculateNagashiManganPayments(players: Wind[]): WinPayment[] {
    const payments: WinPayment[] = [];

    const dealerSeat = this.state.players.find(p => p.isDealer)?.seat ?? 'east';
    players.forEach(player => {
      const isDealer = this.state.players.find(p => p.seat === player)?.isDealer || false;
      const payment = this.scoringEngine.calculateNagashiManganPayment(
        player,
        isDealer,
        this.state.honba,
        ['east', 'south', 'west', 'north'],
        dealerSeat
      );
      payments.push(payment);
    });

    return payments;
  }

  /**
   * Get a player's current seat wind (自風) relative to the current dealer
   */
  private getPlayerSeatWind(seat: Wind): Wind {
    const order: Wind[] = ['east', 'south', 'west', 'north'];
    const dealerSeat = this.state.players.find(p => p.isDealer)?.seat ?? 'east';
    const rel = (order.indexOf(seat) - order.indexOf(dealerSeat) + 4) % 4;
    return order[rel];
  }

  /**
   * Get rule configuration
   */
  getRules(): RuleConfig {
    return this.rules;
  }

  /**
   * Assign a player ID to a seat (human player takes an open or NPC seat)
   */
  assignPlayer(playerId: string): Wind {
    const existing = this.state.players.find(p => p.id === playerId && p.isOccupied && !p.isNpc);
    if (existing) return existing.seat;

    // Test-only fixed seat mapping (also used by the Playwright UI tests).
    // Never steals a seat occupied by another human: falls through to the
    // normal empty-seat search below.
    if (this.enableFixedTestSeats) {
      const seatMap: Record<string, Wind> = {
        p1: 'east', p2: 'south', p3: 'west', p4: 'north',
        player1: 'east', player2: 'south', player3: 'west', player4: 'north',
        '1': 'east', '2': 'south', '3': 'west', '4': 'north'
      };
      if (seatMap[playerId]) {
        const target = this.state.players.find(p => p.seat === seatMap[playerId]);
        if (target && (!target.isOccupied || target.isNpc)) {
          target.id = playerId;
          target.isOccupied = true;
          target.isNpc = false;
          return target.seat;
        }
      }
    }

    const emptySlot = this.state.players.find(p => !p.isOccupied || p.isNpc);
    if (emptySlot) {
      emptySlot.id = playerId;
      emptySlot.isOccupied = true;
      emptySlot.isNpc = false;
      return emptySlot.seat;
    }

    return 'east';
  }

  /**
   * Release a disconnected human player's seat
   */
  releasePlayer(playerId: string): void {
    const player = this.state.players.find(p => p.id === playerId && !p.isNpc);
    if (player) {
      if (this.state.phase === 'waiting') {
        player.isOccupied = false;
        player.isNpc = false;
        player.id = '空席';
      } else {
        player.isOccupied = true;
        player.isNpc = true;
        player.id = NPC_NAMES[player.seat];
      }
    }
  }

  /**
   * Count currently connected human players
   */
  getHumanCount(): number {
    return this.state.players.filter(p => p.isOccupied && !p.isNpc).length;
  }

  /**
   * Count total occupied seats (humans + replenished NPCs)
   */
  getOccupiedCount(): number {
    return this.state.players.filter(p => p.isOccupied).length;
  }

  /**
   * Fill all remaining unoccupied seats with NPC players
   */
  fillEmptySeatsWithNpcs(): void {
    for (const p of this.state.players) {
      if (!p.isOccupied) {
        p.id = NPC_NAMES[p.seat];
        p.isOccupied = true;
        p.isNpc = true;
      }
    }
  }

  /**
   * Automatically replenish any empty seats with NPCs and start/deal the round
   */
  autoStartRound(): GameMessage[] {
    this.state.autoStartDeadline = null;
    this.fillEmptySeatsWithNpcs();
    const allMessages: GameMessage[] = [];

    if (this.state.phase === 'waiting') {
      const r1 = this.processEvent({ type: 'ROUND_START' });
      allMessages.push(...r1.messages);
    }
    if (this.state.phase === 'dealing') {
      const r2 = this.processEvent({ type: 'DEAL_COMPLETE' });
      allMessages.push(...r2.messages);
    }

    return allMessages;
  }

  /**
   * Record that a human player passed on calling/ronning the current lastDiscard
   */
  markPlayerPassedCall(playerId: string): void {
    const player = this.state.players.find(p => p.id === playerId);
    if (player) {
      this.passedCallPlayers.add(player.seat);
    }
  }

  /**
   * Whether the room has at least 1 NPC and at least 1 human player
   */
  hasNpcPlayers(): boolean {
    const npcCount = this.state.players.filter(p => p.isNpc).length;
    return npcCount > 0 && npcCount < 4;
  }

  /**
   * Check if any connected human player can call (Pon/Chi/Kan) or Ron on the current lastDiscard
   */
  canAnyHumanCallOrRon(): boolean {
    // G-2: 槍槓ウィンドウ中はロン確認のみ (ポン・チーは不可)
    const pendingKan = this.state.pendingKan;
    const lastTile = pendingKan ? pendingKan.tile : this.state.lastDiscard;
    if (!lastTile || this.state.phase !== 'playing') return false;

    const discarder = pendingKan ? pendingKan.player : this.findLatestDiscarder(lastTile);
    if (!discarder) return false;

    const order: Wind[] = ['east', 'south', 'west', 'north'];
    const discarderIdx = order.indexOf(discarder);

    for (const p of this.state.players) {
      if (p.isNpc || p.seat === discarder || this.passedCallPlayers.has(p.seat)) continue;

      // 1. Can this human Ron?
      const allDiscards = this.stateMachine.getAllDiscardsForSeat(p.seat);
      const seatWind = this.getPlayerSeatWind(p.seat);
      if (this.npcAi.shouldRon(p, lastTile, this.state, allDiscards, seatWind, pendingKan != null)) {
        return true;
      }

      // G-2: 槍槓牌にはポン・チー・カンできない
      if (pendingKan) continue;

      // 2. Can this human Pon / Daiminkan / Chi (only if not in Riichi)?
      if (!p.riichi.declared) {
        const sameCount = p.hand.filter(
          t => t.suit === lastTile.suit && t.rank === lastTile.rank && t.honorType === lastTile.honorType
        ).length;
        if (sameCount >= 2) return true; // Pon or Daiminkan

        // Chi (only next seat after discarder)
        const isNextSeat = (discarderIdx + 1) % 4 === order.indexOf(p.seat);
        if (isNextSeat && lastTile.suit !== 'honor' && typeof lastTile.rank === 'number') {
          const r = lastTile.rank;
          const s = lastTile.suit;
          const has = (rk: number) => p.hand.some(t => t.suit === s && t.rank === rk);
          if (
            (r >= 3 && has(r - 2) && has(r - 1)) ||
            (r >= 2 && r <= 8 && has(r - 1) && has(r + 1)) ||
            (r <= 7 && has(r + 1) && has(r + 2))
          ) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Execute one automatic NPC step (or auto-draw for the next human when no calls are pending in an NPC game)
   */
  stepNpc(): { acted: boolean; messages: GameMessage[] } {
    if (this.state.phase !== 'playing' || !this.hasNpcPlayers()) {
      return { acted: false, messages: [] };
    }

    // G-2: 槍槓ウィンドウ中はロン確認・確定のみ行う
    // (ロン収集中は ron_declared のため先頭ガードで待機する)
    if (this.state.pendingKan) {
      const completed = this.tryCompletePendingKan();
      if (completed) {
        return { acted: true, messages: completed };
      }
      return { acted: false, messages: [] };
    }

    const lastTile = this.state.lastDiscard;
    const discarder = lastTile ? this.findLatestDiscarder(lastTile) : null;

    // 1. Check if any NPC can Ron on the latest discard
    if (lastTile && discarder) {
      const order: Wind[] = ['east', 'south', 'west', 'north'];
      const dIdx = order.indexOf(discarder);
      for (let offset = 1; offset <= 3; offset++) {
        const seat = order[(dIdx + offset) % 4];
        const p = this.state.players.find(pl => pl.seat === seat);
        if (p && p.isNpc) {
          const allDiscards = this.stateMachine.getAllDiscardsForSeat(p.seat);
          const seatWind = this.getPlayerSeatWind(p.seat);
          if (this.npcAi.shouldRon(p, lastTile, this.state, allDiscards, seatWind)) {
            const res = this.processEvent({ type: 'RON_DECLARE', player: p.seat, tile: lastTile });
            return { acted: true, messages: res.messages };
          }
        }
      }
    }

    // 2. If any human player has a valid call or Ron on lastDiscard (and hasn't passed), pause NPC progression
    if (this.canAnyHumanCallOrRon()) {
      return { acted: false, messages: [] };
    }

    // 3. Process current turn player
    const current = this.state.players.find(p => p.seat === this.state.currentPlayer);
    if (!current) return { acted: false, messages: [] };

    // G-1: NPC の九種九牌は第一打牌の前に自動宣言する
    if (
      current.isNpc &&
      current.discards.length === 0 &&
      !this.stateMachine.hasAnyCall() &&
      this.stateMachine.isKyuushuHand(current.hand)
    ) {
      const kyuushuRes = this.processEvent({ type: 'KYUUSHU_DECLARE', player: current.seat });
      return { acted: true, messages: kyuushuRes.messages };
    }

    const expectedDiscardSize = 14 - current.melds.length * 3;

    // 3a. If current player is waiting to draw (13 tiles)
    if (current.hand.length < expectedDiscardSize) {
      // In a room with NPCs, automatically draw for the current player (whether NPC or Human, once calls are resolved)
      const drawRes = this.processEvent({ type: 'DRAW_TILE', player: current.seat });
      return { acted: true, messages: drawRes.messages };
    }

    // 3b. If current player is a Human and already has 14 tiles, wait for human input
    if (!current.isNpc) {
      return { acted: false, messages: [] };
    }

    // 3c. Current player is an NPC with 14 tiles -> check Tsumo, Riichi, or Discard
    const seatWind = this.getPlayerSeatWind(current.seat);
    if (this.npcAi.shouldTsumo(current, this.state, seatWind)) {
      const winTile = current.hand[current.hand.length - 1];
      const tsumoRes = this.processEvent({ type: 'TSUMO_DECLARE', player: current.seat, tile: winTile });
      return { acted: true, messages: tsumoRes.messages };
    }

    const riichiDecision = this.npcAi.getRiichiDecision(current, this.state);
    if (riichiDecision.shouldRiichi && riichiDecision.discardTile) {
      const rRes = this.processEvent({ type: 'RIICHI_DECLARE', player: current.seat });
      const dRes = this.processEvent({ type: 'DISCARD', player: current.seat, tile: riichiDecision.discardTile });
      return {
        acted: true,
        messages: [...rRes.messages, ...dRes.messages]
      };
    }

    const discardTile = this.npcAi.chooseDiscard(current, this.state, seatWind);
    const discardRes = this.processEvent({ type: 'DISCARD', player: current.seat, tile: discardTile });
    return { acted: true, messages: discardRes.messages };
  }

  private findLatestDiscarder(targetTile: TileInstance): Wind | null {
    for (const p of this.state.players) {
      const last = p.discards[p.discards.length - 1];
      if (last && (last.id === targetTile.id || (last.suit === targetTile.suit && last.rank === targetTile.rank && last.honorType === targetTile.honorType))) {
        return p.seat;
      }
    }
    return null;
  }

  /**
   * Create initial game state (4 seats initially empty waiting for players)
   */
  private createInitialState(ruleConfigPath: string): GameState {
    return {
      ruleConfigPath,
      gameLength: 'south',
      round: { wind: 'east', number: 1 },
      honba: 0,
      riichiSticks: 0,
      players: [
        this.createPlayer('空席', 'east', true),
        this.createPlayer('空席', 'south', false),
        this.createPlayer('空席', 'west', false),
        this.createPlayer('空席', 'north', false)
      ],
      wall: [],
      deadWall: [],
      doraIndicators: [],
      uraDoraIndicators: [],
      currentTurn: 0,
      currentPlayer: 'east',
      lastDiscard: null,
      phase: 'waiting',
      autoStartDeadline: null,
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
      isDealer,
      isNpc: false,
      isOccupied: false
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
