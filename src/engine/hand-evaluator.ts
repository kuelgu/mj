import { TileInstance, HonorType } from '../types/tiles.js';
import { Wind, Meld } from '../types/game-state.js';
import { HandEvaluation, HandPattern, TileSet, Yaku, YakuType } from '../types/scoring.js';

/**
 * Context required for full hand evaluation
 */
export interface HandEvaluationContext {
  hand: TileInstance[];
  melds?: Meld[];
  winningTile?: TileInstance;
  isTsumo: boolean;
  seatWind: Wind;
  roundWind: Wind;
  riichi?: boolean;
  doubleRiichi?: boolean;
  ippatsu?: boolean;
  rinshan?: boolean;
  chankan?: boolean;
  haitei?: boolean;
  houtei?: boolean;
  tenhou?: boolean;
  chiihou?: boolean;
  doraIndicators?: TileInstance[];
  uraDoraIndicators?: TileInstance[];
}

/**
 * Japanese display names for YakuType (for UI and logs)
 */
export const YAKU_NAMES_JA: Record<YakuType, string> = {
  riichi: '立直 (リーチ)',
  ippatsu: '一発',
  tsumo: '門前清自摸和',
  tanyao: '断么九 (タンヤオ)',
  pinfu: '平和 (ピンフ)',
  iipeikou: '一盃口 (イーペーコー)',
  bakaze: '役牌: 場風牌',
  jikaze: '役牌: 自風牌',
  haku: '役牌: 白',
  hatsu: '役牌: 發',
  chun: '役牌: 中',
  rinshan: '嶺上開花',
  chankan: '槍槓',
  haitei: '海底摸月',
  houtei: '河底撈魚',
  double_riichi: 'ダブル立直',
  sanshoku_doujun: '三色同順',
  ittsu: '一気通貫',
  chanta: '混全帯么九 (チャンタ)',
  chitoitsu: '七対子 (チートイツ)',
  toitoi: '対々和 (トイトイ)',
  sanankou: '三暗刻',
  sanshoku_doukou: '三色同刻',
  sankantsu: '三槓子',
  honroutou: '混老頭',
  shousangen: '小三元',
  honitsu: '混一色 (ホンイツ)',
  junchanta: '純全帯么九 (ジュンチャン)',
  ryanpeikou: '二盃口 (リャンペーコー)',
  chinitsu: '清一色 (チンイツ)',
  kokushi: '国士無双',
  suuankou: '四暗刻',
  daisangen: '大三元',
  shousuushi: '小四喜',
  daisuushi: '大四喜',
  tsuuiisou: '字一色',
  chinroutou: '清老頭',
  ryuuiisou: '緑一色',
  chuuren: '九蓮宝燈',
  suukantsu: '四槓子',
  tenhou: '天和',
  chiihou: '地和'
};

const HONOR_ORDER: HonorType[] = ['east', 'south', 'west', 'north', 'white', 'green', 'red'];
const TERMINAL_INDICES = new Set([0, 8, 9, 17, 18, 26]);
const HONOR_INDICES = new Set([27, 28, 29, 30, 31, 32, 33]);
const YAOCHUU_INDICES = new Set([0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]);
const GREEN_INDICES = new Set([19, 20, 21, 23, 25, 32]); // 2s, 3s, 4s, 6s, 8s, 發

/**
 * Convert a TileInstance to a 0..33 tile index
 */
export function tileToIndex(tile: Pick<TileInstance, 'suit' | 'rank' | 'honorType'>): number {
  if (tile.suit === 'man') return (tile.rank! - 1);
  if (tile.suit === 'pin') return 9 + (tile.rank! - 1);
  if (tile.suit === 'sou') return 18 + (tile.rank! - 1);
  const hIdx = HONOR_ORDER.indexOf(tile.honorType!);
  if (hIdx === -1) throw new Error(`Invalid honorType: ${tile.honorType}`);
  return 27 + hIdx;
}

/**
 * Convert a 0..33 tile index back to a dummy TileInstance
 */
export function indexToTile(idx: number, idPrefix = 'eval'): TileInstance {
  if (idx < 9) return { id: `${idPrefix}-${idx + 1}m`, suit: 'man', rank: idx + 1 };
  if (idx < 18) return { id: `${idPrefix}-${idx - 8}p`, suit: 'pin', rank: idx - 8 };
  if (idx < 27) return { id: `${idPrefix}-${idx - 17}s`, suit: 'sou', rank: idx - 17 };
  const honorType = HONOR_ORDER[idx - 27];
  return { id: `${idPrefix}-${honorType}`, suit: 'honor', honorType };
}

export function windToIndex(wind: Wind): number {
  return 27 + HONOR_ORDER.indexOf(wind);
}

/**
 * Given a dora indicator tile index, return the actual dora tile index
 */
