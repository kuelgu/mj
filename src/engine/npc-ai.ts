import { GameState, PlayerState, Wind } from '../types/game-state.js';
import { TileInstance } from '../types/tiles.js';
import { HandEvaluator, tileToIndex, windToIndex } from './hand-evaluator.js';

const TERMINAL_INDICES = new Set([0, 8, 9, 17, 18, 26]);
const HONOR_INDICES = new Set([27, 28, 29, 30, 31, 32, 33]);

/**
 * NPC AI decision engine for 1-3 human player games
 */
export class NpcAi {
  private handEvaluator = new HandEvaluator();

  /**
   * Check if an NPC player can and should declare Ron on a discarded tile
   */
  shouldRon(
    npc: PlayerState,
    discardedTile: TileInstance,
    state: GameState,
    allDiscards: TileInstance[],
    seatWind: Wind,
    chankan = false
  ): boolean {
    if (!npc.hand || npc.hand.length === 0) return false;
    if (npc.furiten || this.handEvaluator.isDiscardFuriten(npc.hand, npc.melds, allDiscards)) {
      return false;
    }

    const evalRes = this.handEvaluator.evaluateHand({
      hand: npc.hand,
      melds: npc.melds,
      winningTile: discardedTile,
      isTsumo: false,
      seatWind,
      roundWind: state.round.wind,
      riichi: npc.riichi.declared,
      doubleRiichi: npc.riichi.doubleRiichi,
      ippatsu: npc.riichi.ippatsu,
      chankan,
      houtei: !chankan && state.wall.length === 0 && state.deadWall.length > 0,
      doraIndicators: state.doraIndicators,
      uraDoraIndicators: state.uraDoraIndicators
    });

    return evalRes.isWinningHand;
  }

  /**
   * Check if an NPC player on their turn (with 14 tiles) can and should declare Tsumo
   */
  shouldTsumo(npc: PlayerState, state: GameState, seatWind: Wind): boolean {
    const expected = 14 - npc.melds.length * 3;
    if (!npc.hand || npc.hand.length < expected) return false;

    const winningTile = npc.hand[npc.hand.length - 1];
    const evalRes = this.handEvaluator.evaluateHand({
      hand: npc.hand,
      melds: npc.melds,
      winningTile,
      isTsumo: true,
      seatWind,
      roundWind: state.round.wind,
      riichi: npc.riichi.declared,
      doubleRiichi: npc.riichi.doubleRiichi,
      ippatsu: npc.riichi.ippatsu,
      rinshan: Boolean(state.lastDrawWasRinshan),
      haitei: state.wall.length === 0 && state.deadWall.length > 0 && !state.lastDrawWasRinshan,
      doraIndicators: state.doraIndicators,
      uraDoraIndicators: state.uraDoraIndicators
    });

    return evalRes.isWinningHand;
  }

  /**
   * Check if an NPC player on their turn should declare Riichi, and return the best declaration discard tile
   */
  getRiichiDecision(
    npc: PlayerState,
    state: GameState
  ): { shouldRiichi: boolean; discardTile?: TileInstance } {
    if (npc.riichi.declared) return { shouldRiichi: false };
    if (npc.melds.some(m => m.type !== 'ankan')) return { shouldRiichi: false };
    if (npc.score < 1000) return { shouldRiichi: false };
    if (state.wall.length < 4) return { shouldRiichi: false };

    const candidates = this.handEvaluator.getRiichiDiscardCandidates(npc.hand, npc.melds);
    if (candidates.length === 0) return { shouldRiichi: false };

    const bestTile = this.pickBestTenpaiDiscard(npc, candidates);
    return {
      shouldRiichi: true,
      discardTile: bestTile
    };
  }

