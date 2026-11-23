import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../../src/server/game-room.js';
import { getDefaultRuleConfigPath } from '../../src/config/rule-config.js';
import { parseTile, TileInstance } from '../../src/types/tiles.js';
import { Wind } from '../../src/types/game-state.js';

function tiles(spec: string): TileInstance[] {
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s, i) => ({
      id: `ab-${i}-${s}`,
      ...parseTile(s)
    }));
}

function tile(spec: string, id: string): TileInstance {
  return { id, ...parseTile(spec) };
}

function newRoom(): GameRoom {
  const room = new GameRoom(getDefaultRuleConfigPath());
  room.processEvent({ type: 'ROUND_START' });
  room.processEvent({ type: 'DEAL_COMPLETE' });
  return room;
}

describe('G-1 Abortive draw - four winds (四風連打)', () => {
  it('should abort when all 4 players discard the same wind on the first turn', () => {
    const room = newRoom();
    const state = room.getState();
    const seats: Wind[] = ['east', 'south', 'west', 'north'];

    seats.forEach((seat, i) => {
      const t = tile('east', `fw-${i}`);
      const res = room.processEvent({ type: 'DISCARD', player: seat, tile: t });
      if (i < 3) {
        assert.equal(res.state.phase, 'playing', `still playing after ${i + 1} discards`);
      } else {
        assert.equal(res.state.phase, 'draw');
        assert.equal(res.state.drawType, 'four_wind');
        assert.ok(res.messages.some(m => m.type === 'branching_point' &&
          (m as any).branchingPoint === 'ABORTIVE_DRAW_CHECK'));
      }
    });

    // 途中流局は連荘・本場+1 (draw -> ROUND_END -> round_end -> ROUND_END -> waiting)
    room.processEvent({ type: 'ROUND_END' });
    assert.equal(state.phase, 'round_end');
    room.processEvent({ type: 'ROUND_END' });
    assert.equal(state.phase, 'waiting');
    assert.equal(state.honba, 1);
    assert.equal(state.round.wind, 'east');
    assert.equal(state.round.number, 1);
    assert.equal(state.players[0].isDealer, true);
  });

  it('should not abort when the first discards are different winds', () => {
    const room = newRoom();
    const specs: Array<[Wind, string]> = [
      ['east', 'east'], ['south', 'south'], ['west', 'west'], ['north', 'north']
    ];
    specs.forEach(([seat, spec], i) => {
      const res = room.processEvent({ type: 'DISCARD', player: seat, tile: tile(spec, `fwx-${i}`) });
      assert.equal(res.state.phase, 'playing');
    });
  });

  it('should not abort when a call happened before the fourth discard', () => {
    const room = newRoom();
    const state = room.getState();

    room.processEvent({ type: 'DISCARD', player: 'east', tile: tile('1m', 'fwc-0') });
    // South pons the 1m (a call breaks four-wind eligibility)
    state.players[1].hand = tiles('1m 1m 2p 3p 4p 5p 6p 7p 8p 2s 3s 4s 5s');
    room.processEvent({ type: 'PON', player: 'south', tile: state.lastDiscard! });

    room.processEvent({ type: 'DISCARD', player: 'south', tile: tile('east', 'fwc-1') });
    room.processEvent({ type: 'DISCARD', player: 'west', tile: tile('east', 'fwc-2') });
    room.processEvent({ type: 'DISCARD', player: 'north', tile: tile('east', 'fwc-3') });
    const res = room.processEvent({ type: 'DISCARD', player: 'east', tile: tile('east', 'fwc-4') });
    assert.equal(res.state.phase, 'playing');
  });
});

describe('G-1 Abortive draw - four riichi (四家立直)', () => {
  const tenpai14 = '1m 2m 3m 4p 5p 6p 7s 8s 9s white white red red 9m';

  it('should abort when the fourth player declares riichi', () => {
    const room = newRoom();
    const state = room.getState();
    const seats: Wind[] = ['east', 'south', 'west', 'north'];

    seats.forEach((seat, i) => {
      const idx = ['east', 'south', 'west', 'north'].indexOf(seat);
      state.players[idx].hand = tiles(tenpai14);
      const res = room.processEvent({ type: 'RIICHI_DECLARE', player: seat });
      if (i < 3) {
        assert.equal(res.state.phase, 'playing');
      } else {
        assert.equal(res.state.phase, 'draw');
        assert.equal(res.state.drawType, 'four_riichi');
      }
    });

    // 供託は場に残る
    assert.equal(state.riichiSticks, 4);

    room.processEvent({ type: 'ROUND_END' });
    room.processEvent({ type: 'ROUND_END' });
    assert.equal(state.honba, 1);
    assert.equal(state.players[0].isDealer, true);
    assert.equal(state.riichiSticks, 4);
  });
});

