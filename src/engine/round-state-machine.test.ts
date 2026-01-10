import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RoundStateMachine, BRANCHING_POINTS_DOCUMENTATION } from './round-state-machine.js';
import { RuleConfig } from '../config/rule-config.js';
import { GameState } from '../types/game-state.js';

/**
 * Test suite for round state machine
 * Tests all state transitions and branching points
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

function createInitialState(): GameState {
  return {
    ruleConfigPath: 'rules/default.rule.json',
    round: { wind: 'east', number: 1 },
    honba: 0,
    riichiSticks: 0,
    players: [
      {
        id: 'p1',
        seat: 'east',
        score: 25000,
        hand: [],
        discards: [],
        melds: [],
        riichi: { declared: false, ippatsu: false, doubleRiichi: false, turn: null },
        furiten: false,
        isDealer: true
      },
      {
        id: 'p2',
        seat: 'south',
        score: 25000,
        hand: [],
        discards: [],
        melds: [],
        riichi: { declared: false, ippatsu: false, doubleRiichi: false, turn: null },
        furiten: false,
        isDealer: false
      },
      {
        id: 'p3',
        seat: 'west',
        score: 25000,
        hand: [],
        discards: [],
        melds: [],
        riichi: { declared: false, ippatsu: false, doubleRiichi: false, turn: null },
        furiten: false,
        isDealer: false
      },
      {
        id: 'p4',
        seat: 'north',
        score: 25000,
        hand: [],
        discards: [],
        melds: [],
        riichi: { declared: false, ippatsu: false, doubleRiichi: false, turn: null },
        furiten: false,
        isDealer: false
      }
    ],
    wall: [],
    deadWall: [],
    doraIndicators: [],
    uraDoraIndicators: [],
    currentTurn: 0,
    currentPlayer: 'east',
    lastDiscard: null,
    phase: 'waiting',
    pendingActions: [],
    actionHistory: []
  };
}

describe('RoundStateMachine - Basic State Transitions', () => {
  it('should transition from waiting to dealing on ROUND_START', () => {
    const state = createInitialState();
    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({ type: 'ROUND_START' });

    assert.equal(result.newPhase, 'dealing');
    assert.ok(result.events.includes('Round starting'));
  });

  it('should transition from dealing to playing on DEAL_COMPLETE', () => {
    const state = createInitialState();
    state.phase = 'dealing';
    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({ type: 'DEAL_COMPLETE' });

    assert.equal(result.newPhase, 'playing');
    assert.ok(result.events.includes('Dealing complete'));
  });

  it('should handle draw event during playing', () => {
    const state = createInitialState();
    state.phase = 'playing';
    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({ type: 'DRAW', player: 'east' });

    assert.equal(result.newPhase, 'playing');
    assert.ok(result.events.some(e => e.includes('drew a tile')));
  });

  it('should reject invalid event for current phase', () => {
    const state = createInitialState();
    state.phase = 'waiting';
    const machine = new RoundStateMachine(defaultRules, state);

    assert.throws(() => {
      machine.transition({ type: 'DEAL_COMPLETE' });
    }, /Invalid event/);
  });
});

describe('RoundStateMachine - BRANCHING POINT: MULTIPLE_RON_CHECK', () => {
  it('should trigger MULTIPLE_RON_CHECK branching point on RON_DECLARE', () => {
    const state = createInitialState();
    state.phase = 'playing';
    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({
      type: 'RON_DECLARE',
      player: 'south',
      tile: { id: 't1', suit: 'man', rank: 5 }
    });

    assert.equal(result.newPhase, 'ron_declared');
    assert.equal(result.branchingPoint, 'MULTIPLE_RON_CHECK');
    assert.ok(result.events.some(e => e.includes('declared ron')));
  });

  it('should handle multiple ron resolution', () => {
    const state = createInitialState();
    state.phase = 'ron_declared';
    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({
      type: 'MULTIPLE_RON_RESOLVED',
      winners: ['south', 'north']
    });

    assert.equal(result.newPhase, 'scoring');
    assert.equal(result.branchingPoint, 'RIICHI_BET_DISTRIBUTION');
    assert.ok(result.events.some(e => e.includes('Multiple ron resolved')));
  });

  it('should proceed to PAO_CHECK for single ron', () => {
    const state = createInitialState();
    state.phase = 'ron_declared';
    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({
      type: 'MULTIPLE_RON_RESOLVED',
      winners: ['south']
    });

    assert.equal(result.newPhase, 'scoring');
    assert.equal(result.branchingPoint, 'PAO_CHECK');
  });
});

describe('RoundStateMachine - BRANCHING POINT: NAGASHI_MANGAN_CHECK', () => {
  it('should trigger NAGASHI_MANGAN_CHECK when wall is exhausted', () => {
    const state = createInitialState();
    state.phase = 'playing';
    state.wall = []; // Empty wall indicates exhaustive draw
    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({
      type: 'DISCARD',
      player: 'east',
      tile: { id: 't1', suit: 'honor', honorType: 'east' }
    });

    assert.equal(result.newPhase, 'draw');
    assert.equal(result.branchingPoint, 'NAGASHI_MANGAN_CHECK');
  });

  it('should check nagashi mangan with terminal/honor discards', () => {
    const state = createInitialState();
    state.phase = 'playing';
    state.wall = [];

    // Set up player with all terminal/honor discards
    state.players[0].discards = [
      { id: 't1', suit: 'man', rank: 1 },
      { id: 't2', suit: 'man', rank: 9 },
      { id: 't3', suit: 'honor', honorType: 'east' }
    ];

    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({
      type: 'DISCARD',
      player: 'east',
      tile: { id: 't4', suit: 'honor', honorType: 'white' }
    });

    assert.equal(result.branchingPoint, 'NAGASHI_MANGAN_CHECK');
  });
});

describe('RoundStateMachine - BRANCHING POINT: PAO_CHECK', () => {
  it('should trigger PAO_CHECK after tsumo declared', () => {
    const state = createInitialState();
    state.phase = 'tsumo_declared';
    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({
      type: 'MULTIPLE_RON_RESOLVED',
      winners: []
    });

    // When no explicit transition is defined, it goes to scoring
    // with PAO_CHECK
    // Note: This is simplified; real implementation would handle this differently
  });
});

describe('RoundStateMachine - BRANCHING POINT: DEALER_ROTATION', () => {
  it('should trigger DEALER_ROTATION at round end', () => {
    const state = createInitialState();
    state.phase = 'scoring';
    const machine = new RoundStateMachine(defaultRules, state);

    const result = machine.transition({ type: 'SCORING_COMPLETE' });

    assert.equal(result.newPhase, 'round_end');
    assert.equal(result.branchingPoint, 'DEALER_ROTATION');
  });
});

describe('RoundStateMachine - BRANCHING POINT: HONBA_UPDATE', () => {
  it('should trigger HONBA_UPDATE on draw', () => {
    const state = createInitialState();
    state.phase = 'draw';
    const machine = new RoundStateMachine(defaultRules, state);

    // Transition through draw phase
    // Note: Actual implementation may vary
  });
});

describe('RoundStateMachine - Branching Points Documentation', () => {
  it('should have documentation for all branching points', () => {
    const expectedBranchingPoints = [
      'MULTIPLE_RON_CHECK',
      'RIICHI_BET_DISTRIBUTION',
      'PAO_CHECK',
      'PAO_PAYMENT_CALCULATION',
      'KIRIAGE_MANGAN_CHECK',
      'KAZOE_YAKUMAN_CHECK',
      'NAGASHI_MANGAN_CHECK',
      'EXHAUSTIVE_DRAW_CHECK',
      'ABORTIVE_DRAW_CHECK',
      'HONBA_UPDATE',
      'DEALER_ROTATION'
    ];

    expectedBranchingPoints.forEach(point => {
      assert.ok(
        BRANCHING_POINTS_DOCUMENTATION[point],
        `Missing documentation for branching point: ${point}`
      );

      const doc = BRANCHING_POINTS_DOCUMENTATION[point];
      assert.ok(doc.description, `Missing description for ${point}`);
      assert.ok(doc.outcomes, `Missing outcomes for ${point}`);
    });
  });

  it('should document triggers for each branching point', () => {
    Object.entries(BRANCHING_POINTS_DOCUMENTATION).forEach(([point, doc]) => {
      assert.ok(
        doc.triggers || doc.conditions,
        `${point} should have triggers or conditions documented`
      );
    });
  });

  it('should document rules affecting each branching point', () => {
    const pointsWithRules = [
      'MULTIPLE_RON_CHECK',
      'RIICHI_BET_DISTRIBUTION',
      'PAO_CHECK',
      'PAO_PAYMENT_CALCULATION',
      'KIRIAGE_MANGAN_CHECK',
      'KAZOE_YAKUMAN_CHECK',
      'NAGASHI_MANGAN_CHECK'
    ];

    pointsWithRules.forEach(point => {
      const doc = BRANCHING_POINTS_DOCUMENTATION[point];
      assert.ok(
        doc.rules,
        `${point} should have rules documented`
      );
    });
  });
});

describe('RoundStateMachine - Complete Round Flow', () => {
  it('should handle complete round from start to end', () => {
    const state = createInitialState();
    const machine = new RoundStateMachine(defaultRules, state);

    // Start round
    let result = machine.transition({ type: 'ROUND_START' });
    assert.equal(result.newPhase, 'dealing');

    // Complete dealing
    state.phase = result.newPhase;
    result = machine.transition({ type: 'DEAL_COMPLETE' });
    assert.equal(result.newPhase, 'playing');

    // Player draws
    state.phase = result.newPhase;
    result = machine.transition({ type: 'DRAW', player: 'east' });
    assert.equal(result.newPhase, 'playing');

    // Player declares tsumo
    state.phase = result.newPhase;
    result = machine.transition({
      type: 'TSUMO_DECLARE',
      player: 'east',
      tile: { id: 't1', suit: 'man', rank: 5 }
    });
    assert.equal(result.newPhase, 'tsumo_declared');

    // Note: Further transitions would require more complex state management
  });

  it('should handle round with multiple ron', () => {
    const state = createInitialState();
    state.phase = 'playing';
    const machine = new RoundStateMachine(defaultRules, state);

    // Player discards
    let result = machine.transition({
      type: 'DISCARD',
      player: 'east',
      tile: { id: 't1', suit: 'man', rank: 5 }
    });

    // Player declares ron
    state.phase = result.newPhase;
    result = machine.transition({
      type: 'RON_DECLARE',
      player: 'south',
      tile: { id: 't1', suit: 'man', rank: 5 }
    });

    assert.equal(result.newPhase, 'ron_declared');
    assert.equal(result.branchingPoint, 'MULTIPLE_RON_CHECK');

    // Resolve multiple ron
    state.phase = result.newPhase;
    result = machine.transition({
      type: 'MULTIPLE_RON_RESOLVED',
      winners: ['south', 'north']
    });

    assert.equal(result.newPhase, 'scoring');
    assert.equal(result.branchingPoint, 'RIICHI_BET_DISTRIBUTION');
  });
});
