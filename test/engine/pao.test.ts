import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScoringEngine } from '../../src/engine/scoring-engine.js';
import { GameRoom } from '../../src/server/game-room.js';
import { getDefaultRuleConfigPath, RuleConfig } from '../../src/config/rule-config.js';
import { parseTile, TileInstance } from '../../src/types/tiles.js';
import { Wind, Meld } from '../../src/types/game-state.js';
import { HandEvaluation, Yaku } from '../../src/types/scoring.js';

function tiles(spec: string): TileInstance[] {
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s, i) => ({
      id: `pao-${i}-${s}`,
      ...parseTile(s)
    }));
}

function meld(type: Meld['type'], spec: string, calledFrom?: Wind): Meld {
  return { type, tiles: tiles(spec), calledFrom };
}

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

const daisangenYaku: Yaku[] = [{ type: 'daisangen', han: 13, isYakuman: true }];

describe('G-3 Pao detection (責任払い)', () => {
  it('should detect the last called dragon meld as responsible for daisangen', () => {
    const engine = new ScoringEngine(defaultRules);
    const melds = [
      meld('pon', 'white white white', 'south'),
      meld('pon', 'green green green', 'west'),
      meld('pon', 'red red red', 'north')
    ];
    const pao = engine.detectPao(melds, daisangenYaku, 'tsumo');
    assert.ok(pao);
    assert.equal(pao.responsiblePlayer, 'north');
    assert.equal(pao.yakumanType, 'daisangen');
    assert.equal(pao.paymentStyle, 'full');
  });

  it('should resolve configurable style to split for ron', () => {
    const engine = new ScoringEngine(defaultRules);
    const melds = [
      meld('pon', 'white white white', 'south'),
      meld('pon', 'green green green', 'west'),
      meld('pon', 'red red red', 'north')
    ];
    const pao = engine.detectPao(melds, daisangenYaku, 'ron');
    assert.ok(pao);
    assert.equal(pao.paymentStyle, 'split');
  });

  it('should return undefined when all dragon sets are concealed', () => {
    const engine = new ScoringEngine(defaultRules);
    const melds = [
      meld('ankan', 'white white white white'),
      meld('ankan', 'green green green green')
    ];
    const pao = engine.detectPao(melds, daisangenYaku, 'tsumo');
    assert.equal(pao, undefined);
  });

  it('should return undefined when pao is disabled or yakuman not in applyTo', () => {
    const disabled = new ScoringEngine({
      ...defaultRules,
      pao: { ...defaultRules.pao, enabled: false }
    });
    const melds = [meld('pon', 'white white white', 'south')];
    assert.equal(disabled.detectPao(melds, daisangenYaku, 'tsumo'), undefined);

    const noDaisangen = new ScoringEngine({
      ...defaultRules,
      pao: { ...defaultRules.pao, applyTo: ['daisuushi'] }
    });
    assert.equal(noDaisangen.detectPao(melds, daisangenYaku, 'tsumo'), undefined);
  });

  it('should detect daisuushi and tsuuiisou responsibility', () => {
    const engine = new ScoringEngine(defaultRules);
    const winds = [
      meld('pon', 'east east east', 'south'),
      meld('pon', 'south south south', 'west'),
      meld('pon', 'west west west', 'north'),
      meld('pon', 'north north north', 'south')
    ];
    const daisuushi: Yaku[] = [{ type: 'daisuushi', han: 13, isYakuman: true }];
    const paoWind = engine.detectPao(winds, daisuushi, 'tsumo');
    assert.ok(paoWind);
    assert.equal(paoWind.responsiblePlayer, 'south');

    const tsuuiisou: Yaku[] = [{ type: 'tsuuiisou', han: 13, isYakuman: true }];
    const paoHonor = engine.detectPao(winds, tsuuiisou, 'tsumo');
    assert.ok(paoHonor);
    assert.equal(paoHonor.responsiblePlayer, 'south');
  });

  it('should detect suukantsu responsibility on the fourth (called) kan', () => {
    const engine = new ScoringEngine(defaultRules);
    const suukantsu: Yaku[] = [{ type: 'suukantsu', han: 13, isYakuman: true }];
    const melds = [
      meld('ankan', '1m 1m 1m 1m'),
      meld('ankan', '2m 2m 2m 2m'),
      meld('ankan', '3m 3m 3m 3m'),
      meld('kan', '4m 4m 4m 4m', 'west')
    ];
    const pao = engine.detectPao(melds, suukantsu, 'tsumo');
    assert.ok(pao);
    assert.equal(pao.responsiblePlayer, 'west');

    // Fourth kan concealed -> no pao
    const concealed = [
      meld('ankan', '1m 1m 1m 1m'),
      meld('ankan', '2m 2m 2m 2m'),
      meld('ankan', '3m 3m 3m 3m'),
      meld('ankan', '4m 4m 4m 4m')
    ];
    assert.equal(engine.detectPao(concealed, suukantsu, 'tsumo'), undefined);
  });

  it('should keep explicit full/split styles as-is', () => {
    const full = new ScoringEngine({
      ...defaultRules,
      pao: { ...defaultRules.pao, paymentStyle: 'full' }
    });
    assert.equal(full.resolvePaoPaymentStyle('ron'), 'full');
    assert.equal(full.resolvePaoPaymentStyle('tsumo'), 'full');

    const split = new ScoringEngine({
      ...defaultRules,
      pao: { ...defaultRules.pao, paymentStyle: 'split' }
    });
    assert.equal(split.resolvePaoPaymentStyle('ron'), 'split');
    assert.equal(split.resolvePaoPaymentStyle('tsumo'), 'split');
  });
});