export function getNextDoraIndex(indicatorIdx: number): number {
  if (indicatorIdx < 27) {
    const suitBase = Math.floor(indicatorIdx / 9) * 9;
    const nextRank = ((indicatorIdx % 9) + 1) % 9;
    return suitBase + nextRank;
  }
  if (indicatorIdx < 31) {
    // Winds: East(27) -> South(28) -> West(29) -> North(30) -> East(27)
    return 27 + ((indicatorIdx - 27 + 1) % 4);
  }
  // Dragons: White(31) -> Green(32) -> Red(33) -> White(31)
  return 31 + ((indicatorIdx - 31 + 1) % 3);
}

interface RawConcealedSet {
  type: 'shuntsu' | 'koutsu';
  indices: number[];
}

type WaitType = 'ryanmen' | 'shanpon' | 'kanchan' | 'penchan' | 'tanki';

/**
 * Pure Hand Evaluator for Japanese Riichi Mahjong
 */
export class HandEvaluator {
  /**
   * Evaluate a hand (13 + winningTile or 14 tiles, plus called melds)
   */
  evaluateHand(ctx: HandEvaluationContext): HandEvaluation {
    const melds = ctx.melds ?? [];
    const expectedHandTiles = 14 - melds.length * 3;

    // Combine concealed hand tiles + winningTile if hand currently has 13 - 3*melds tiles
    let concealedTiles = [...ctx.hand];
    let winTile: TileInstance | undefined = ctx.winningTile;

    if (concealedTiles.length === expectedHandTiles - 1 && winTile) {
      concealedTiles.push(winTile);
    } else if (concealedTiles.length === expectedHandTiles && !winTile) {
      winTile = concealedTiles[concealedTiles.length - 1];
    }

    if (concealedTiles.length !== expectedHandTiles || !winTile) {
      return this.nonWinningResult();
    }

    const winIdx = tileToIndex(winTile);
    const counts = new Array(34).fill(0);
    for (const t of concealedTiles) {
      counts[tileToIndex(t)]++;
    }

    // All tiles including melds (for dora, akaDora, suit/honor checks)
    const allTiles: TileInstance[] = [...concealedTiles];
    for (const m of melds) {
      allTiles.push(...m.tiles);
    }

    const dora = this.countDora(allTiles, ctx.doraIndicators ?? []);
    const uraDora = ctx.riichi || ctx.doubleRiichi
      ? this.countDora(allTiles, ctx.uraDoraIndicators ?? [])
      : 0;
    const akaDora = allTiles.filter(t => t.isRed).length;

    const allPatterns: HandPattern[] = [];
    let bestEval: HandEvaluation | null = null;

    // 1. Check Kokushi Musou (menzen only)
    if (melds.length === 0 && this.isKokushiCounts(counts)) {
      const pairIdx = Array.from(YAOCHUU_INDICES).find(i => counts[i] === 2)!;
      const kokushiPattern: HandPattern = {
        melds: [],
        pair: {
          type: 'jantou',
          tiles: this.pickTilesByIndices(concealedTiles, [pairIdx, pairIdx]),
          isConcealed: true
        },
        isChitoitsu: false,
        isKokushi: true
      };
      allPatterns.push(kokushiPattern);

      const yaku: Yaku[] = [{ type: 'kokushi', han: 13, isYakuman: true }];
      if (ctx.tenhou) yaku.push({ type: 'tenhou', han: 13, isYakuman: true });
      if (ctx.chiihou) yaku.push({ type: 'chiihou', han: 13, isYakuman: true });

      bestEval = {
        isWinningHand: true,
        patterns: [kokushiPattern],
        yaku,
        han: yaku.length * 13,
        fu: 30,
        yakuman: yaku.length,
        dora: 0,
        uraDora: 0,
        akaDora: 0
      };
    }

    // 2. Check Chitoitsu (menzen only, 7 distinct pairs)
    if (melds.length === 0 && this.isChitoitsuCounts(counts)) {
      const pairIndices: number[] = [];
      for (let i = 0; i < 34; i++) {
        if (counts[i] === 2) pairIndices.push(i);
      }
      const chitoiPattern: HandPattern = {
        melds: pairIndices.slice(1).map(idx => ({
          type: 'koutsu', // Stored in melds for pattern structure
          tiles: this.pickTilesByIndices(concealedTiles, [idx, idx]),
          isConcealed: true
        })),
        pair: {
          type: 'jantou',
          tiles: this.pickTilesByIndices(concealedTiles, [pairIndices[0], pairIndices[0]]),
          isConcealed: true
        },
        isChitoitsu: true,
        isKokushi: false
      };
      allPatterns.push(chitoiPattern);

      const chitoiEval = this.evaluateChitoitsuPattern(
        chitoiPattern,
        counts,
        ctx,
        dora,
        uraDora,
        akaDora
      );
      if (this.isBetterEvaluation(chitoiEval, bestEval)) {
        bestEval = chitoiEval;
      }
    }

    // 3. Check Standard 4 Mentsu + 1 Jantou decompositions
    const targetConcealedSets = 4 - melds.length;
    const rawDecompositions = this.findStandardDecompositions(counts, targetConcealedSets);

    const calledTileSets: TileSet[] = melds.map(m => ({
      type: (m.type === 'kan' || m.type === 'ankan' || m.type === 'kakan')
        ? 'kantsu'
        : m.type === 'chi'
          ? 'shuntsu'
          : 'koutsu',
      tiles: m.tiles,
      isConcealed: m.type === 'ankan'
    }));

    for (const decomp of rawDecompositions) {
      // Build base pattern
      const concealedTileSets: TileSet[] = decomp.sets.map(s => ({
        type: s.type,
        tiles: s.indices.map(idx => indexToTile(idx)),
        isConcealed: true
      }));
      const pairSet: TileSet = {
        type: 'jantou',
        tiles: [indexToTile(decomp.pairIdx), indexToTile(decomp.pairIdx)],
        isConcealed: true
      };

      const basePattern: HandPattern = {
        melds: [...concealedTileSets, ...calledTileSets],
        pair: pairSet,
        isChitoitsu: false,
        isKokushi: false
      };
      allPatterns.push(basePattern);

      // Test every possible wait block in concealed sets or pair that contains winIdx
      // 3a. Wait on the pair (tanki wait)
      if (decomp.pairIdx === winIdx) {
        const evalCandidate = this.evaluateStandardPattern(
          basePattern,
          concealedTileSets,
          calledTileSets,
          pairSet,
          'tanki',
          counts,
          allTiles,
          ctx,
          dora,
          uraDora,
          akaDora
        );
        if (this.isBetterEvaluation(evalCandidate, bestEval)) {
          bestEval = evalCandidate;
        }
      }

      // 3b. Wait on each concealed set containing winIdx
      for (let sIdx = 0; sIdx < decomp.sets.length; sIdx++) {
        const rawSet = decomp.sets[sIdx];
        if (!rawSet.indices.includes(winIdx)) continue;

        let waitType: WaitType;
        const adjustedConcealedSets = concealedTileSets.map((cs, i) => ({
          ...cs,
          // If Ron completes a koutsu, that koutsu is treated as open (isConcealed = false)
          isConcealed: (i === sIdx && rawSet.type === 'koutsu' && !ctx.isTsumo) ? false : true
        }));

        if (rawSet.type === 'koutsu') {
          waitType = 'shanpon';
        } else {
          const [a, b, c] = rawSet.indices;
          if (winIdx === b) {
            waitType = 'kanchan';
          } else if ((a % 9 === 0 && winIdx === c) || (a % 9 === 6 && winIdx === a)) {
            waitType = 'penchan';
          } else {
            waitType = 'ryanmen';
          }
        }

        const adjustedPattern: HandPattern = {
          melds: [...adjustedConcealedSets, ...calledTileSets],
          pair: pairSet,
          isChitoitsu: false,
          isKokushi: false
        };

        const evalCandidate = this.evaluateStandardPattern(
          adjustedPattern,
          adjustedConcealedSets,
          calledTileSets,
          pairSet,
          waitType,
          counts,
          allTiles,
          ctx,
          dora,
          uraDora,
          akaDora
        );
        if (this.isBetterEvaluation(evalCandidate, bestEval)) {
          bestEval = evalCandidate;
        }
      }
    }

    if (!bestEval) {
      return this.nonWinningResult();
    }

    // Attach all valid structural patterns found
    bestEval.patterns = allPatterns;

    // A winning hand in Riichi Mahjong must have at least 1 yaku (dora alone is not a yaku)
    if (bestEval.yaku.length === 0) {
      return {
        ...bestEval,
        isWinningHand: false
      };
    }

    return bestEval;
  }

