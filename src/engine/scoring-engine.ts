import { RuleConfig } from '../config/rule-config.js';
import { ScoreCalculation, HandEvaluation, WinPayment, PaoInfo } from '../types/scoring.js';
import { Wind } from '../types/game-state.js';

/**
 * Pure scoring engine - no side effects, only calculations
 */
export class ScoringEngine {
  constructor(private rules: RuleConfig) {}

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
    allSeats: Wind[]
  ): WinPayment[] {
    const payments: WinPayment[] = [];

    // BRANCHING POINT: RIICHI_BET_DISTRIBUTION
    const riichiDistribution = this.distributeRiichiBets(
      winners.map(w => w.wind),
      discarder,
      riichiSticks,
      allSeats
    );

    for (let i = 0; i < winners.length; i++) {
      const winner = winners[i];
      const payment: WinPayment = {
        winner: winner.wind,
        winType: 'ron',
        fromPlayer: discarder,
        payments: {} as Record<Wind, number>,
        honba,
        riichiSticksWon: riichiDistribution[winner.wind] || 0
      };

      // Calculate base payment
      const baseScore = winner.score.nonDealerScore?.ron || winner.score.dealerScore?.ron || 0;
      const honbaBonus = honba * 300;

      // Check for pao
      if (winner.pao) {
        const paoPayment = this.calculatePaoPayment(
          baseScore + honbaBonus,
          discarder,
          winner.pao.responsiblePlayer,
          winner.pao.paymentStyle
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
    pao?: PaoInfo
  ): WinPayment {
    const payment: WinPayment = {
      winner,
      winType: 'tsumo',
      payments: {} as Record<Wind, number>,
      honba,
      riichiSticksWon: riichiSticks
    };

    const honbaPerPlayer = honba * 100;

    if (pao) {
      // BRANCHING POINT: PAO_PAYMENT_CALCULATION
      const baseScore = isDealer
        ? score.dealerScore!.tsumo
        : score.nonDealerScore!.ron;

      const paoPayment = this.calculatePaoPayment(
        baseScore,
        winner,
        pao.responsiblePlayer,
        pao.paymentStyle
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
        const dealerSeat = allSeats.find(s => this.isDealer(s, allSeats))!;

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
   * BRANCHING POINT: RIICHI_BET_DISTRIBUTION
   * Distribute riichi bets among multiple winners
   */
  private distributeRiichiBets(
    winners: Wind[],
    discarder: Wind,
    riichiSticks: number,
    allSeats: Wind[]
  ): Record<Wind, number> {
    const distribution: Record<Wind, number> = {
      east: 0,
      south: 0,
      west: 0,
      north: 0
    };

    switch (this.rules.multipleRon.riichiBetDistribution) {
      case 'seat_order_nearest_to_discarder':
        // Find closest winner to discarder in seat order
        const discarderIndex = allSeats.indexOf(discarder);
        let closestWinner: Wind | null = null;
        let minDistance = Infinity;

        winners.forEach(w => {
          const winnerIndex = allSeats.indexOf(w);
          const distance = (winnerIndex - discarderIndex + 4) % 4;
          if (distance < minDistance) {
            minDistance = distance;
            closestWinner = w;
          }
        });

        if (closestWinner) {
          distribution[closestWinner as Wind] = riichiSticks;
        }
        break;

      case 'split_equally':
        const perWinner = Math.floor(riichiSticks / winners.length);
        winners.forEach(w => {
          distribution[w as Wind] = perWinner;
        });
        break;

      case 'to_next_dealer':
        // In this implementation, we don't track next dealer here
        // This would need game state to determine
        // For now, give to first winner
        distribution[winners[0] as Wind] = riichiSticks;
        break;
    }

    return distribution;
  }

  /**
   * BRANCHING POINT: PAO_PAYMENT_CALCULATION
   * Calculate payment distribution when pao applies
   */
  private calculatePaoPayment(
    totalScore: number,
    winner: Wind,
    paoPlayer: Wind,
    paymentStyle: 'full' | 'split'
  ): Record<Wind, number> {
    const payments: Record<Wind, number> = {
      east: 0,
      south: 0,
      west: 0,
      north: 0
    };

    if (paymentStyle === 'full') {
      // Pao player pays everything
      payments[paoPlayer] = -totalScore;
      payments[winner] = totalScore;
    } else {
      // Split payment
      const halfScore = Math.ceil(totalScore / 2);
      payments[paoPlayer] = -halfScore;
      // Other half comes from discarder or split among non-winners
      // This depends on whether it's ron or tsumo
      // Simplified: pao player pays half, winner gets full
      payments[winner] = totalScore;
      // The other half is distributed among other players
      // (implementation detail - would need full game state)
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
    allSeats: Wind[]
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
      const dealerSeat = allSeats.find(s => this.isDealer(s, allSeats))!;

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

  /**
   * Helper: Check if seat is dealer
   */
  private isDealer(seat: Wind, _allSeats: Wind[]): boolean {
    // In 4-player, east is always dealer
    return seat === 'east';
  }
}
