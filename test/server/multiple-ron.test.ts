import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameRoom } from '../../src/server/game-room.js';
import { getDefaultRuleConfigPath, loadRuleConfig } from '../../src/config/rule-config.js';
import { ScoringEngine } from '../../src/engine/scoring-engine.js';
import { parseTile, TileInstance } from '../../src/types/tiles.js';
import { Wind } from '../../src/types/game-state.js';

function tiles(spec: string): TileInstance[] {
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s, i) => ({
      id: `mr-${i}-${s}-${Math.random().toString(36).slice(2, 7)}`,
      ...parseTile(s)
    }));
}

/** Pinfu tenpai waiting on 6m (ron-able, no riichi needed) */
const PINFU_WAIT_6M = '1m 2m 3m 4p 5p 6p 7s 8s 9s 2p 2p 4m 5m';
const JUNK_13 = '1m 4m 7m 1p 4p 7p 1s 4s 7s east south west north';

function writeRules(overrides: Record<string, unknown>): string {
  const base = {
    variant: 'riichi-4p',
    multipleRon: {
      mode: 'allow_up_to_3',
      atamahane: false,
      riichiBetDistribution: 'seat_order_nearest_to_discarder'
    },
    scoring: { kiriageMangan: true, kazoeYakuman: 'yakuman' },
    pao: {
      enabled: true,
      paymentStyle: 'configurable_full_or_split',
      applyTo: ['daisangen', 'daisuushi', 'tsuuiisou_optional', 'suukantsu_optional']
    },
    nagashiMangan: { enabled: true, treatAsWin: true }
  };
  const merged = {
    ...base,
    ...overrides,
    multipleRon: { ...base.multipleRon, ...(overrides.multipleRon as object ?? {}) }
  };
  const path = join(tmpdir(), `mj-test-rules-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(merged));
  return path;
}

describe('G-4 Multiple ron collection', () => {
  it('should auto-collect NPC declarers into a double ron', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.doraIndicators = tiles('white');

    // South and West both wait on 6m; East discards it
    state.players[1].hand = tiles(PINFU_WAIT_6M);
    state.players[2].hand = tiles(PINFU_WAIT_6M);
    state.players[3].hand = tiles(JUNK_13);
    const winTile = tiles('6m')[0];
    state.players[0].hand[0] = winTile;
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile });

    const res = room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: winTile });
    assert.equal(state.phase, 'scoring');
    const paymentMsg = res.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    assert.equal(paymentMsg.payments.length, 2);
    const winners = paymentMsg.payments.map((p: any) => p.winner).sort();
    assert.deepEqual(winners, ['south', 'west']);
    for (const p of paymentMsg.payments) {
      assert.equal(p.fromPlayer, 'east');
      assert.ok(p.payments['east'] < 0);
    }
  });

  it('should wait for a human declarer, then settle when they declare', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.assignPlayer('h1'); // east (discarder)
    room.assignPlayer('h2'); // south (first declarer)
    room.assignPlayer('h3'); // west (waiting declarer)
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.doraIndicators = tiles('white');

    state.players[1].hand = tiles(PINFU_WAIT_6M);
    state.players[2].hand = tiles(PINFU_WAIT_6M);
    state.players[3].hand = tiles(JUNK_13);
    const winTile = tiles('6m')[0];
    state.players[0].hand[0] = winTile;
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile });

    const first = room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: winTile });
    // West (human) can still ron -> collection stays open, no payment yet
    assert.equal(state.phase, 'ron_declared');
    assert.equal(state.pendingRon?.declarers.length, 1);
    assert.ok(!first.messages.some(m => m.type === 'payment'));

    const second = room.processEvent({ type: 'RON_DECLARE', player: 'west', tile: winTile });
    assert.equal(state.phase, 'scoring');
    const paymentMsg = second.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    assert.equal(paymentMsg.payments.length, 2);
  });

  it('should settle with one winner after the other human passes', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.assignPlayer('h1'); // east
    room.assignPlayer('h2'); // south
    room.assignPlayer('h3'); // west
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.doraIndicators = tiles('white');

    state.players[1].hand = tiles(PINFU_WAIT_6M);
    state.players[2].hand = tiles(PINFU_WAIT_6M);
    state.players[3].hand = tiles(JUNK_13);
    const winTile = tiles('6m')[0];
    state.players[0].hand[0] = winTile;
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile });
    room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: winTile });
    assert.equal(state.phase, 'ron_declared');

    room.markPlayerPassedCall('h3');
    const followUp = room.resolvePendingDeclarations();
    assert.equal(state.phase, 'scoring');
    const paymentMsg = followUp.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    assert.equal(paymentMsg.payments.length, 1);
    assert.equal(paymentMsg.payments[0].winner, 'south');
  });

  it('should apply head bump (only nearest declarer wins)', () => {
    const rulesPath = writeRules({ multipleRon: { mode: 'head_bump', atamahane: true } });
    const room = new GameRoom(rulesPath);
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.doraIndicators = tiles('white');

    state.players[1].hand = tiles(PINFU_WAIT_6M);
    state.players[2].hand = tiles(PINFU_WAIT_6M);
    state.players[3].hand = tiles(JUNK_13);
    const winTile = tiles('6m')[0];
    state.players[0].hand[0] = winTile;
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile });

    const res = room.processEvent({ type: 'RON_DECLARE', player: 'west', tile: winTile });
    assert.equal(state.phase, 'scoring');
    const paymentMsg = res.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    assert.equal(paymentMsg.payments.length, 1);
    // South is nearer to East than West in seat order
    assert.equal(paymentMsg.payments[0].winner, 'south');
  });

  it('should abort as triple ron when mode disallows it', () => {
    const rulesPath = writeRules({ multipleRon: { mode: 'allow_double' } });
    const room = new GameRoom(rulesPath);
    room.assignPlayer('h1'); // east (discarder)
    room.assignPlayer('h2'); // south
    room.assignPlayer('h3'); // west
    room.assignPlayer('h4'); // north
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.doraIndicators = tiles('white');

    state.players[1].hand = tiles(PINFU_WAIT_6M);
    state.players[2].hand = tiles(PINFU_WAIT_6M);
    state.players[3].hand = tiles(PINFU_WAIT_6M);
    const winTile = tiles('6m')[0];
    state.players[0].hand[0] = winTile;
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile });

    room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: winTile });
    assert.equal(state.phase, 'ron_declared');
    room.processEvent({ type: 'RON_DECLARE', player: 'west', tile: winTile });
    assert.equal(state.phase, 'ron_declared');
    const third = room.processEvent({ type: 'RON_DECLARE', player: 'north', tile: winTile });

    assert.equal(state.phase, 'draw');
    assert.equal(state.drawType, 'triple_ron');
    assert.ok(!third.messages.some(m => m.type === 'payment'));

    room.processEvent({ type: 'ROUND_END' });
    room.processEvent({ type: 'ROUND_END' });
    assert.equal(state.honba, 1);
    assert.equal(state.players[0].isDealer, true);
  });

  it('should pay triple ron when mode allows up to 3', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.doraIndicators = tiles('white');

    state.players[1].hand = tiles(PINFU_WAIT_6M);
    state.players[2].hand = tiles(PINFU_WAIT_6M);
    state.players[3].hand = tiles(PINFU_WAIT_6M);
    const winTile = tiles('6m')[0];
    state.players[0].hand[0] = winTile;
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile });

    const res = room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: winTile });
    assert.equal(state.phase, 'scoring');
    const paymentMsg = res.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    assert.equal(paymentMsg.payments.length, 3);
  });
});

describe('G-7 Riichi bet distribution', () => {
  it('should give split_equally remainder to the nearest winner', () => {
    const rulesPath = writeRules({ multipleRon: { riichiBetDistribution: 'split_equally' } });
    const engine = new ScoringEngine(loadRuleConfig(rulesPath));
    const allSeats: Wind[] = ['east', 'south', 'west', 'north'];

    const hand = {
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
    const payments = engine.calculateMultipleRonPayments(
      [
        { wind: 'east' as Wind, score },
        { wind: 'south' as Wind, score }
      ],
      'west',
      0,
      5, // 5 sticks / 2 winners = 2 each + 1 remainder
      allSeats
    );
    const total = payments.reduce((s, p) => s + p.riichiSticksWon, 0);
    assert.equal(total, 5, 'no sticks may vanish');
    // From west, north(1) < east(2) < south(3); east is nearer than south
    assert.equal(payments.find(p => p.winner === 'east')!.riichiSticksWon, 3);
    assert.equal(payments.find(p => p.winner === 'south')!.riichiSticksWon, 2);
  });

  it('should carry over sticks when to_next_dealer points at a non-winner', () => {
    const rulesPath = writeRules({ multipleRon: { riichiBetDistribution: 'to_next_dealer' } });
    const room = new GameRoom(rulesPath);
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.doraIndicators = tiles('white');
    state.riichiSticks = 2;

    // Winners west + north; dealer east loses -> next dealer south (not a winner)
    state.players[1].hand = tiles(JUNK_13);
    state.players[2].hand = tiles(PINFU_WAIT_6M);
    state.players[3].hand = tiles(PINFU_WAIT_6M);
    const winTile = tiles('6m')[0];
    state.players[0].hand[0] = winTile;
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile });
    room.processEvent({ type: 'RON_DECLARE', player: 'west', tile: winTile });

    assert.equal(state.phase, 'scoring');
    assert.equal(state.riichiSticks, 2, 'sticks stay on the table for the next dealer');
  });

  it('should pay sticks to the next dealer when they win', () => {
    const rulesPath = writeRules({ multipleRon: { riichiBetDistribution: 'to_next_dealer' } });
    const room = new GameRoom(rulesPath);
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.doraIndicators = tiles('white');
    state.riichiSticks = 2;

    // Winners south + west; next dealer south wins -> south takes all sticks
    state.players[1].hand = tiles(PINFU_WAIT_6M);
    state.players[2].hand = tiles(PINFU_WAIT_6M);
    state.players[3].hand = tiles(JUNK_13);
    const winTile = tiles('6m')[0];
    state.players[0].hand[0] = winTile;
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile });
    const res = room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: winTile });

    const paymentMsg = res.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    assert.equal(paymentMsg.payments.find((p: any) => p.winner === 'south').riichiSticksWon, 2);
    assert.equal(state.riichiSticks, 0);
  });
});