  /**
   * Check if a 13-tile hand (plus called melds) is in Tenpai, and return all winning tile types
   */
  getWinningTiles(hand: TileInstance[], melds: Meld[] = []): TileInstance[] {
    const expected = 13 - melds.length * 3;
    if (hand.length !== expected) return [];

    const counts = new Array(34).fill(0);
    for (const t of hand) {
      counts[tileToIndex(t)]++;
    }
    for (const m of melds) {
      for (const t of m.tiles) {
        counts[tileToIndex(t)]++;
      }
    }

    const winningTiles: TileInstance[] = [];
    for (let idx = 0; idx < 34; idx++) {
      if (counts[idx] >= 4) continue; // All 4 copies already in hand
      const testTile = indexToTile(idx, 'wait');
      const testHand = [...hand, testTile];
      if (this.isWinningStructure(testHand, melds)) {
        winningTiles.push(testTile);
      }
    }
    return winningTiles;
  }

  /**
   * For a 14-tile hand (or 14 - melds*3 with ankan only), return all tiles in hand
   * that can be discarded to leave a valid Tenpai hand for Riichi declaration.
   */
  getRiichiDiscardCandidates(hand: TileInstance[], melds: Meld[] = []): TileInstance[] {
    if (melds.some(m => m.type !== 'ankan')) {
      return []; // Open hand cannot declare riichi
    }
    const expected = 14 - melds.length * 3;
    if (hand.length !== expected) return [];

    const candidates: TileInstance[] = [];
    for (let i = 0; i < hand.length; i++) {
      const remaining = [...hand.slice(0, i), ...hand.slice(i + 1)];
      if (this.getWinningTiles(remaining, melds).length > 0) {
        candidates.push(hand[i]);
      }
    }
    return candidates;
  }

