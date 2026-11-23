import { RuleConfig } from '../config/rule-config.js';
import { ScoreCalculation, HandEvaluation, WinPayment, PaoInfo, Yaku } from '../types/scoring.js';
import { Wind, Meld } from '../types/game-state.js';
import { HandEvaluator, HandEvaluationContext, tileToIndex } from './hand-evaluator.js';

/**
 * Pure scoring engine - no side effects, only calculations
 */
export class ScoringEngine {
  private handEvaluator = new HandEvaluator();

  constructor(private rules: RuleConfig) { }

  /**
   * Evaluate a real hand for winning pattern, yaku, fu, and dora
   */
  evaluateHand(ctx: HandEvaluationContext): HandEvaluation {
    return this.handEvaluator.evaluateHand(ctx);
  }

  getHandEvaluator(): HandEvaluator {
    return this.handEvaluator;
  }

  /**
   * Calculate score for a winning hand
   * BRANCHING POINTS:
   * - KIRIAGE_MANGAN_CHECK
   * - KAZOE_YAKUMAN_CHECK
   */
  calculateScore(
    hand: HandEvaluation,
    isDealer: boolean,
    isTsumo: boolean
  ): ScoreCalculation {
    const totalHan = hand.han + hand.dora + hand.uraDora + hand.akaDora;
    let fu = hand.fu;
    let yakuman = hand.yakuman;

    // BRANCHING POINT: KAZOE_YAKUMAN_CHECK
    const isKazoeYakuman = this.checkKazoeYakuman(totalHan, yakuman);
    if (isKazoeYakuman) {
      yakuman = 1;
    }

    // BRANCHING POINT: KIRIAGE_MANGAN_CHECK
    const isKiriageMangan = this.checkKiriageMangan(totalHan, fu);

    // Calculate basic points and final score
    const { score, limitName, basicPoints } = this.calculateFinalScore(
      totalHan,
      fu,
      yakuman,
      isDealer,
      isTsumo,
      isKiriageMangan
    );

    // Calculate payment amounts
    const dealerScore = isDealer ? {
      tsumo: Math.ceil(score / 3 / 100) * 100,
      ron: score
    } : undefined;

    const nonDealerScore = !isDealer ? {
      tsumo: Math.ceil(score / 4 / 100) * 100,
      tsumoFromDealer: Math.ceil((score / 2) / 100) * 100,
      ron: score
    } : undefined;

    return {
      hand,
      basicPoints,
      han: totalHan,
      fu,
      score,
      dealerScore,
      nonDealerScore,
      isKiriageMangan,
      isKazoeYakuman,
      limitName
    };
  }

  /**
   * BRANCHING POINT: KIRIAGE_MANGAN_CHECK
   * Check if hand qualifies for kiriage mangan
   */
  private checkKiriageMangan(han: number, fu: number): boolean {
    if (!this.rules.scoring.kiriageMangan) {
      return false;
    }

    // 4 han 30 fu or 3 han 60 fu rounds up to mangan
    return (han === 4 && fu === 30) || (han === 3 && fu === 60);
  }

  /**
   * BRANCHING POINT: KAZOE_YAKUMAN_CHECK
   * Check if 13+ han counts as yakuman
   */
  private checkKazoeYakuman(han: number, yakuman: number): boolean {
    if (yakuman > 0) {
      return false; // Already yakuman
    }

    if (han < 13) {
      return false;
    }

    return this.rules.scoring.kazoeYakuman === 'yakuman';
  }