describe('G-1 Abortive draw - four kans (四槓散了)', () => {
  it('should abort on the fourth kan by different players', () => {
    const room = newRoom();
    const state = room.getState();
    const seats: Wind[] = ['east', 'south', 'west', 'north'];
    const kinds = ['1m', '2m', '3m', '4m'];

    seats.forEach((seat, i) => {
      const idx = seats.indexOf(seat);
      state.players[idx].hand = [
        ...tiles(`${kinds[i]} ${kinds[i]} ${kinds[i]} ${kinds[i]}`),
        ...tiles('5p 6p 7p 2s 3s 4s 6s 7s 8s')
      ];
      state.currentPlayer = seat;
      const res = room.processEvent({
        type: 'KAN',
        player: seat,
        tile: state.players[idx].hand[0]
      });
      if (i < 3) {
        assert.equal(res.state.phase, 'playing', `still playing after kan ${i + 1}`);
      } else {
        assert.equal(res.state.phase, 'draw');
        assert.equal(res.state.drawType, 'four_kan');
      }
    });

    room.processEvent({ type: 'ROUND_END' });
    room.processEvent({ type: 'ROUND_END' });
    assert.equal(state.honba, 1);
    assert.equal(state.players[0].isDealer, true);
  });

  it('should continue when one player makes all four kans (suukantsu chance)', () => {
    const room = newRoom();
    const state = room.getState();
    const kinds = ['1m', '2m', '3m', '4m'];

    kinds.forEach((kind) => {
      state.players[0].hand = [
        ...tiles(`${kind} ${kind} ${kind} ${kind}`),
        ...tiles('5p 6p 7p 2s 3s 4s 6s 7s 8s')
      ];
      state.currentPlayer = 'east';
      const res = room.processEvent({
        type: 'KAN',
        player: 'east',
        tile: state.players[0].hand[0]
      });
      assert.equal(res.state.phase, 'playing');
    });
    assert.equal(state.players[0].melds.filter(m => m.type === 'ankan').length, 4);
  });
});

describe('G-1 Abortive draw - nine terminals (九種九牌)', () => {
  const kyuushuHand = '1m 9m 1p 9p 1s 9s east south west north white green red 2m';

  it('should abort on KYUUSHU_DECLARE with 9+ terminal/honor kinds', () => {
    const room = newRoom();
    const state = room.getState();
    state.players[0].hand = tiles(kyuushuHand);

    const res = room.processEvent({ type: 'KYUUSHU_DECLARE', player: 'east' });
    assert.equal(res.state.phase, 'draw');
    assert.equal(res.state.drawType, 'nine_terminals');

    room.processEvent({ type: 'ROUND_END' });
    room.processEvent({ type: 'ROUND_END' });
    assert.equal(state.honba, 1);
    assert.equal(state.players[0].isDealer, true);
  });

  it('should reject KYUUSHU_DECLARE without 9 kinds', () => {
    const room = newRoom();
    const state = room.getState();
    state.players[0].hand = tiles('2m 3m 4m 4p 5p 6p 6s 7s 8s 5p 5p 2s 3s 4s');

    const res = room.processEvent({ type: 'KYUUSHU_DECLARE', player: 'east' });
    assert.equal(res.state.phase, 'playing');
    assert.ok(res.messages.some(m => m.type === 'error'));
  });

  it('should reject KYUUSHU_DECLARE after the first discard', () => {
    const room = newRoom();
    const state = room.getState();
    state.players[0].hand = tiles(kyuushuHand);

    room.processEvent({ type: 'DISCARD', player: 'east', tile: state.players[0].hand[13] });
    const res = room.processEvent({ type: 'KYUUSHU_DECLARE', player: 'east' });
    assert.equal(res.state.phase, 'playing');
    assert.ok(res.messages.some(m => m.type === 'error'));
  });

  it('should auto-declare nine terminals for an NPC on its first turn', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.assignPlayer('human');
    room.autoStartRound();
    const state = room.getState();

    // South NPC holds a kyushu hand and has not acted yet
    state.players[1].hand = tiles(kyuushuHand);
    state.currentPlayer = 'south';

    const step = room.stepNpc();
    assert.equal(step.acted, true);
    assert.equal(state.phase, 'draw');
    assert.equal(state.drawType, 'nine_terminals');
  });
});