  /**
   * Check if a player's 13-tile hand is in Discard Furiten (捨牌フリテン)
   */
  isDiscardFuriten(hand: TileInstance[], melds: Meld[], discards: TileInstance[]): boolean {
    const winningTiles = this.getWinningTiles(hand, melds);
    if (winningTiles.length === 0) return false;
    const winningIndices = new Set(winningTiles.map(t => tileToIndex(t)));
    return discards.some(d => winningIndices.has(tileToIndex(d)));
  }

  /**
   * Pure structural check (4 mentsu + 1 jantou, chitoitsu, or kokushi) regardless of yaku
   */
  isWinningStructure(hand: TileInstance[], melds: Meld[] = []): boolean {
    const expected = 14 - melds.length * 3;
    if (hand.length !== expected) return false;

    const counts = new Array(34).fill(0);
    for (const t of hand) {
      counts[tileToIndex(t)]++;
    }

    if (melds.length === 0) {
      if (this.isKokushiCounts(counts)) return true;
      if (this.isChitoitsuCounts(counts)) return true;
    }

    const decomp = this.findStandardDecompositions(counts, 4 - melds.length);
    return decomp.length > 0;
  }

  /**
   * Evaluate Chitoitsu yaku and fu (always 25 fu)
   */
  private evaluateChitoitsuPattern(
    pattern: HandPattern,
    counts: number[],
    ctx: HandEvaluationContext,
    dora: number,
    uraDora: number,
    akaDora: number
  ): HandEvaluation {
    // Check Yakuman possible with 7 pairs (Tenhou, Chiihou, Tsuuiisou)
    const yakumanYaku: Yaku[] = [];
    if (ctx.tenhou) yakumanYaku.push({ type: 'tenhou', han: 13, isYakuman: true });
    if (ctx.chiihou) yakumanYaku.push({ type: 'chiihou', han: 13, isYakuman: true });

    const allIndices = this.getActiveIndices(counts);
    if (allIndices.every(i => HONOR_INDICES.has(i))) {
      yakumanYaku.push({ type: 'tsuuiisou', han: 13, isYakuman: true });
    }

    if (yakumanYaku.length > 0) {
      return {
        isWinningHand: true,
        patterns: [pattern],
        yaku: yakumanYaku,
        han: yakumanYaku.length * 13,
        fu: 25,
        yakuman: yakumanYaku.length,
        dora: 0,
        uraDora: 0,
        akaDora: 0
      };
    }

    const yaku: Yaku[] = [];
    this.addSituationalYaku(yaku, ctx, true);
    yaku.push({ type: 'chitoitsu', han: 2, isYakuman: false });

    // Tanyao
    if (allIndices.every(i => !YAOCHUU_INDICES.has(i))) {
      yaku.push({ type: 'tanyao', han: 1, isYakuman: false });
    }

    // Honroutou (terminals + honors only)
    if (allIndices.every(i => YAOCHUU_INDICES.has(i))) {
      yaku.push({ type: 'honroutou', han: 2, isYakuman: false });
    }

    // Flush (Chinitsu / Honitsu)
    const flushYaku = this.checkFlushYaku(allIndices, true);
    if (flushYaku) yaku.push(flushYaku);

    const yakuHan = yaku.reduce((sum, y) => sum + y.han, 0);
    return {
      isWinningHand: yaku.length > 0,
      patterns: [pattern],
      yaku,
      han: yakuHan,
      fu: 25,
      yakuman: 0,
      dora,
      uraDora,
      akaDora
    };
  }