  /**
   * Choose the optimal tile for an NPC to discard
   */
  chooseDiscard(npc: PlayerState, state: GameState, seatWind: Wind): TileInstance {
    const hand = npc.hand;
    if (!hand || hand.length === 0) {
      throw new Error(`NPC ${npc.seat} has no tiles to discard`);
    }

    // 1. If already in Riichi:
    if (npc.riichi.declared) {
      const declIdx = npc.riichi.discardIndex ?? 0;
      if (npc.discards.length > declIdx) {
        // Post-riichi turn: MUST tsumogiri the drawn tile (last tile in hand)
        return hand[hand.length - 1];
      }
      // Declaration turn: pick the best tenpai-preserving tile
      const candidates = this.handEvaluator.getRiichiDiscardCandidates(hand, npc.melds);
      if (candidates.length > 0) {
        return this.pickBestTenpaiDiscard(npc, candidates);
      }
      return hand[hand.length - 1];
    }

    // 2. If any discard leaves the hand in Tenpai (even with open melds), pick the widest wait
    const tenpaiCandidates = this.getOpenOrClosedTenpaiDiscards(npc);
    if (tenpaiCandidates.length > 0) {
      return this.pickBestTenpaiDiscard(npc, tenpaiCandidates);
    }

    // 3. Heuristic tile efficiency scoring: discard the tile with the lowest usefulness score
    const counts = new Array(34).fill(0);
    for (const t of hand) {
      counts[tileToIndex(t)]++;
    }

    const roundWindIdx = windToIndex(state.round.wind);
    const seatWindIdx = windToIndex(seatWind);

    let worstTile = hand[hand.length - 1];
    let lowestScore = Infinity;

    for (const tile of hand) {
      const score = this.evaluateTileKeepValue(tile, counts, roundWindIdx, seatWindIdx);
      if (score < lowestScore) {
        lowestScore = score;
        worstTile = tile;
      }
    }

    return worstTile;
  }

  private getOpenOrClosedTenpaiDiscards(npc: PlayerState): TileInstance[] {
    const expected = 14 - npc.melds.length * 3;
    if (npc.hand.length !== expected) return [];
    const res: TileInstance[] = [];
    for (let i = 0; i < npc.hand.length; i++) {
      const rem = [...npc.hand.slice(0, i), ...npc.hand.slice(i + 1)];
      if (this.handEvaluator.getWinningTiles(rem, npc.melds).length > 0) {
        res.push(npc.hand[i]);
      }
    }
    return res;
  }

  private pickBestTenpaiDiscard(npc: PlayerState, candidates: TileInstance[]): TileInstance {
    let best = candidates[0];
    let maxWaits = -1;

    for (const cand of candidates) {
      const idx = npc.hand.findIndex(t => t.id === cand.id);
      if (idx === -1) continue;
      const rem = [...npc.hand.slice(0, idx), ...npc.hand.slice(idx + 1)];
      const waits = this.handEvaluator.getWinningTiles(rem, npc.melds).length;
      if (waits > maxWaits) {
        maxWaits = waits;
        best = cand;
      }
    }
    return best;
  }

  private evaluateTileKeepValue(
    tile: TileInstance,
    counts: number[],
    roundWindIdx: number,
    seatWindIdx: number
  ): number {
    const idx = tileToIndex(tile);
    const count = counts[idx];
    let score = 0;

    // Triplets and pairs
    if (count >= 3) score += 120;
    else if (count === 2) score += 55;

    // Honor tiles
    if (HONOR_INDICES.has(idx)) {
      const isYakuhai = idx === roundWindIdx || idx === seatWindIdx || idx >= 31;
      if (isYakuhai) {
        score += count >= 2 ? 25 : 4;
      } else {
        score += 0; // Isolated guest wind is discarded first
      }
      return score;
    }

    // Number tiles (0..26)
    const suitBase = Math.floor(idx / 9) * 9;
    const rank0 = idx % 9; // 0..8

    // Sequence connectivity within same suit
    if (rank0 >= 1 && counts[suitBase + rank0 - 1] > 0) {
      score += (rank0 >= 2 && rank0 <= 7) ? 45 : 32;
    }
    if (rank0 <= 7 && counts[suitBase + rank0 + 1] > 0) {
      score += (rank0 >= 1 && rank0 <= 6) ? 45 : 32;
    }
    if (rank0 >= 2 && counts[suitBase + rank0 - 2] > 0) {
      score += 20;
    }
    if (rank0 <= 6 && counts[suitBase + rank0 + 2] > 0) {
      score += 20;
    }

    // Centrality bonus (3..7 > 2,8 > 1,9)
    if (TERMINAL_INDICES.has(idx)) {
      score += 2;
    } else if (rank0 === 1 || rank0 === 7) {
      score += 6;
    } else {
      score += 10;
    }

    // Red dora bonus
    if (tile.isRed) {
      score += 12;
    }

    return score;
  }
}