  /**
   * Calculate final score based on han, fu, and limits
   */
  private calculateFinalScore(
    han: number,
    fu: number,
    yakuman: number,
    isDealer: boolean,
    isTsumo: boolean,
    isKiriageMangan: boolean
  ): { score: number; limitName?: 'mangan' | 'haneman' | 'baiman' | 'sanbaiman' | 'yakuman' | 'double_yakuman' | 'triple_yakuman'; basicPoints: number } {
    // Yakuman
    if (yakuman > 0) {
      const baseYakuman = isDealer ? 48000 : 32000;
      const limitName: 'yakuman' | 'double_yakuman' | 'triple_yakuman' =
        yakuman === 1 ? 'yakuman' : yakuman === 2 ? 'double_yakuman' : 'triple_yakuman';
      return {
        score: baseYakuman * yakuman,
        limitName,
        basicPoints: 0
      };
    }

    // Kiriage mangan
    if (isKiriageMangan) {
      return {
        score: isDealer ? 12000 : 8000,
        limitName: 'mangan',
        basicPoints: fu
      };
    }

    // Check for limit hands
    if (han >= 13) {
      // Kazoe yakuman as sanbaiman (if not treated as yakuman)
      if (this.rules.scoring.kazoeYakuman === 'limit') {
        return {
          score: isDealer ? 36000 : 24000,
          limitName: 'sanbaiman',
          basicPoints: 0
        };
      }
      // Unlimited - should not reach here normally
    }

    if (han >= 11) {
      return {
        score: isDealer ? 36000 : 24000,
        limitName: 'sanbaiman',
        basicPoints: 0
      };
    }

    if (han >= 8) {
      return {
        score: isDealer ? 24000 : 16000,
        limitName: 'baiman',
        basicPoints: 0
      };
    }

    if (han >= 6) {
      return {
        score: isDealer ? 18000 : 12000,
        limitName: 'haneman',
        basicPoints: 0
      };
    }

    if (han >= 5) {
      return {
        score: isDealer ? 12000 : 8000,
        limitName: 'mangan',
        basicPoints: 0
      };
    }

    // Calculate basic points
    const basicPoints = fu * Math.pow(2, 2 + han);

    // Cap at mangan
    if (basicPoints >= 2000) {
      return {
        score: isDealer ? 12000 : 8000,
        limitName: 'mangan',
        basicPoints: fu
      };
    }

    // Normal score calculation
    let score: number;
    if (isDealer) {
      score = isTsumo
        ? Math.ceil((basicPoints * 2) / 100) * 100 * 3
        : Math.ceil((basicPoints * 6) / 100) * 100;
    } else {
      score = isTsumo
        ? Math.ceil((basicPoints * 2) / 100) * 100 * 2 + Math.ceil(basicPoints / 100) * 100
        : Math.ceil((basicPoints * 4) / 100) * 100;
    }

    return { score, basicPoints: fu };
  }

  /**
   * Calculate payments for multiple ron
   * BRANCHING POINTS:
   * - RIICHI_BET_DISTRIBUTION
   */
  calculateMultipleRonPayments(
    winners: Array<{
      wind: Wind;
      score: ScoreCalculation;
      pao?: PaoInfo;
    }>,
    discarder: Wind,
    honba: number,
    riichiSticks: number,
    allSeats: Wind[],
    nextDealer?: Wind
  ): WinPayment[] {
    const payments: WinPayment[] = [];

    // BRANCHING POINT: RIICHI_BET_DISTRIBUTION
    const riichiDistribution = this.distributeRiichiBets(
      winners.map(w => w.wind),
      discarder,
      riichiSticks,
      allSeats,
      nextDealer
    );

    for (let i = 0; i < winners.length; i++) {
      const winner = winners[i];
      const payment: WinPayment = {
        winner: winner.wind,
        winType: 'ron',
        fromPlayer: discarder,
        payments: {} as Record<Wind, number>,
        honba,
        riichiSticksWon: riichiDistribution[winner.wind] || 0,
        handEvaluation: winner.score.hand,
        scoreCalculation: winner.score
      };

      // Calculate base payment
      const baseScore = winner.score.nonDealerScore?.ron || winner.score.dealerScore?.ron || 0;
      const honbaBonus = honba * 300;

      // Check for pao
      if (winner.pao) {
        const paoPayment = this.calculatePaoPayment(
          baseScore + honbaBonus,
          winner.wind,
          winner.pao.responsiblePlayer,
          winner.pao.paymentStyle,
          [discarder]
        );
        payment.payments = paoPayment;
        payment.paoPlayer = winner.pao.responsiblePlayer;
        payment.paoPaymentStyle = winner.pao.paymentStyle;
      } else {
        // Normal payment - only discarder pays
        allSeats.forEach(seat => {
          payment.payments[seat] = seat === discarder
            ? -(baseScore + honbaBonus)
            : 0;
        });
        payment.payments[winner.wind] = baseScore + honbaBonus;
      }

      // Add riichi stick winnings
      payment.payments[winner.wind] += payment.riichiSticksWon * 1000;

      payments.push(payment);
    }

    // to_next_dealer で次期親が勝者にいない場合、供託は場に残して次局へ持ち越す
    if (
      this.rules.multipleRon.riichiBetDistribution === 'to_next_dealer' &&
      nextDealer !== undefined &&
      !winners.some(w => w.wind === nextDealer) &&
      payments.length > 0
    ) {
      payments[0].riichiSticksCarryOver = riichiSticks;
    }

    return payments;
  }