  /**
   * Evaluate standard 4-mentsu + 1-jantou pattern
   */
  private evaluateStandardPattern(
    pattern: HandPattern,
    concealedSets: TileSet[],
    calledSets: TileSet[],
    pairSet: TileSet,
    waitType: WaitType,
    concealedCounts: number[],
    allTiles: TileInstance[],
    ctx: HandEvaluationContext,
    dora: number,
    uraDora: number,
    akaDora: number
  ): HandEvaluation {
    const allSets = [...concealedSets, ...calledSets];
    const isMenzen = calledSets.every(s => s.isConcealed);

    const allCounts = new Array(34).fill(0);
    for (const t of allTiles) {
      allCounts[tileToIndex(t)]++;
    }
    const allIndices = this.getActiveIndices(allCounts);

    // ---- 1. Check Yakuman ----
    const yakumanYaku: Yaku[] = [];
    if (ctx.tenhou) yakumanYaku.push({ type: 'tenhou', han: 13, isYakuman: true });
    if (ctx.chiihou) yakumanYaku.push({ type: 'chiihou', han: 13, isYakuman: true });

    // Suuankou (4 concealed triplets/kans)
    const ankouCount = allSets.filter(s => (s.type === 'koutsu' || s.type === 'kantsu') && s.isConcealed).length;
    if (isMenzen && ankouCount === 4) {
      yakumanYaku.push({ type: 'suuankou', han: 13, isYakuman: true });
    }

    // Daisangen (3 dragon triplets/kans)
    const dragonTriplets = allSets.filter(s => {
      if (s.type !== 'koutsu' && s.type !== 'kantsu') return false;
      const idx = tileToIndex(s.tiles[0]);
      return idx >= 31 && idx <= 33;
    }).length;
    if (dragonTriplets === 3) {
      yakumanYaku.push({ type: 'daisangen', han: 13, isYakuman: true });
    }

    // Shousuushi / Daisuushi (Wind triplets/kans)
    const windTriplets = allSets.filter(s => {
      if (s.type !== 'koutsu' && s.type !== 'kantsu') return false;
      const idx = tileToIndex(s.tiles[0]);
      return idx >= 27 && idx <= 30;
    }).length;
    const pairIdx = tileToIndex(pairSet.tiles[0]);
    if (windTriplets === 4) {
      yakumanYaku.push({ type: 'daisuushi', han: 13, isYakuman: true });
    } else if (windTriplets === 3 && pairIdx >= 27 && pairIdx <= 30) {
      yakumanYaku.push({ type: 'shousuushi', han: 13, isYakuman: true });
    }

    // Tsuuiisou (All honors)
    if (allIndices.every(i => HONOR_INDICES.has(i))) {
      yakumanYaku.push({ type: 'tsuuiisou', han: 13, isYakuman: true });
    }

    // Chinroutou (All terminals)
    if (allIndices.every(i => TERMINAL_INDICES.has(i))) {
      yakumanYaku.push({ type: 'chinroutou', han: 13, isYakuman: true });
    }

    // Ryuuiisou (All green)
    if (allIndices.every(i => GREEN_INDICES.has(i))) {
      yakumanYaku.push({ type: 'ryuuiisou', han: 13, isYakuman: true });
    }

    // Chuuren Poutou (Nine gates: menzen, single suit, 1112345678999 + 1)
    if (isMenzen && this.isChuurenCounts(concealedCounts)) {
      yakumanYaku.push({ type: 'chuuren', han: 13, isYakuman: true });
    }

    // Suukantsu (4 kans)
    const kantsuCount = allSets.filter(s => s.type === 'kantsu').length;
    if (kantsuCount === 4) {
      yakumanYaku.push({ type: 'suukantsu', han: 13, isYakuman: true });
    }

    if (yakumanYaku.length > 0) {
      return {
        isWinningHand: true,
        patterns: [pattern],
        yaku: yakumanYaku,
        han: yakumanYaku.length * 13,
        fu: 30,
        yakuman: yakumanYaku.length,
        dora: 0,
        uraDora: 0,
        akaDora: 0
      };
    }

    // ---- 2. Normal Yaku ----
    const yaku: Yaku[] = [];
    this.addSituationalYaku(yaku, ctx, isMenzen);

    const shuntsuSets = allSets.filter(s => s.type === 'shuntsu');
    const koutsuSets = allSets.filter(s => s.type === 'koutsu' || s.type === 'kantsu');

    const roundWindIdx = windToIndex(ctx.roundWind);
    const seatWindIdx = windToIndex(ctx.seatWind);

    // Pinfu check: menzen (no called sets including ankan), 4 shuntsu, non-yakuhai pair, ryanmen wait
    const isValuePair =
      pairIdx === roundWindIdx ||
      pairIdx === seatWindIdx ||
      (pairIdx >= 31 && pairIdx <= 33);
    const isPinfu =
      isMenzen &&
      calledSets.length === 0 &&
      shuntsuSets.length === 4 &&
      !isValuePair &&
      waitType === 'ryanmen';

    if (isPinfu) {
      yaku.push({ type: 'pinfu', han: 1, isYakuman: false });
    }

    // Tanyao (all tiles 2..8)
    if (allIndices.every(i => !YAOCHUU_INDICES.has(i))) {
      yaku.push({ type: 'tanyao', han: 1, isYakuman: false });
    }

    // Iipeikou / Ryanpeikou (menzen only)
    if (isMenzen && shuntsuSets.length >= 2) {
      const shuntsuStarts = shuntsuSets.map(s => tileToIndex(s.tiles[0])).sort((a, b) => a - b);
      const peikouCount = this.countIdenticalPairs(shuntsuStarts);
      if (peikouCount === 2) {
        yaku.push({ type: 'ryanpeikou', han: 3, isYakuman: false });
      } else if (peikouCount === 1) {
        yaku.push({ type: 'iipeikou', han: 1, isYakuman: false });
      }
    }

    // Yakuhai (winds & dragons)
    for (const ks of koutsuSets) {
      const idx = tileToIndex(ks.tiles[0]);
      if (idx === roundWindIdx) {
        yaku.push({ type: 'bakaze', han: 1, isYakuman: false });
      }
      if (idx === seatWindIdx) {
        yaku.push({ type: 'jikaze', han: 1, isYakuman: false });
      }
      if (idx === 31) yaku.push({ type: 'haku', han: 1, isYakuman: false });
      if (idx === 32) yaku.push({ type: 'hatsu', han: 1, isYakuman: false });
      if (idx === 33) yaku.push({ type: 'chun', han: 1, isYakuman: false });
    }

    // Sanshoku Doujun (same rank sequence in man, pin, sou)
    if (shuntsuSets.length >= 3) {
      const starts = new Set(shuntsuSets.map(s => tileToIndex(s.tiles[0])));
      for (let r = 0; r <= 6; r++) {
        if (starts.has(r) && starts.has(r + 9) && starts.has(r + 18)) {
          yaku.push({ type: 'sanshoku_doujun', han: isMenzen ? 2 : 1, isYakuman: false });
          break;
        }
      }
    }

    // Ittsu (123, 456, 789 in the same suit)
    if (shuntsuSets.length >= 3) {
      const starts = new Set(shuntsuSets.map(s => tileToIndex(s.tiles[0])));
      for (const suitBase of [0, 9, 18]) {
        if (starts.has(suitBase) && starts.has(suitBase + 3) && starts.has(suitBase + 6)) {
          yaku.push({ type: 'ittsu', han: isMenzen ? 2 : 1, isYakuman: false });
          break;
        }
      }
    }

    // Toitoi (4 triplets/kans)
    if (koutsuSets.length === 4) {
      yaku.push({ type: 'toitoi', han: 2, isYakuman: false });
    }

    // Sanankou (3 concealed triplets/kans)
    if (ankouCount === 3) {
      yaku.push({ type: 'sanankou', han: 2, isYakuman: false });
    }

    // Sanshoku Doukou (same rank triplet in man, pin, sou)
    if (koutsuSets.length >= 3) {
      const tripletIndices = new Set(koutsuSets.map(s => tileToIndex(s.tiles[0])));
      for (let r = 0; r < 9; r++) {
        if (tripletIndices.has(r) && tripletIndices.has(r + 9) && tripletIndices.has(r + 18)) {
          yaku.push({ type: 'sanshoku_doukou', han: 2, isYakuman: false });
          break;
        }
      }
    }

    // Sankantsu (3 kans)
    if (kantsuCount === 3) {
      yaku.push({ type: 'sankantsu', han: 2, isYakuman: false });
    }

    // Shousangen (2 dragon triplets/kans + dragon pair)
    if (dragonTriplets === 2 && pairIdx >= 31 && pairIdx <= 33) {
      yaku.push({ type: 'shousangen', han: 2, isYakuman: false });
    }

    // Honroutou / Junchanta / Chanta
    const allBlocksHaveYaochuu =
      this.blockHasYaochuu(pairSet) &&
      allSets.every(s => this.blockHasYaochuu(s));
    const allBlocksHaveTerminal =
      this.blockHasTerminal(pairSet) &&
      allSets.every(s => this.blockHasTerminal(s));

    if (allIndices.every(i => YAOCHUU_INDICES.has(i))) {
      // Every tile is terminal or honor (no shuntsu possible) -> Honroutou
      yaku.push({ type: 'honroutou', han: 2, isYakuman: false });
    } else if (allBlocksHaveTerminal && shuntsuSets.length >= 1) {
      // Every block has a terminal (1 or 9) and at least one shuntsu -> Junchanta
      yaku.push({ type: 'junchanta', han: isMenzen ? 3 : 2, isYakuman: false });
    } else if (allBlocksHaveYaochuu && shuntsuSets.length >= 1) {
      // Every block has terminal or honor and at least one shuntsu -> Chanta
      yaku.push({ type: 'chanta', han: isMenzen ? 2 : 1, isYakuman: false });
    }

    // Flush (Chinitsu / Honitsu)
    const flushYaku = this.checkFlushYaku(allIndices, isMenzen);
    if (flushYaku) yaku.push(flushYaku);

    // ---- 3. Fu Calculation ----
    const fu = this.calculateStandardFu(
      allSets,
      pairIdx,
      waitType,
      isMenzen,
      ctx.isTsumo,
      isPinfu,
      roundWindIdx,
      seatWindIdx
    );

    const yakuHan = yaku.reduce((sum, y) => sum + y.han, 0);
    return {
      isWinningHand: yaku.length > 0,
      patterns: [pattern],
      yaku,
      han: yakuHan,
      fu,
      yakuman: 0,
      dora,
      uraDora,
      akaDora
    };
  }

