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
      id: `rk-${i}-${s}`,
      ...parseTile(s)
    }));
}

function newRoom(): GameRoom {
  const room = new GameRoom(getDefaultRuleConfigPath());
  room.processEvent({ type: 'ROUND_START' });
  room.processEvent({ type: 'DEAL_COMPLETE' });
  return room;
}

function declareRiichi(room: GameRoom): void {
  const res = room.processEvent({ type: 'RIICHI_DECLARE', player: 'east' });
  assert.ok(!res.messages.some(m => m.type === 'error'), 'riichi setup must succeed');
  assert.equal(room.getState().players[0].riichi.declared, true);
}

describe('G-6 Riichi kan restriction (送りカン禁止)', () => {
  it('should allow ankan after riichi when waits are unchanged', () => {
    const room = newRoom();
    const state = room.getState();
    // Shanpon tenpai 111m 234p 234s 55p 77p, drawn 1m last -> ankan keeps {5p, 7p} waits
    state.players[0].hand = tiles('1m 1m 1m 2p 3p 4p 2s 3s 4s 5p 5p 7p 7p 1m');
    declareRiichi(room);

    const kanTile = state.players[0].hand.find(t => t.suit === 'man' && t.rank === 1)!;
    const res = room.processEvent({ type: 'KAN', player: 'east', tile: kanTile });
    assert.ok(!res.messages.some(m => m.type === 'error'));
    assert.equal(state.players[0].melds.length, 1);
    assert.equal(state.players[0].melds[0].type, 'ankan');
  });

  it('should reject ankan after riichi when waits would change (okuri-kan)', () => {
    const room = newRoom();
    const state = room.getState();
    // Shanpon {5p, 7s} tenpai, drawn 5p last -> ankan of 1m flips waits to {4m}
    state.players[0].hand = tiles('1m 1m 1m 1m 2m 3m 2p 3p 4p 5p 5p 7s 7s 5p');
    declareRiichi(room);

    const kanTile = state.players[0].hand.find(t => t.suit === 'man' && t.rank === 1)!;
    const res = room.processEvent({ type: 'KAN', player: 'east', tile: kanTile });
    assert.ok(res.messages.some(m => m.type === 'error' && (m as any).error.includes('送りカン')));
    assert.equal(state.players[0].melds.length, 0);
    assert.equal(state.phase, 'playing');
  });

  it('should not restrict kan before riichi', () => {
    const room = newRoom();
    const state = room.getState();
    state.players[0].hand = tiles('1m 1m 1m 1m 2p 3p 4p 2s 3s 4s 5p 5p 5p 2m');
    state.currentPlayer = 'east';

    const kanTile = state.players[0].hand.find(t => t.suit === 'man' && t.rank === 1)!;
    const res = room.processEvent({ type: 'KAN', player: 'east', tile: kanTile });
    assert.ok(!res.messages.some(m => m.type === 'error'));
    assert.equal(state.players[0].melds.length, 1);
  });
});
