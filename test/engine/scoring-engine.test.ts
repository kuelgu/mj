import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScoringEngine } from '../../src/engine/scoring-engine.js';
import { RuleConfig } from '../../src/config/rule-config.js';
import { HandEvaluation, PaoInfo } from '../../src/types/scoring.js';
import { Wind } from '../../src/types/game-state.js';

/**
 * Test suite for scoring engine
 * Tests all branching points:
 * - KIRIAGE_MANGAN_CHECK
 * - KAZOE_YAKUMAN_CHECK
 * - RIICHI_BET_DISTRIBUTION
 * - PAO_PAYMENT_CALCULATION
 */

const defaultRules: RuleConfig = {
  variant: 'riichi-4p',
  multipleRon: {
    mode: 'allow_up_to_3',
    atamahane: false,
    riichiBetDistribution: 'seat_order_nearest_to_discarder'
  },
  scoring: {
    kiriageMangan: true,
    kazoeYakuman: 'yakuman'
  },
  pao: {
    enabled: true,
    paymentStyle: 'configurable_full_or_split',
    applyTo: ['daisangen', 'daisuushi', 'tsuuiisou_optional', 'suukantsu_optional']
  },
  nagashiMangan: {
    enabled: true,
    treatAsWin: true
  }
};

const allSeats: Wind[] = ['east', 'south', 'west', 'north'];

describe('ScoringEngine - Kiriage Mangan Check', () => {
  it('should round up 4 han 30 fu to mangan when kiriageMangan is true', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 4,
      fu: 30,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    assert.equal(score.isKiriageMangan, true, 'Should be kiriage mangan');
    assert.equal(score.limitName, 'mangan', 'Should be mangan');
    assert.equal(score.score, 8000, 'Non-dealer mangan ron is 8000');
  });

  it('should round up 3 han 60 fu to mangan when kiriageMangan is true', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 3,
      fu: 60,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    assert.equal(score.isKiriageMangan, true, 'Should be kiriage mangan');
    assert.equal(score.limitName, 'mangan', 'Should be mangan');
    assert.equal(score.score, 8000, 'Non-dealer mangan ron is 8000');
  });

  it('should NOT round up when kiriageMangan is false', () => {
    const rulesWithoutKiriage: RuleConfig = {
      ...defaultRules,
      scoring: { ...defaultRules.scoring, kiriageMangan: false }
    };
    const engine = new ScoringEngine(rulesWithoutKiriage);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 4,
      fu: 30,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    assert.equal(score.isKiriageMangan, false, 'Should not be kiriage mangan');
    //assert.equal(score.score, 7680, 'Should calculate normal score');
    assert.equal(score.score, 7700, 'Should calculate normal score');
  });

  it('should round up for dealer 4 han 30 fu to dealer mangan', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 4,
      fu: 30,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, true, false);

    assert.equal(score.isKiriageMangan, true, 'Should be kiriage mangan');
    assert.equal(score.score, 12000, 'Dealer mangan ron is 12000');
  });
});

describe('ScoringEngine - Kazoe Yakuman Check', () => {
  it('should treat 13 han as yakuman when kazoeYakuman is "yakuman"', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 10,
      fu: 40,
      yakuman: 0,
      dora: 3,  // Total: 13 han
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    assert.equal(score.isKazoeYakuman, true, 'Should be kazoe yakuman');
    assert.equal(score.limitName, 'yakuman', 'Should be yakuman');
    assert.equal(score.score, 32000, 'Non-dealer yakuman ron is 32000');
  });

  it('should treat 14 han as yakuman when kazoeYakuman is "yakuman"', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 11,
      fu: 40,
      yakuman: 0,
      dora: 3,  // Total: 14 han
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    assert.equal(score.isKazoeYakuman, true, 'Should be kazoe yakuman');
    assert.equal(score.score, 32000, 'Non-dealer yakuman ron is 32000');
  });

  it('should treat 13 han as sanbaiman when kazoeYakuman is "limit"', () => {
    const rulesWithLimit: RuleConfig = {
      ...defaultRules,
      scoring: { ...defaultRules.scoring, kazoeYakuman: 'limit' }
    };
    const engine = new ScoringEngine(rulesWithLimit);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 13,
      fu: 40,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    assert.equal(score.isKazoeYakuman, false, 'Should not be kazoe yakuman');
    assert.equal(score.limitName, 'sanbaiman', 'Should be sanbaiman');
    assert.equal(score.score, 24000, 'Non-dealer sanbaiman is 24000');
  });

  it('should treat dealer 13 han as dealer yakuman', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 13,
      fu: 40,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, true, false);

    assert.equal(score.isKazoeYakuman, true, 'Should be kazoe yakuman');
    assert.equal(score.score, 48000, 'Dealer yakuman ron is 48000');
  });
});