  /**
   * Calculate Fu for a standard 4-mentsu 1-jantou hand
   */
  private calculateStandardFu(
    allSets: TileSet[],
    pairIdx: number,
    waitType: WaitType,
    isMenzen: boolean,
    isTsumo: boolean,
    isPinfu: boolean,
    roundWindIdx: number,
    seatWindIdx: number
  ): number {
    if (isPinfu && isTsumo) return 20;
    if (isPinfu && !isTsumo) return 30;

    let fu = 20; // Base fu (副底)

    // Menzen Ron bonus (+10 fu)
    if (isMenzen && !isTsumo) {
      fu += 10;
    }

    // Tsumo bonus (+2 fu, except pinfu)
    if (isTsumo && !isPinfu) {
      fu += 2;
    }

    // Wait bonus (+2 fu for tanki, kanchan, penchan)
    if (waitType === 'tanki' || waitType === 'kanchan' || waitType === 'penchan') {
      fu += 2;
    }

    // Pair bonus (+2 fu for dragon, round wind, seat wind; +4 if double wind)
    if (pairIdx >= 31 && pairIdx <= 33) {
      fu += 2;
    } else {
      if (pairIdx === roundWindIdx) fu += 2;
      if (pairIdx === seatWindIdx) fu += 2;
    }

    // Meld bonuses
    for (const s of allSets) {
      if (s.type === 'shuntsu') continue;
      const idx = tileToIndex(s.tiles[0]);
      const isYaochuu = YAOCHUU_INDICES.has(idx);
      let base = isYaochuu ? 4 : 2;
      if (s.isConcealed) base *= 2;
      if (s.type === 'kantsu') base *= 4;
      fu += base;
    }

    // Open Pinfu-style hand (20 fu with open melds) rounds up to 30 fu
    if (!isMenzen && fu === 20) {
      return 30;
    }

    return Math.ceil(fu / 10) * 10;
  }

