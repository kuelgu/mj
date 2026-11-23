import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../../src/server/game-room.js';
import { getDefaultRuleConfigPath } from '../../src/config/rule-config.js';
import { parseTile, TileInstance } from '../../src/types/tiles.js';

function tiles(spec: string): TileInstance[] {
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s, i) => ({
      id: `ck-${i}-${s}`,
      ...parseTile(s)
    }));
}

const JUNK_13 = '1m 4m 7m 1p 4p 7p 1s 4s 7s east south west north';

/** South waits shanpon on 5p/7p: 234m 234s 777p 55p 55p (tanyao when winning on 5p) */
const SOUTH_CHANKAN_HAND = '2m 3m 4m 2s 3s 4s 7p 7p 7p 5p 5p 5p 5p';

function newRoom(): GameRoom {
  const room = new GameRoom(getDefaultRuleConfigPath());
  room.processEvent({ type: 'ROUND_START' });
  room.processEvent({ type: 'DEAL_COMPLETE' });
  return room;
}

/** East pons 5p from West, leaving one 5p in hand for kakan. */
function setupEastPon(room: GameRoom): void {
  const state = room.getState();
  const tile5p: TileInstance = { id: 'ck-5p-call', suit: 'pin', rank: 5 };
  state.players[2].hand[0] = tile5p;
  room.processEvent({ type: 'DISCARD', player: 'west', tile: tile5p });

  state.players[0].hand = [
    ...tiles('5p 5p 5p'),
    ...tiles('2m 3m 4m 6p 7p 8p 3s 4s 5s 6s')
  ];
  const ponRes = room.processEvent({ type: 'PON', player: 'east', tile: state.lastDiscard! });
  assert.ok(!ponRes.messages.some(m => m.type === 'error'), 'pon setup must succeed');
}

describe('G-2 Chankan (槍槓) - kakan window', () => {
  it('should auto-complete kakan with rinshan when nobody can ron', () => {
    const room = newRoom();
    const state = room.getState();
    // Deterministic junk hands: nobody can ron the kakan tile
    state.players[1].hand = tiles(JUNK_13);
    state.players[2].hand = tiles(JUNK_13);
    state.players[3].hand = tiles(JUNK_13);
    setupEastPon(room);

    const doraBefore = state.doraIndicators.length;
    const kakanTile = state.players[0].hand.find(t => t.suit === 'pin' && t.rank === 5)!;
    const res = room.processEvent({ type: 'KAN', player: 'east', tile: kakanTile });

    assert.ok(!res.messages.some(m => m.type === 'error'));
    assert.equal(state.phase, 'playing');
    // Nobody could ron -> completed synchronously: rinshan drawn + new dora
    assert.equal(state.pendingKan, null);
    assert.equal(state.doraIndicators.length, doraBefore + 1);
    assert.equal(state.lastDrawWasRinshan, true);
  });

  it('should let an NPC ron the kakan tile with chankan yaku', () => {
    const room = newRoom();
    const state = room.getState();
    state.doraIndicators = tiles('white');
    state.players[1].hand = tiles(SOUTH_CHANKAN_HAND);
    state.players[2].hand = tiles(JUNK_13);
    state.players[3].hand = tiles(JUNK_13);
    setupEastPon(room);

    const kakanTile = state.players[0].hand.find(t => t.suit === 'pin' && t.rank === 5)!;
    const res = room.processEvent({ type: 'KAN', player: 'east', tile: kakanTile });

    assert.equal(state.phase, 'scoring');
    const paymentMsg = res.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg, 'chankan ron should settle');
    const payment = paymentMsg.payments[0];
    assert.equal(payment.winner, 'south');
    assert.equal(payment.fromPlayer, 'east');
    const yakuTypes = payment.handEvaluation.yaku.map((y: any) => y.type);
    assert.ok(yakuTypes.includes('chankan'), `expected chankan, got ${yakuTypes}`);
    assert.ok(yakuTypes.includes('tanyao'));
  });

  it('should wait for a human who can ron, then settle on declaration', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.assignPlayer('h1'); // east
    room.assignPlayer('h2'); // south
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.doraIndicators = tiles('white');
    state.players[1].hand = tiles(SOUTH_CHANKAN_HAND);
    state.players[2].hand = tiles(JUNK_13);
    state.players[3].hand = tiles(JUNK_13);
    setupEastPon(room);

    const kakanTile = state.players[0].hand.find(t => t.suit === 'pin' && t.rank === 5)!;
    const kanRes = room.processEvent({ type: 'KAN', player: 'east', tile: kakanTile });

    // South (human) can ron -> window stays open, no settlement yet
    assert.equal(state.phase, 'playing');
    assert.ok(state.pendingKan);
    assert.ok(!kanRes.messages.some(m => m.type === 'payment'));

    const ronRes = room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: state.pendingKan!.tile });
    assert.equal(state.phase, 'scoring');
    const paymentMsg = ronRes.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    assert.equal(paymentMsg.payments[0].winner, 'south');
  });

  it('should complete the kan after the human passes', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.assignPlayer('h1'); // east
    room.assignPlayer('h2'); // south
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.players[1].hand = tiles(SOUTH_CHANKAN_HAND);
    state.players[2].hand = tiles(JUNK_13);
    state.players[3].hand = tiles(JUNK_13);
    setupEastPon(room);

    const doraBefore = state.doraIndicators.length;
    const kakanTile = state.players[0].hand.find(t => t.suit === 'pin' && t.rank === 5)!;
    room.processEvent({ type: 'KAN', player: 'east', tile: kakanTile });
    assert.ok(state.pendingKan);

    room.markPlayerPassedCall('h2');
    const followUp = room.resolvePendingDeclarations();

    assert.equal(state.pendingKan, null);
    assert.equal(state.phase, 'playing');
    assert.equal(state.doraIndicators.length, doraBefore + 1);
    assert.ok(followUp.length > 0);
  });

  it('should reject pon/chi/discard while the chankan window is open', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.assignPlayer('h1'); // east
    room.assignPlayer('h2'); // south
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();
    state.players[1].hand = tiles(SOUTH_CHANKAN_HAND);
    state.players[2].hand = tiles('5p 5p 2m 3m 4m 6p 7p 8p 3s 4s 5s');
    state.players[3].hand = tiles(JUNK_13);
    setupEastPon(room);

    const kakanTile = state.players[0].hand.find(t => t.suit === 'pin' && t.rank === 5)!;
    room.processEvent({ type: 'KAN', player: 'east', tile: kakanTile });
    assert.ok(state.pendingKan);

    const ponRes = room.processEvent({ type: 'PON', player: 'west', tile: state.lastDiscard! });
    assert.ok(ponRes.messages.some(m => m.type === 'error' && (m as any).error.includes('チャンカン確認中')));

    const disRes = room.processEvent({ type: 'DISCARD', player: 'east', tile: state.players[0].hand[0] });
    assert.ok(disRes.messages.some(m => m.type === 'error'));
  });
});