describe('ScoringEngine - Multiple Ron Payment', () => {
  it('should handle double ron (2 winners) correctly', () => {
    const engine = new ScoringEngine(defaultRules);

    // Create two winning hands
    const hand1: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 3,
      fu: 40,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const hand2: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 2,
      fu: 40,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score1 = engine.calculateScore(hand1, false, false);
    const score2 = engine.calculateScore(hand2, false, false);

    const winners = [
      { wind: 'south' as Wind, score: score1 },
      { wind: 'north' as Wind, score: score2 }
    ];

    const payments = engine.calculateMultipleRonPayments(
      winners,
      'west',  // discarder
      0,       // honba
      2,       // riichi sticks
      allSeats
    );

    assert.equal(payments.length, 2, 'Should have 2 payments');
    assert.equal(payments[0].winner, 'south');
    assert.equal(payments[1].winner, 'north');

    // Each winner should get paid by discarder
    assert.ok(payments[0].payments['west'] < 0, 'Discarder should pay first winner');
    assert.ok(payments[1].payments['west'] < 0, 'Discarder should pay second winner');
  });

  it('should handle triple ron (3 winners) correctly', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 2,
      fu: 40,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    const winners = [
      { wind: 'east' as Wind, score },
      { wind: 'south' as Wind, score },
      { wind: 'north' as Wind, score }
    ];

    const payments = engine.calculateMultipleRonPayments(
      winners,
      'west',  // discarder
      0,       // honba
      0,       // riichi sticks
      allSeats
    );

    assert.equal(payments.length, 3, 'Should have 3 payments');

    // Verify all three winners get paid
    payments.forEach(payment => {
      assert.ok(payment.payments['west'] < 0, 'Discarder should pay each winner');
      assert.ok(payment.payments[payment.winner] > 0, 'Winner should receive payment');
    });
  });

  it('should distribute riichi bets to nearest winner in seat order', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 2,
      fu: 40,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    const winners = [
      { wind: 'north' as Wind, score },  // 1 seat away from west (west -> north)
      { wind: 'east' as Wind, score }    // 2 seats away from west (west -> north -> east)
    ];

    const payments = engine.calculateMultipleRonPayments(
      winners,
      'west',  // discarder
      0,       // honba
      3,       // riichi sticks
      allSeats
    );

    // Turn order from west: west -> north -> east -> south
    // North is 1 seat away, East is 2 seats away
    // So north should get all riichi sticks
    const northPayment = payments.find(p => p.winner === 'north');
    const eastPayment = payments.find(p => p.winner === 'east');

    assert.equal(northPayment!.riichiSticksWon, 3, 'North (nearest) should get riichi sticks');
    assert.equal(eastPayment!.riichiSticksWon, 0, 'East should get no riichi sticks');
  });

  it('should split riichi bets equally when configured', () => {
    const rulesWithSplit: RuleConfig = {
      ...defaultRules,
      multipleRon: {
        ...defaultRules.multipleRon,
        riichiBetDistribution: 'split_equally'
      }
    };
    const engine = new ScoringEngine(rulesWithSplit);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 2,
      fu: 40,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    const winners = [
      { wind: 'south' as Wind, score },
      { wind: 'east' as Wind, score }
    ];

    const payments = engine.calculateMultipleRonPayments(
      winners,
      'west',
      0,
      4,  // 4 riichi sticks
      allSeats
    );

    // Each winner should get 2 sticks
    payments.forEach(payment => {
      assert.equal(payment.riichiSticksWon, 2, 'Each winner should get equal riichi sticks');
    });
  });
});