  /**
   * Add situational yaku (riichi, ippatsu, menzen tsumo, rinshan, chankan, haitei, houtei)
   */
  private addSituationalYaku(yaku: Yaku[], ctx: HandEvaluationContext, isMenzen: boolean): void {
    if (ctx.doubleRiichi) {
      yaku.push({ type: 'double_riichi', han: 2, isYakuman: false });
    } else if (ctx.riichi) {
      yaku.push({ type: 'riichi', han: 1, isYakuman: false });
    }

    if (ctx.ippatsu && (ctx.riichi || ctx.doubleRiichi)) {
      yaku.push({ type: 'ippatsu', han: 1, isYakuman: false });
    }

    if (ctx.isTsumo && isMenzen) {
      yaku.push({ type: 'tsumo', han: 1, isYakuman: false });
    }

    if (ctx.rinshan) {
      yaku.push({ type: 'rinshan', han: 1, isYakuman: false });
    }

    if (ctx.chankan) {
      yaku.push({ type: 'chankan', han: 1, isYakuman: false });
    }

    if (ctx.haitei && ctx.isTsumo) {
      yaku.push({ type: 'haitei', han: 1, isYakuman: false });
    }

    if (ctx.houtei && !ctx.isTsumo) {
      yaku.push({ type: 'houtei', han: 1, isYakuman: false });
    }
  }

  /**
   * Check Chinitsu or Honitsu
   */
  private checkFlushYaku(allIndices: number[], isMenzen: boolean): Yaku | null {
    const suits = new Set<number>();
    let hasHonors = false;
    for (const idx of allIndices) {
      if (idx >= 27) {
        hasHonors = true;
      } else {
        suits.add(Math.floor(idx / 9));
      }
    }

    if (suits.size === 1 && !hasHonors) {
      return { type: 'chinitsu', han: isMenzen ? 6 : 5, isYakuman: false };
    }
    if (suits.size === 1 && hasHonors) {
      return { type: 'honitsu', han: isMenzen ? 3 : 2, isYakuman: false };
    }
    return null;
  }

  private blockHasYaochuu(set: TileSet): boolean {
    return set.tiles.some(t => YAOCHUU_INDICES.has(tileToIndex(t)));
  }

  private blockHasTerminal(set: TileSet): boolean {
    return set.tiles.some(t => TERMINAL_INDICES.has(tileToIndex(t)));
  }

  private countIdenticalPairs(sortedStarts: number[]): number {
    const used = new Array(sortedStarts.length).fill(false);
    let pairs = 0;
    for (let i = 0; i < sortedStarts.length; i++) {
      if (used[i]) continue;
      for (let j = i + 1; j < sortedStarts.length; j++) {
        if (!used[j] && sortedStarts[i] === sortedStarts[j]) {
          used[i] = true;
          used[j] = true;
          pairs++;
          break;
        }
      }
    }
    return pairs;
  }

  private isKokushiCounts(counts: number[]): boolean {
    let pairFound = false;
    for (let i = 0; i < 34; i++) {
      if (YAOCHUU_INDICES.has(i)) {
        if (counts[i] === 0) return false;
        if (counts[i] === 2) pairFound = true;
        if (counts[i] > 2) return false;
      } else {
        if (counts[i] > 0) return false;
      }
    }
    return pairFound;
  }

  private isChitoitsuCounts(counts: number[]): boolean {
    let pairs = 0;
    for (let i = 0; i < 34; i++) {
      if (counts[i] === 2) pairs++;
      else if (counts[i] !== 0) return false;
    }
    return pairs === 7;
  }

  private isChuurenCounts(counts: number[]): boolean {
    for (const suitBase of [0, 9, 18]) {
      let totalInSuit = 0;
      for (let r = 0; r < 9; r++) {
        totalInSuit += counts[suitBase + r];
      }
      if (totalInSuit !== 14) continue;
      if (counts[suitBase] < 3 || counts[suitBase + 8] < 3) return false;
      for (let r = 1; r <= 7; r++) {
        if (counts[suitBase + r] < 1) return false;
      }
      return true;
    }
    return false;
  }