describe('G-3 Pao payments are zero-sum', () => {
  function yakumanScore(engine: ScoringEngine, isDealer: boolean) {
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
    return engine.calculateScore(hand, isDealer, false);
  }

  it('should split ron pao between discarder and responsible player', () => {
    const engine = new ScoringEngine(defaultRules);
    const score = yakumanScore(engine, false);
    const payments = engine.calculateMultipleRonPayments(
      [{
        wind: 'south',
        score,
        pao: { responsiblePlayer: 'north', yakumanType: 'daisangen', paymentStyle: 'split' }
      }],
      'east',
      1, // honba: total 32300
      0,
      allSeats
    );
    const p = payments[0];
    assert.equal(p.paoPlayer, 'north');
    // 32300 split in halves rounded up: 16200 each, winner gets 32400
    assert.equal(p.payments['north'], -16200);
    assert.equal(p.payments['east'], -16200);
    assert.equal(p.payments['south'], 32400);
    const sum = allSeats.reduce((s, seat) => s + p.payments[seat], 0);
    assert.equal(sum, 0);
  });

  it('should collect the missing half of split tsumo pao from others', () => {
    const engine = new ScoringEngine(defaultRules);
    const score = yakumanScore(engine, false);
    const payment = engine.calculateTsumoPayment(
      'south',
      score,
      false,
      0,
      0,
      allSeats,
      { responsiblePlayer: 'north', yakumanType: 'daisangen', paymentStyle: 'split' }
    );
    assert.equal(payment.payments['north'], -16000);
    assert.equal(payment.payments['east'], -8000);
    assert.equal(payment.payments['west'], -8000);
    assert.equal(payment.payments['south'], 32000);
    const sum = allSeats.reduce((s, seat) => s + payment.payments[seat], 0);
    assert.equal(sum, 0);
  });
});

describe('G-3 Pao end-to-end via GameRoom tsumo', () => {
  it('should apply pao when tsumoing daisangen with called dragon melds', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();

    // East (dealer): pon white from south, pon green from west, red triplet + 234m + 55p concealed
    state.players[0].melds = [
      meld('pon', 'white white white', 'south'),
      meld('pon', 'green green green', 'west')
    ];
    state.players[0].hand = tiles('red red red 2m 3m 4m 5p 5p');
    state.doraIndicators = tiles('white');

    const res = room.processEvent({
      type: 'TSUMO_DECLARE',
      player: 'east',
      tile: state.players[0].hand[state.players[0].hand.length - 1]
    });
    assert.equal(state.phase, 'tsumo_declared');
    const paymentMsg = res.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    const payment = paymentMsg.payments[0];
    assert.equal(payment.paoPlayer, 'west');
    assert.equal(payment.paoPaymentStyle, 'full');
    // Dealer yakuman tsumo: responsible player pays all 48000
    assert.equal(payment.payments['west'], -48000);
    assert.equal(payment.payments['east'], 48000);
  });
});