describe('ScoringEngine - Pao Payment', () => {
  it('should calculate full pao payment when paymentStyle is "full"', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 0,
      fu: 40,
      yakuman: 1,  // Yakuman
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    const paoInfo: PaoInfo = {
      responsiblePlayer: 'north',
      yakumanType: 'daisangen',
      paymentStyle: 'full'
    };

    const payment = engine.calculateTsumoPayment(
      'south',  // winner
      score,
      false,    // not dealer
      0,        // honba
      0,        // riichi sticks
      allSeats,
      paoInfo
    );

    assert.equal(payment.paoPlayer, 'north', 'Pao player should be recorded');
    assert.equal(payment.paoPaymentStyle, 'full', 'Payment style should be full');

    // Pao player should pay full yakuman amount
    // For non-dealer tsumo yakuman, it's 32000 total
    assert.ok(payment.payments['north'] < 0, 'Pao player should pay');
    assert.equal(payment.payments['south'], 32000, 'Winner should receive full yakuman');
  });

  it('should calculate split pao payment when paymentStyle is "split"', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 0,
      fu: 40,
      yakuman: 1,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    const paoInfo: PaoInfo = {
      responsiblePlayer: 'north',
      yakumanType: 'daisangen',
      paymentStyle: 'split'
    };

    const payment = engine.calculateTsumoPayment(
      'south',
      score,
      false,
      0,
      0,
      allSeats,
      paoInfo
    );

    assert.equal(payment.paoPaymentStyle, 'split', 'Payment style should be split');

    // Pao player should pay half
    const paoPayment = Math.abs(payment.payments['north']);
    assert.equal(paoPayment, 16000, 'Pao player should pay half of yakuman');
  });

  it('should handle pao for dealer yakuman', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 0,
      fu: 40,
      yakuman: 1,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, true, false);

    const paoInfo: PaoInfo = {
      responsiblePlayer: 'south',
      yakumanType: 'daisuushi',
      paymentStyle: 'full'
    };

    const payment = engine.calculateTsumoPayment(
      'east',   // dealer winner
      score,
      true,     // is dealer
      0,
      0,
      allSeats,
      paoInfo
    );

    // Dealer yakuman tsumo is 48000
    assert.equal(payment.payments['east'], 48000, 'Dealer should receive full yakuman');
  });
});

describe('ScoringEngine - Nagashi Mangan', () => {
  it('should calculate nagashi mangan as non-dealer tsumo mangan', () => {
    const engine = new ScoringEngine(defaultRules);

    const payment = engine.calculateNagashiManganPayment(
      'south',  // player
      false,    // not dealer
      0,        // honba
      allSeats
    );

    assert.equal(payment.winner, 'south');
    assert.equal(payment.winType, 'tsumo');

    // Non-dealer mangan tsumo: 2000/4000
    // Dealer pays 4000, others pay 2000
    assert.equal(payment.payments['east'], -4000, 'Dealer should pay 4000');
    assert.equal(payment.payments['west'], -2000, 'Non-dealer should pay 2000');
    assert.equal(payment.payments['north'], -2000, 'Non-dealer should pay 2000');
    assert.equal(payment.payments['south'], 8000, 'Winner should receive 8000');
  });

  it('should calculate nagashi mangan as dealer tsumo mangan', () => {
    const engine = new ScoringEngine(defaultRules);

    const payment = engine.calculateNagashiManganPayment(
      'east',   // dealer
      true,     // is dealer
      0,
      allSeats
    );

    // Dealer mangan tsumo: 4000 all
    assert.equal(payment.payments['south'], -4000, 'Each player pays 4000');
    assert.equal(payment.payments['west'], -4000, 'Each player pays 4000');
    assert.equal(payment.payments['north'], -4000, 'Each player pays 4000');
    assert.equal(payment.payments['east'], 12000, 'Dealer receives 12000');
  });

  it('should add honba to nagashi mangan payment', () => {
    const engine = new ScoringEngine(defaultRules);

    const payment = engine.calculateNagashiManganPayment(
      'south',
      false,
      2,  // 2 honba
      allSeats
    );

    // With 2 honba, each player pays 100 * 2 = 200 extra
    // Total extra: 600
    assert.equal(payment.payments['south'], 8600, 'Winner should receive base + honba');
  });
});

describe('ScoringEngine - Edge Cases', () => {
  it('should handle double yakuman correctly', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 0,
      fu: 40,
      yakuman: 2,  // Double yakuman
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    assert.equal(score.limitName, 'double_yakuman');
    assert.equal(score.score, 64000, 'Non-dealer double yakuman is 64000');
  });

  it('should handle honba correctly in payments', () => {
    const engine = new ScoringEngine(defaultRules);

    const hand: HandEvaluation = {
      isWinningHand: true,
      patterns: [],
      yaku: [],
      han: 2,
      fu: 40,
      yakuman: 0,
      dora: 0,
      uraDora: 0,
      akaDora: 0
    };

    const score = engine.calculateScore(hand, false, false);

    const winners = [
      { wind: 'south' as Wind, score }
    ];

    const payments = engine.calculateMultipleRonPayments(
      winners,
      'west',
      3,  // 3 honba
      0,
      allSeats
    );

    // 3 honba = 900 points extra (300 * 3)
    const payment = payments[0];
    const baseScore = score.nonDealerScore!.ron;
    const expectedTotal = baseScore + 900;

    assert.equal(payment.payments['south'], expectedTotal, 'Should include honba bonus');
  });
});