  /**
   * Calculate payments for tsumo
   * BRANCHING POINT: PAO_PAYMENT_CALCULATION
   */
  calculateTsumoPayment(
    winner: Wind,
    score: ScoreCalculation,
    isDealer: boolean,
    honba: number,
    riichiSticks: number,
    allSeats: Wind[],
    pao?: PaoInfo,
    dealerSeat: Wind = 'east'
  ): WinPayment {
    const payment: WinPayment = {
      winner,
      winType: 'tsumo',
      payments: {} as Record<Wind, number>,
      honba,
      riichiSticksWon: riichiSticks,
      handEvaluation: score.hand,
      scoreCalculation: score
    };

    const honbaPerPlayer = honba * 100;

    if (pao) {
      // BRANCHING POINT: PAO_PAYMENT_CALCULATION
      // For pao, use the full ron score (total amount) not per-player tsumo
      const baseScore = isDealer
        ? score.dealerScore!.ron
        : score.score;

      const paoPayment = this.calculatePaoPayment(
        baseScore,
        winner,
        pao.responsiblePlayer,
        pao.paymentStyle,
        allSeats.filter(seat => seat !== winner && seat !== pao.responsiblePlayer)
      );

      payment.payments = paoPayment;
      payment.paoPlayer = pao.responsiblePlayer;
      payment.paoPaymentStyle = pao.paymentStyle;

      // Add honba
      allSeats.forEach(seat => {
        if (seat !== winner) {
          payment.payments[seat] -= honbaPerPlayer;
        }
      });
      payment.payments[winner] += honbaPerPlayer * 3;
    } else {
      // Normal tsumo payment
      if (isDealer) {
        const paymentPerPlayer = score.dealerScore!.tsumo + honbaPerPlayer;
        allSeats.forEach(seat => {
          if (seat === winner) {
            payment.payments[seat] = paymentPerPlayer * 3;
          } else {
            payment.payments[seat] = -paymentPerPlayer;
          }
        });
      } else {
        const dealerPayment = score.nonDealerScore!.tsumoFromDealer + honbaPerPlayer;
        const nonDealerPayment = score.nonDealerScore!.tsumo + honbaPerPlayer;

        allSeats.forEach(seat => {
          if (seat === winner) {
            payment.payments[seat] = dealerPayment + nonDealerPayment * 2;
          } else if (seat === dealerSeat) {
            payment.payments[seat] = -dealerPayment;
          } else {
            payment.payments[seat] = -nonDealerPayment;
          }
        });
      }
    }

    // Add riichi stick winnings
    payment.payments[winner] += riichiSticks * 1000;

    return payment;
  }

