import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GameRoom } from '../../src/server/game-room.js';
import { getDefaultRuleConfigPath } from '../../src/config/rule-config.js';

describe('GameRoom - assignPlayer', () => {
  it('should ignore fixed test seat IDs by default', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    // 'player2' would map to south if fixed seats were enabled;
    // by default it takes the first empty seat (east).
    assert.equal(room.assignPlayer('player2'), 'east');
  });

  it('should honor fixed test seat IDs when enabled', () => {
    const room = new GameRoom(getDefaultRuleConfigPath(), { enableFixedTestSeats: true });
    assert.equal(room.assignPlayer('player2'), 'south');
    assert.equal(room.assignPlayer('p4'), 'north');
    assert.equal(room.assignPlayer('player1'), 'east');
  });

  it('should return the same seat when the same player rejoins', () => {
    const room = new GameRoom(getDefaultRuleConfigPath(), { enableFixedTestSeats: true });
    assert.equal(room.assignPlayer('player3'), 'west');
    assert.equal(room.assignPlayer('player3'), 'west');
  });

  it('should not steal a seat occupied by another human', () => {
    const room = new GameRoom(getDefaultRuleConfigPath(), { enableFixedTestSeats: true });
    assert.equal(room.assignPlayer('alice'), 'east');
    assert.equal(room.assignPlayer('bob'), 'south');
    // 'player2' maps to south, but bob is there: must fall through to west.
    assert.equal(room.assignPlayer('player2'), 'west');
    const south = room.getState().players.find(p => p.seat === 'south');
    assert.equal(south?.id, 'bob');
  });
});