  /**
   * Find all standard decompositions (pairIdx + list of concealed sets)
   */
  private findStandardDecompositions(
    counts: number[],
    targetSets: number
  ): Array<{ pairIdx: number; sets: RawConcealedSet[] }> {
    const results: Array<{ pairIdx: number; sets: RawConcealedSet[] }> = [];

    for (let pairIdx = 0; pairIdx < 34; pairIdx++) {
      if (counts[pairIdx] >= 2) {
        counts[pairIdx] -= 2;
        const foundSets: RawConcealedSet[][] = [];
        this.extractSets(counts, targetSets, 0, [], foundSets);
        for (const sets of foundSets) {
          results.push({ pairIdx, sets });
        }
        counts[pairIdx] += 2;
      }
    }

    return results;
  }

  private extractSets(
    counts: number[],
    remainingSets: number,
    minCode: number,
    current: RawConcealedSet[],
    out: RawConcealedSet[][]
  ): void {
    if (remainingSets === 0) {
      out.push([...current]);
      return;
    }

    // Find first non-zero tile index
    let firstIdx = -1;
    for (let i = 0; i < 34; i++) {
      if (counts[i] > 0) {
        firstIdx = i;
        break;
      }
    }
    if (firstIdx === -1) return;

    // 1. Try Koutsu at firstIdx (code = firstIdx * 2)
    const koutsuCode = firstIdx * 2;
    if (counts[firstIdx] >= 3 && koutsuCode >= minCode) {
      counts[firstIdx] -= 3;
      current.push({ type: 'koutsu', indices: [firstIdx, firstIdx, firstIdx] });
      this.extractSets(counts, remainingSets - 1, koutsuCode, current, out);
      current.pop();
      counts[firstIdx] += 3;
    }

    // 2. Try Shuntsu starting at firstIdx (code = firstIdx * 2 + 1)
    const shuntsuCode = firstIdx * 2 + 1;
    if (
      firstIdx < 27 &&
      (firstIdx % 9) <= 6 &&
      counts[firstIdx + 1] > 0 &&
      counts[firstIdx + 2] > 0 &&
      shuntsuCode >= minCode
    ) {
      counts[firstIdx]--;
      counts[firstIdx + 1]--;
      counts[firstIdx + 2]--;
      current.push({ type: 'shuntsu', indices: [firstIdx, firstIdx + 1, firstIdx + 2] });
      this.extractSets(counts, remainingSets - 1, shuntsuCode, current, out);
      current.pop();
      counts[firstIdx]++;
      counts[firstIdx + 1]++;
      counts[firstIdx + 2]++;
    }
  }

  private countDora(allTiles: TileInstance[], indicators: TileInstance[]): number {
    let total = 0;
    for (const ind of indicators) {
      const doraIdx = getNextDoraIndex(tileToIndex(ind));
      for (const t of allTiles) {
        if (tileToIndex(t) === doraIdx) {
          total++;
        }
      }
    }
    return total;
  }

  private getActiveIndices(counts: number[]): number[] {
    const res: number[] = [];
    for (let i = 0; i < 34; i++) {
      if (counts[i] > 0) res.push(i);
    }
    return res;
  }

  private pickTilesByIndices(pool: TileInstance[], indices: number[]): TileInstance[] {
    const used = new Set<number>();
    const res: TileInstance[] = [];
    for (const targetIdx of indices) {
      const found = pool.findIndex((t, i) => !used.has(i) && tileToIndex(t) === targetIdx);
      if (found !== -1) {
        used.add(found);
        res.push(pool[found]);
      } else {
        res.push(indexToTile(targetIdx));
      }
    }
    return res;
  }

  /**
   * Compare two HandEvaluations using High-Point Method (高点法)
   */
  private isBetterEvaluation(candidate: HandEvaluation, current: HandEvaluation | null): boolean {
    if (!current) return true;
    // Prefer hand with valid yaku over no yaku
    const candHasYaku = candidate.yaku.length > 0 ? 1 : 0;
    const currHasYaku = current.yaku.length > 0 ? 1 : 0;
    if (candHasYaku !== currHasYaku) return candHasYaku > currHasYaku;

    if (candidate.yakuman !== current.yakuman) return candidate.yakuman > current.yakuman;

    const candPoints = candidate.fu * Math.pow(2, 2 + candidate.han + candidate.dora + candidate.uraDora + candidate.akaDora);
    const currPoints = current.fu * Math.pow(2, 2 + current.han + current.dora + current.uraDora + current.akaDora);
    if (candPoints !== currPoints) return candPoints > currPoints;

    if (candidate.han !== current.han) return candidate.han > current.han;
    return candidate.fu > current.fu;
  }

  private nonWinningResult(): HandEvaluation {
    return {
      isWinningHand: false,
      patterns: [],
      yaku: [],
      han: 0,
      fu: 0,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };
  }
}