  /**
   * G-3: 副露履歴からパオ (責任払い) の責任者を検出する。
   * 対象役満が config.applyTo に含まれ、かつ成立の決め手となった鳴き副露が
   * ある場合のみ PaoInfo を返す (全て暗槓・門前の場合は undefined)。
   */
  detectPao(melds: Meld[], yaku: Yaku[], winType: 'ron' | 'tsumo'): PaoInfo | undefined {
    if (!this.rules.pao.enabled) return undefined;
    const applyTo = this.rules.pao.applyTo;
    const hasYaku = (t: Yaku['type']) => yaku.some(y => y.type === t);

    const calledMelds = melds.filter(m =>
      m.calledFrom !== undefined &&
      (m.type === 'pon' || m.type === 'kan' || m.type === 'kakan')
    );
    const isDragonMeld = (m: Meld) => m.tiles.length > 0 && tileToIndex(m.tiles[0]) >= 31;
    const isWindMeld = (m: Meld) => {
      if (m.tiles.length === 0) return false;
      const idx = tileToIndex(m.tiles[0]);
      return idx >= 27 && idx <= 30;
    };

    const lastCalledFrom = (list: Meld[]): Wind | undefined => {
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].calledFrom !== undefined) return list[i].calledFrom;
      }
      return undefined;
    };

    // 大三元・大四喜・小四喜: 決め手 (最後に完成した該当副露) を鳴かせた者が責任者
    if (hasYaku('daisangen') && applyTo.includes('daisangen')) {
      const responsible = lastCalledFrom(calledMelds.filter(isDragonMeld));
      if (responsible !== undefined) {
        return { responsiblePlayer: responsible, yakumanType: 'daisangen', paymentStyle: this.resolvePaoPaymentStyle(winType) };
      }
    }
    if (hasYaku('daisuushi') && applyTo.includes('daisuushi')) {
      const responsible = lastCalledFrom(calledMelds.filter(isWindMeld));
      if (responsible !== undefined) {
        return { responsiblePlayer: responsible, yakumanType: 'daisuushi', paymentStyle: this.resolvePaoPaymentStyle(winType) };
      }
    }
    if (hasYaku('shousuushi') && applyTo.includes('shousuushi')) {
      const responsible = lastCalledFrom(calledMelds.filter(isWindMeld));
      if (responsible !== undefined) {
        return { responsiblePlayer: responsible, yakumanType: 'shousuushi', paymentStyle: this.resolvePaoPaymentStyle(winType) };
      }
    }

    // 字一色: 最後の鳴き副露を鳴かせた者が責任者
    if (hasYaku('tsuuiisou') && (applyTo.includes('tsuuiisou') || applyTo.includes('tsuuiisou_optional'))) {
      const responsible = lastCalledFrom(calledMelds);
      if (responsible !== undefined) {
        return { responsiblePlayer: responsible, yakumanType: 'tsuuiisou', paymentStyle: this.resolvePaoPaymentStyle(winType) };
      }
    }

    // 四槓子: 4つ目の槓を鳴かせた者が責任者 (4つ目が暗槓ならパオなし)
    if (hasYaku('suukantsu') && (applyTo.includes('suukantsu') || applyTo.includes('suukantsu_optional'))) {
      const kanMelds = melds.filter(m => m.type === 'kan' || m.type === 'ankan' || m.type === 'kakan');
      if (kanMelds.length >= 4 && kanMelds[3].calledFrom !== undefined) {
        return { responsiblePlayer: kanMelds[3].calledFrom, yakumanType: 'suukantsu', paymentStyle: this.resolvePaoPaymentStyle(winType) };
      }
    }

    return undefined;
  }

  /**
   * G-3: config.paymentStyle の解決。'configurable_full_or_split' は
   * 標準ルールに従いツモ=全額責任払い・ロン=放銃者との折半とする。
   */
  resolvePaoPaymentStyle(winType: 'ron' | 'tsumo'): 'full' | 'split' {
    const style = this.rules.pao.paymentStyle;
    if (style === 'full' || style === 'split') return style;
    return winType === 'tsumo' ? 'full' : 'split';
  }

  /**
   * BRANCHING POINT: RIICHI_BET_DISTRIBUTION
   * Distribute riichi bets among multiple winners
   */
  private distributeRiichiBets(
    winners: Wind[],
    discarder: Wind,
    riichiSticks: number,
    allSeats: Wind[],
    nextDealer?: Wind
  ): Record<Wind, number> {
    const distribution: Record<Wind, number> = {
      east: 0,
      south: 0,
      west: 0,
      north: 0
    };

    const distanceFromDiscarder = (w: Wind): number => {
      const discarderIndex = allSeats.indexOf(discarder);
      const winnerIndex = allSeats.indexOf(w);
      return (winnerIndex - discarderIndex + 4) % 4;
    };

    switch (this.rules.multipleRon.riichiBetDistribution) {
      case 'seat_order_nearest_to_discarder': {
        // Find closest winner to discarder in seat order
        let closestWinner: Wind | null = null;
        let minDistance = Infinity;

        winners.forEach(w => {
          const distance = distanceFromDiscarder(w);
          if (distance < minDistance) {
            minDistance = distance;
            closestWinner = w;
          }
        });

        if (closestWinner) {
          distribution[closestWinner as Wind] = riichiSticks;
        }
        break;
      }

      case 'split_equally': {
        const perWinner = Math.floor(riichiSticks / winners.length);
        winners.forEach(w => {
          distribution[w as Wind] = perWinner;
        });
        // G-7: 端数は捨牌者に座席順で最も近い勝者から順に1本ずつ寄せる
        const remainder = riichiSticks - perWinner * winners.length;
        const byDistance = [...winners].sort((a, b) => distanceFromDiscarder(a) - distanceFromDiscarder(b));
        for (let i = 0; i < remainder; i++) {
          distribution[byDistance[i % byDistance.length]] += 1;
        }
        break;
      }

      case 'to_next_dealer': {
        // 次期親が勝者にいる場合のみ配分する。いない場合は場に残して
        // 次局へ持ち越す (呼び出し元が riichiSticksCarryOver を設定する)。
        const recipient = nextDealer !== undefined && winners.includes(nextDealer)
          ? nextDealer
          : nextDealer === undefined
            ? winners[0]
            : null;
        if (recipient) {
          distribution[recipient as Wind] = riichiSticks;
        }
        break;
      }
    }

    return distribution;
  }

  /**
   * BRANCHING POINT: PAO_PAYMENT_CALCULATION
   * Calculate payment distribution when pao applies (always zero-sum:
   * the winner receives exactly what the payers contribute).
   */
  private calculatePaoPayment(
    totalScore: number,
    winner: Wind,
    paoPlayer: Wind,
    paymentStyle: 'full' | 'split',
    otherPayers: Wind[]
  ): Record<Wind, number> {
    const payments: Record<Wind, number> = {
      east: 0,
      south: 0,
      west: 0,
      north: 0
    };

    if (paymentStyle === 'full' || otherPayers.length === 0) {
      // Pao player pays everything
      payments[paoPlayer] = -totalScore;
      payments[winner] = totalScore;
    } else if (otherPayers.length === 1) {
      // Ron split: pao player and discarder each pay half (rounded up to 100)
      const half = Math.ceil(totalScore / 2 / 100) * 100;
      payments[paoPlayer] -= half;
      payments[otherPayers[0]] -= half;
      payments[winner] = half * 2;
    } else {
      // Tsumo split: pao player pays half (rounded up to 100), the other two
      // players split the rest. The winner receives exactly what was collected.
      const half = Math.ceil(totalScore / 2 / 100) * 100;
      payments[paoPlayer] = -half;
      const rest = totalScore - half;
      const perOther = Math.ceil(rest / otherPayers.length / 100) * 100;
      for (const seat of otherPayers) {
        payments[seat] -= perOther;
      }
      payments[winner] = half + perOther * otherPayers.length;
    }

    return payments;
  }

  /**
   * Calculate nagashi mangan payments
   * Treated as tsumo mangan
   */
  calculateNagashiManganPayment(
    player: Wind,
    isDealer: boolean,
    honba: number,
    allSeats: Wind[],
    dealerSeat: Wind = 'east'
  ): WinPayment {
    const payment: WinPayment = {
      winner: player,
      winType: 'tsumo',
      payments: {} as Record<Wind, number>,
      honba,
      riichiSticksWon: 0
    };

    const honbaPerPlayer = honba * 100;

    if (isDealer) {
      const paymentPerPlayer = 4000 + honbaPerPlayer;
      allSeats.forEach(seat => {
        if (seat === player) {
          payment.payments[seat] = paymentPerPlayer * 3;
        } else {
          payment.payments[seat] = -paymentPerPlayer;
        }
      });
    } else {
      const dealerPayment = 4000 + honbaPerPlayer;
      const nonDealerPayment = 2000 + honbaPerPlayer;

      allSeats.forEach(seat => {
        if (seat === player) {
          payment.payments[seat] = dealerPayment + nonDealerPayment * 2;
        } else if (seat === dealerSeat) {
          payment.payments[seat] = -dealerPayment;
        } else {
          payment.payments[seat] = -nonDealerPayment;
        }
      });
    }

    return payment;
  }
}
