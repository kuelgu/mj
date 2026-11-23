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
      id: `cv-${i}-${s}`,
      ...parseTile(s)
    }));
}

function newRoom(): GameRoom {
  const room = new GameRoom(getDefaultRuleConfigPath());
  room.processEvent({ type: 'ROUND_START' });
  room.processEvent({ type: 'DEAL_COMPLETE' });
  return room;
}

function eastDiscards(room: GameRoom, spec: string, id: string): TileInstance {
  const state = room.getState();
  const t: TileInstance = { id, ...parseTile(spec) };
  state.players[0].hand[0] = t;
  const res = room.processEvent({ type: 'DISCARD', player: 'east', tile: t });
  assert.ok(!res.messages.some(m => m.type === 'error'), 'discard setup must succeed');
  return state.lastDiscard!;
}

describe('G-5 Call validation (鳴き検証)', () => {
  it('should allow chi from the upper seat (kamicha)', () => {
    const room = newRoom();
    const state = room.getState();
    const discarded = eastDiscards(room, '5m', 'cv-chi-5m');
    state.players[1].hand = tiles('4m 6m 1p 2p 3p 4p 5p 6p 7s 8s 9s white white');

    const res = room.processEvent({ type: 'CHI', player: 'south', tile: discarded });
    assert.ok(!res.messages.some(m => m.type === 'error'));
    assert.equal(state.players[1].melds.length, 1);
    assert.equal(state.players[1].melds[0].type, 'chi');
  });

  it('should reject chi from a non-upper seat', () => {
    const room = newRoom();
    const state = room.getState();
    const discarded = eastDiscards(room, '5m', 'cv-chi2-5m');
    state.players[2].hand = tiles('4m 6m 1p 2p 3p 4p 5p 6p 7s 8s 9s white white');

    const res = room.processEvent({ type: 'CHI', player: 'west', tile: discarded });
    assert.ok(res.messages.some(m => m.type === 'error' && (m as any).error.includes('上家')));
    assert.equal(state.players[2].melds.length, 0);
  });

  it('should allow pon from any other seat', () => {
    const room = newRoom();
    const state = room.getState();
    const discarded = eastDiscards(room, '5p', 'cv-pon-5p');
    state.players[3].hand = tiles('5p 5p 1m 2m 3m 4p 6p 7p 7s 8s 9s white white');

    const res = room.processEvent({ type: 'PON', player: 'north', tile: discarded });
    assert.ok(!res.messages.some(m => m.type === 'error'));
    assert.equal(state.players[3].melds.length, 1);
    assert.equal(state.players[3].melds[0].type, 'pon');
  });

  it('should reject pon on a tile id that differs from the last discard', () => {
    const room = newRoom();
    const state = room.getState();
    eastDiscards(room, '5p', 'cv-pon2-5p');
    state.players[1].hand = tiles('5p 5p 1m 2m 3m 4p 6p 7p 7s 8s 9s white white');

    const impostor: TileInstance = { id: 'cv-impostor', suit: 'pin', rank: 5 };
    const res = room.processEvent({ type: 'PON', player: 'south', tile: impostor });
    assert.ok(res.messages.some(m => m.type === 'error' && (m as any).error.includes('一致しません')));
  });

  it('should reject pon when there is no last discard', () => {
    const room = newRoom();
    const state = room.getState();
    state.players[1].hand = tiles('5p 5p 1m 2m 3m 4p 6p 7p 7s 8s 9s white white');

    const res = room.processEvent({
      type: 'PON',
      player: 'south',
      tile: { id: 'cv-nodiscard', suit: 'pin', rank: 5 }
    });
    assert.ok(res.messages.some(m => m.type === 'error' && (m as any).error.includes('捨牌がありません')));
  });

  it('should reject pon on your own discard', () => {
    const room = newRoom();
    const state = room.getState();
    const discarded = eastDiscards(room, '5p', 'cv-self-5p');
    state.players[0].hand.push(...tiles('5p 5p'));

    const res = room.processEvent({ type: 'PON', player: 'east', tile: discarded });
    assert.ok(res.messages.some(m => m.type === 'error' && (m as any).error.includes('自分の捨牌')));
  });

  it('should reject pon/chi/daiminkan while in riichi', () => {
    const room = newRoom();
    const state = room.getState();
    state.players[1].hand = tiles('1m 2m 3m 4p 5p 6p 7s 8s 9s white white red red 9m');
    room.processEvent({ type: 'RIICHI_DECLARE', player: 'south' });
    assert.equal(state.players[1].riichi.declared, true);

    const discarded = eastDiscards(room, '5p', 'cv-riichi-5p');
    state.players[1].hand.push(...tiles('5p 5p'));
    const ponRes = room.processEvent({ type: 'PON', player: 'south', tile: discarded });
    assert.ok(ponRes.messages.some(m => m.type === 'error' && (m as any).error.includes('リーチ中はポンできません')));

    state.players[1].hand.push(...tiles('4m 6m'));
    const chiRes = room.processEvent({
      type: 'CHI',
      player: 'south',
      tile: { id: 'cv-riichi-5m', suit: 'man', rank: 5 }
    });
    // Chi is rejected (riichi takes precedence over tile mismatch in checks)
    assert.ok(chiRes.messages.some(m => m.type === 'error'));
  });

  it('should reject daiminkan without a matching last discard', () => {
    const room = newRoom();
    const state = room.getState();
    state.players[1].hand = tiles('9p 9p 9p 1m 2m 3m 4p 5p 6p 7s 8s 9s white');

    const res = room.processEvent({
      type: 'KAN',
      player: 'south',
      tile: state.players[1].hand[0]
    });
    assert.ok(res.messages.some(m => m.type === 'error'));
    assert.equal(state.players[1].melds.length, 0);
  });

  it('should allow daiminkan on the matching last discard', () => {
    const room = newRoom();
    const state = room.getState();
    const discarded = eastDiscards(room, '9p', 'cv-kan-9p');
    state.players[1].hand = tiles('9p 9p 9p 1m 2m 3m 4p 5p 6p 7s 8s 9s white');

    const res = room.processEvent({ type: 'KAN', player: 'south', tile: discarded });
    assert.ok(!res.messages.some(m => m.type === 'error'));
    assert.equal(state.players[1].melds.length, 1);
    assert.equal(state.players[1].melds[0].type, 'kan');
    assert.equal(state.players[1].melds[0].calledFrom, 'east');
  });
});
