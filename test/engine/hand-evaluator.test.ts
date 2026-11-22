import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HandEvaluator } from '../../src/engine/hand-evaluator.js';
import { parseTile, TileInstance } from '../../src/types/tiles.js';
import { Meld } from '../../src/types/game-state.js';
import { GameRoom } from '../../src/server/game-room.js';
import { getDefaultRuleConfigPath } from '../../src/config/rule-config.js';

function tiles(spec: string): TileInstance[] {
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((s, i) => ({
      id: `t-${i}-${s}`,
      ...parseTile(s)
    }));
}

describe('HandEvaluator - Winning Hand Decomposition & Yaku Evaluation', () => {
  const evaluator = new HandEvaluator();

  it('should evaluate Pinfu + Tanyao + Menzen Tsumo + Iipeikou (20 fu)', () => {
    // 234m 234m 456p 67s + win on 8s (ryanmen wait, non-value pair 55p)
    const hand = tiles('2m 3m 4m 2m 3m 4m 4p 5p 6p 5p 5p 6s 7s');
    const winTile = tiles('8s')[0];

    const res = evaluator.evaluateHand({
      hand,
      winningTile: winTile,
      isTsumo: true,
      seatWind: 'east',
      roundWind: 'east'
    });

    assert.equal(res.isWinningHand, true);
    assert.equal(res.fu, 20);
    const yakuTypes = res.yaku.map(y => y.type);
    assert.ok(yakuTypes.includes('pinfu'));
    assert.ok(yakuTypes.includes('tanyao'));
    assert.ok(yakuTypes.includes('iipeikou'));
    assert.ok(yakuTypes.includes('tsumo'));
    assert.equal(res.han, 4);
  });

  it('should evaluate Pinfu Ron as 30 fu', () => {
    const hand = tiles('1m 2m 3m 4p 5p 6p 7s 8s 9s 2p 2p 4m 5m');
    const winTile = tiles('6m')[0];

    const res = evaluator.evaluateHand({
      hand,
      winningTile: winTile,
      isTsumo: false,
      seatWind: 'south',
      roundWind: 'east'
    });

    assert.equal(res.isWinningHand, true);
    assert.equal(res.fu, 30);
    assert.deepEqual(res.yaku.map(y => y.type), ['pinfu']);
    assert.equal(res.han, 1);
  });

  it('should reject a complete 4-mentsu 1-jantou hand when it has NO yaku (even with dora)', () => {
    // 123m 456p 789s 234m + pair 55p, Kanchan wait on 3m, Ron, no riichi
    const hand = tiles('1m 2m 3m 4p 5p 6p 7s 8s 9s 5p 5p 2m 4m');
    const winTile = tiles('3m')[0];

    const res = evaluator.evaluateHand({
      hand,
      winningTile: winTile,
      isTsumo: false,
      seatWind: 'south',
      roundWind: 'east',
      doraIndicators: tiles('1m')
    });

    assert.equal(res.isWinningHand, false);
    assert.equal(res.yaku.length, 0);
  });

  it('should evaluate Chitoitsu (25 fu, 2 han) and compound with Tanyao / Honroutou', () => {
    const hand = tiles('2m 2m 4m 4m 6p 6p 8p 8p 3s 3s 5s 5s 7s');
    const winTile = tiles('7s')[0];

    const res = evaluator.evaluateHand({
      hand,
      winningTile: winTile,
      isTsumo: false,
      seatWind: 'east',
      roundWind: 'east'
    });

    assert.equal(res.isWinningHand, true);
    assert.equal(res.fu, 25);
    const yakuTypes = res.yaku.map(y => y.type);
    assert.ok(yakuTypes.includes('chitoitsu'));
    assert.ok(yakuTypes.includes('tanyao'));
    assert.equal(res.han, 3);
  });

  it('should prefer Ryanpeikou (3 han) over Chitoitsu (2 han) via High-Point Method', () => {
    // 223344m 556677p 88s -> forms both 7 pairs and Ryanpeikou + Pinfu + Tanyao
    const hand = tiles('2m 2m 3m 3m 4m 4m 5p 5p 6p 6p 7p 8s 8s');
    const winTile = tiles('7p')[0];

    const res = evaluator.evaluateHand({
      hand,
      winningTile: winTile,
      isTsumo: false,
      seatWind: 'east',
      roundWind: 'east'
    });

    assert.equal(res.isWinningHand, true);
    const yakuTypes = res.yaku.map(y => y.type);
    assert.ok(yakuTypes.includes('ryanpeikou'));
    assert.ok(!yakuTypes.includes('chitoitsu'));
    assert.ok(yakuTypes.includes('pinfu'));
    assert.ok(yakuTypes.includes('tanyao'));
    assert.equal(res.han, 5);
  });

  it('should evaluate Sanshoku Doujun and Ittsu with open meld Kuisagari (-1 han)', () => {
    // Open Sanshoku Doujun: 123m (chi), 123p, 123s, 789s, white pair
    const chiMeld: Meld = {
      type: 'chi',
      tiles: tiles('1m 2m 3m'),
      calledFrom: 'north'
    };
    const hand = tiles('1p 2p 3p 1s 2s 3s 7s 8s 9s white');
    const winTile = tiles('white')[0];

    const res = evaluator.evaluateHand({
      hand,
      melds: [chiMeld],
      winningTile: winTile,
      isTsumo: false,
      seatWind: 'east',
      roundWind: 'east'
    });

    assert.equal(res.isWinningHand, true);
    const sanshoku = res.yaku.find(y => y.type === 'sanshoku_doujun');
    assert.ok(sanshoku);
    assert.equal(sanshoku.han, 1); // Kuisagari from 2 to 1
  });

  it('should distinguish Suuankou (Tsumo / Tanki Ron) vs Toitoi+Sanankou (Shanpon Ron)', () => {
    // 4 triplets: 222m 555p 888s EEE + pair 99m
    // Case A: Shanpon Ron on 8s -> completed triplet is open -> Toitoi + Sanankou + Yakuhai (NOT Suuankou)
    const shanponHand = tiles('2m 2m 2m 5p 5p 5p 8s 8s east east east 9m 9m');
    const shanponWin = tiles('8s')[0];

    const shanponRes = evaluator.evaluateHand({
      hand: shanponHand,
      winningTile: shanponWin,
      isTsumo: false,
      seatWind: 'south',
      roundWind: 'east'
    });
    assert.equal(shanponRes.isWinningHand, true);
    assert.equal(shanponRes.yakuman, 0);
    assert.ok(shanponRes.yaku.some(y => y.type === 'toitoi'));
    assert.ok(shanponRes.yaku.some(y => y.type === 'sanankou'));

    // Case B: Tsumo on 8s -> Suuankou Yakuman!
    const tsumoRes = evaluator.evaluateHand({
      hand: shanponHand,
      winningTile: shanponWin,
      isTsumo: true,
      seatWind: 'south',
      roundWind: 'east'
    });
    assert.equal(tsumoRes.isWinningHand, true);
    assert.equal(tsumoRes.yakuman, 1);
    assert.ok(tsumoRes.yaku.some(y => y.type === 'suuankou'));

    // Case C: Tanki Ron on 9m -> Suuankou Tanki Yakuman!
    const tankiHand = tiles('2m 2m 2m 5p 5p 5p 8s 8s 8s east east east 9m');
    const tankiWin = tiles('9m')[0];
    const tankiRes = evaluator.evaluateHand({
      hand: tankiHand,
      winningTile: tankiWin,
      isTsumo: false,
      seatWind: 'south',
      roundWind: 'east'
    });
    assert.equal(tankiRes.isWinningHand, true);
    assert.equal(tankiRes.yakuman, 1);
    assert.ok(tankiRes.yaku.some(y => y.type === 'suuankou'));
  });

  it('should evaluate Kokushi Musou, Daisangen, and Chuuren Poutou Yakuman', () => {
    // Kokushi Musou
    const kokushiHand = tiles('1m 9m 1p 9p 1s 9s east south west north white green red');
    const kokushiWin = tiles('1m')[0];
    const kokushiRes = evaluator.evaluateHand({
      hand: kokushiHand,
      winningTile: kokushiWin,
      isTsumo: false,
      seatWind: 'east',
      roundWind: 'east'
    });
    assert.equal(kokushiRes.isWinningHand, true);
    assert.equal(kokushiRes.yakuman, 1);
    assert.equal(kokushiRes.yaku[0].type, 'kokushi');

    // Daisangen
    const daisangenHand = tiles('white white white green green green red red red 2m 3m 4m 5p');
    const daisangenWin = tiles('5p')[0];
    const daisangenRes = evaluator.evaluateHand({
      hand: daisangenHand,
      winningTile: daisangenWin,
      isTsumo: true,
      seatWind: 'east',
      roundWind: 'east'
    });
    assert.equal(daisangenRes.isWinningHand, true);
    assert.equal(daisangenRes.yakuman, 1);
    assert.ok(daisangenRes.yaku.some(y => y.type === 'daisangen'));

    // Chuuren Poutou
    const chuurenHand = tiles('1m 1m 1m 2m 3m 4m 5m 6m 7m 8m 9m 9m 9m');
    const chuurenWin = tiles('5m')[0];
    const chuurenRes = evaluator.evaluateHand({
      hand: chuurenHand,
      winningTile: chuurenWin,
      isTsumo: true,
      seatWind: 'east',
      roundWind: 'east'
    });
    assert.equal(chuurenRes.isWinningHand, true);
    assert.equal(chuurenRes.yakuman, 1);
    assert.ok(chuurenRes.yaku.some(y => y.type === 'chuuren'));
  });

  it('should count Dora, Ura Dora, and Aka Dora accurately', () => {
    // 234m 567p 678s 999p 22s (Tsumo, Riichi)
    // Dora indicator: 1m (dora = 2m), 9p (dora = 1p), white (dora = green)
    // Ura dora indicator: 8p (dora = 9p x3)
    // Red 5p (akaDora = 1)
    const hand = tiles('2m 3m 4m r5p 6p 7p 6s 7s 8s 9p 9p 9p 2s');
    const winTile = tiles('2s')[0];

    const res = evaluator.evaluateHand({
      hand,
      winningTile: winTile,
      isTsumo: true,
      seatWind: 'east',
      roundWind: 'east',
      riichi: true,
      doraIndicators: tiles('1m'),
      uraDoraIndicators: tiles('8p')
    });

    assert.equal(res.isWinningHand, true);
    assert.equal(res.dora, 1);    // 2m
    assert.equal(res.uraDora, 3); // 9p x3
    assert.equal(res.akaDora, 1); // r5p
  });

  it('should find all winning tiles for a Tenpai hand via getWinningTiles', () => {
    // 234m 456p 789s 55p + 23s -> waiting on 1s and 4s
    const tenpaiHand = tiles('2m 3m 4m 4p 5p 6p 7s 8s 9s 5p 5p 2s 3s');
    const waits = evaluator.getWinningTiles(tenpaiHand);
    const waitRanks = waits.map(t => `${t.rank}${t.suit[0]}`);
    assert.deepEqual(waitRanks, ['1s', '4s']);
  });

  it('should integrate with GameRoom to calculate real hand payments and reject invalid wins', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    const state = room.getState();
    state.phase = 'playing';

    // Give East a non-winning hand and try TSUMO_DECLARE -> should return error
    state.players[0].hand = tiles('1m 2m 4m 7m 1p 3p 5p 8p 1s 4s 7s east south white');
    const badRes = room.processEvent({
      type: 'TSUMO_DECLARE',
      player: 'east',
      tile: state.players[0].hand[13]
    });
    assert.equal(badRes.state.phase, 'playing');
    assert.ok(badRes.messages.some(m => m.type === 'error'));

    // Give East a real Tanyao + Pinfu + Tsumo + Iipeikou hand (4 han 20 fu -> 2600 all = 7800 total)
    state.players[0].hand = tiles('2m 3m 4m 2m 3m 4m 4p 5p 6p 5p 5p 6s 7s 8s');
    const goodRes = room.processEvent({
      type: 'TSUMO_DECLARE',
      player: 'east',
      tile: state.players[0].hand[13]
    });
    assert.equal(goodRes.state.phase, 'tsumo_declared');
    const paymentMsg = goodRes.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    const winPayment = paymentMsg.payments[0];
    assert.equal(winPayment.handEvaluation.fu, 20);
    assert.equal(winPayment.handEvaluation.han, 4);
    assert.equal(winPayment.scoreCalculation.dealerScore.tsumo, 2600);
    assert.equal(winPayment.payments.east, 7800);
  });

  it('should enforce Tenpai on RIICHI_DECLARE, set doubleRiichi/ippatsu, and forbid non-drawn discards after Riichi', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();

    // Non-tenpai hand -> RIICHI_DECLARE should fail
    state.players[0].hand = tiles('1m 4m 7m 1p 4p 7p 1s 4s 7s east south west north white');
    const badRiichi = room.processEvent({ type: 'RIICHI_DECLARE', player: 'east' });
    assert.ok(badRiichi.messages.some(m => m.type === 'error'));
    assert.equal(state.players[0].riichi.declared, false);

    // Tenpai hand on turn 1 with no calls -> RIICHI_DECLARE succeeds with doubleRiichi & ippatsu
    state.players[0].hand = tiles('1m 2m 3m 4p 5p 6p 7s 8s 9s white white red red 9m');
    const goodRiichi = room.processEvent({ type: 'RIICHI_DECLARE', player: 'east' });
    assert.ok(!goodRiichi.messages.some(m => m.type === 'error'));
    assert.equal(state.players[0].riichi.declared, true);
    assert.equal(state.players[0].riichi.doubleRiichi, true);
    assert.equal(state.players[0].riichi.ippatsu, true);

    // Discarding a tile that breaks tenpai (e.g. 1m) on declaration turn should be rejected
    const badDeclDiscard = room.processEvent({
      type: 'DISCARD',
      player: 'east',
      tile: state.players[0].hand[0] // 1m breaks tenpai
    });
    assert.ok(badDeclDiscard.messages.some(m => m.type === 'error'));

    // Discarding 9m keeps tenpai -> succeeds
    const goodDeclDiscard = room.processEvent({
      type: 'DISCARD',
      player: 'east',
      tile: state.players[0].hand[13] // 9m
    });
    assert.ok(!goodDeclDiscard.messages.some(m => m.type === 'error'));
    assert.equal(state.players[0].riichi.ippatsu, true);

    // On a subsequent turn for East, draw a tile and try to discard an old hand tile -> rejected!
    state.currentPlayer = 'east';
    room.processEvent({ type: 'DRAW_TILE', player: 'east' });
    const badPostRiichiDiscard = room.processEvent({
      type: 'DISCARD',
      player: 'east',
      tile: state.players[0].hand[0] // Not the drawn tile
    });
    assert.ok(badPostRiichiDiscard.messages.some(m => m.type === 'error'));

    // Discarding the drawn tile (last tile) succeeds and clears ippatsu
    const drawnTile = state.players[0].hand[state.players[0].hand.length - 1];
    const goodPostRiichiDiscard = room.processEvent({
      type: 'DISCARD',
      player: 'east',
      tile: drawnTile
    });
    assert.ok(!goodPostRiichiDiscard.messages.some(m => m.type === 'error'));
    assert.equal(state.players[0].riichi.ippatsu, false);
  });

  it('should reject RON_DECLARE when player is in Discard Furiten', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();

    // South is waiting on 1s and 4s (23s in hand with Tanyao), but South already discarded 1s!
    state.players[1].hand = tiles('2m 3m 4m 4p 5p 6p 6s 7s 8s 5p 5p 2s 3s');
    state.players[1].discards = tiles('1s');

    // East discards 4s
    const tile4s = tiles('4s')[0];
    state.players[0].hand[0] = tile4s;
    room.processEvent({ type: 'DISCARD', player: 'east', tile: tile4s });

    // South tries to Ron on 4s -> rejected due to Furiten (1s is in South's discards)
    const ronRes = room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: tile4s });
    assert.equal(ronRes.state.phase, 'playing');
    assert.ok(ronRes.messages.some(m => m.type === 'error' && m.error.includes('フリテン')));
  });

  it('should not draw Dora Indicator as Rinshan tile on KAN, and should award Rinshan Kaihou on win', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();

    const initialDora = state.doraIndicators[0];

    // Give East 4x 7s for Ankan
    state.players[0].hand = [
      ...tiles('7s 7s 7s 7s 2m 3m 4m 4p 5p 6p 5p 5p 2s'),
      tiles('3s')[0]
    ];
    // Replace the last tile of deadWall (rinshan) with 4s so East completes 234s on rinshan!
    const rinshanWinTile: TileInstance = { id: 'rinshan-4s', suit: 'sou', rank: 4 };
    state.deadWall[state.deadWall.length - 1] = rinshanWinTile;
    // Remove extra 14th tile before kan so after 4-tile kan + 1 rinshan East has 11 tiles (1 meld + 11 = 14)
    state.players[0].hand.pop();
    state.players[0].hand.push(tiles('3s')[0]);

    room.processEvent({ type: 'KAN', player: 'east', tile: state.players[0].hand[0] });
    const drawn = state.players[0].hand[state.players[0].hand.length - 1];
    assert.notEqual(drawn.id, initialDora.id, 'Rinshan tile must not be the dora indicator');
    assert.equal(drawn.id, rinshanWinTile.id);
    assert.equal(state.doraIndicators.length, 2);

    // Declare Tsumo -> should include 'rinshan' yaku!
    const tsumoRes = room.processEvent({ type: 'TSUMO_DECLARE', player: 'east', tile: rinshanWinTile });
    const paymentMsg = tsumoRes.messages.find(m => m.type === 'payment') as any;
    assert.ok(paymentMsg);
    const yakuList = paymentMsg.payments[0].handEvaluation.yaku.map((y: any) => y.type);
    assert.ok(yakuList.includes('rinshan'));
  });

  it('should rotate dealer and advance round on non-dealer win, and renchan (+honba) on dealer win', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const state = room.getState();

    // 1. Dealer (East) wins by Tsumo -> SCORING_COMPLETE -> ROUND_END -> stays East 1, honba = 1
    state.players[0].hand = tiles('2m 3m 4m 4p 5p 6p 6s 7s 8s 5p 5p 2s 3s 4s');
    room.processEvent({ type: 'TSUMO_DECLARE', player: 'east', tile: state.players[0].hand[13] });
    room.processEvent({ type: 'SCORING_COMPLETE' });
    room.processEvent({ type: 'ROUND_END' });

    assert.equal(state.round.wind, 'east');
    assert.equal(state.round.number, 1);
    assert.equal(state.honba, 1);
    assert.equal(state.players[0].isDealer, true);

    // 2. Next round: Non-dealer (South) wins by Ron -> SCORING_COMPLETE -> ROUND_END -> advances to East 2, honba = 0, South is dealer
    room.processEvent({ type: 'ROUND_START' });
    room.processEvent({ type: 'DEAL_COMPLETE' });
    const winTile = tiles('4s')[0];
    state.players[0].hand[0] = winTile;
    state.players[1].hand = tiles('2m 3m 4m 4p 5p 6p 6s 7s 8s 5p 5p 2s 3s');
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile });
    room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: winTile });
    // Directly send SCORING_COMPLETE from ron_declared (like modal '次へ' button)
    const scoreRes = room.processEvent({ type: 'SCORING_COMPLETE' });
    assert.equal(scoreRes.state.phase, 'round_end');
    room.processEvent({ type: 'ROUND_END' });

    assert.equal(state.round.wind, 'east');
    assert.equal(state.round.number, 2);
    assert.equal(state.honba, 0);
    assert.equal(state.players[0].isDealer, false);
    assert.equal(state.players[1].isDealer, true);
  });

  it('should support 1-3 human players with automatic NPC replenishment, turns, pausing on human call/Ron, and NPC Riichi/Win', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    // Only 1 human joins (East = human, South/West/North = initially unoccupied waiting for 1-min timeout)
    const seat = room.assignPlayer('solo-human');
    assert.equal(seat, 'east');
    assert.equal(room.getHumanCount(), 1);
    assert.equal(room.getOccupiedCount(), 1);

    const state = room.getState();
    assert.equal(state.players[0].isOccupied, true);
    assert.equal(state.players[0].isNpc, false);
    assert.equal(state.players[1].isOccupied, false);

    // Timeout triggers autoStartRound() -> fills 3 empty seats with NPCs and deals tiles
    room.autoStartRound();
    assert.equal(room.hasNpcPlayers(), true);
    assert.equal(state.players[0].isNpc, false);
    assert.equal(state.players[1].isNpc, true);
    assert.equal(state.players[2].isNpc, true);
    assert.equal(state.players[3].isNpc, true);
    assert.equal(state.phase, 'playing');

    // Give human (East) a simple hand with no calls for anyone on 9s
    state.players[0].hand = tiles('1m 4m 7m 1p 4p 7p 1s 4s 7s east south west north 9s');
    state.players[1].hand = tiles('1m 2m 4m 7m 1p 4p 7p 1s 4s 7s east south west');
    state.players[2].hand = tiles('1m 2m 4m 7m 1p 4p 7p 1s 4s 7s east south west');
    state.players[3].hand = tiles('1m 2m 4m 7m 1p 4p 7p 1s 4s 7s east south west');

    // Human (East) discards 9s
    room.processEvent({ type: 'DISCARD', player: 'east', tile: state.players[0].hand[13] });
    assert.equal(state.currentPlayer, 'south');

    // Run stepNpc() 7 times:
    // 1: South NPC draws, 2: South NPC discards
    // 3: West NPC draws,  4: West NPC discards
    // 5: North NPC draws, 6: North NPC discards
    // 7: East Human auto-draws back to 14 tiles!
    for (let i = 0; i < 7; i++) {
      const step = room.stepNpc();
      assert.equal(step.acted, true, `NPC step ${i + 1} should act`);
    }
    assert.equal(state.currentPlayer, 'east');
    assert.equal(state.players[0].hand.length, 14, 'Human player should have 14 tiles ready to discard after NPC round');

    // Test pause when human has a Pon option on NPC discard, and resume after markPlayerPassedCall
    state.players[0].hand = tiles('5p 5p 1m 4m 7m 1p 4p 7p 1s 4s 7s east south');
    const tile5p: TileInstance = { id: 'npc-5p', suit: 'pin', rank: 5 };
    state.players[1].discards.push(tile5p);
    state.lastDiscard = tile5p;
    state.currentPlayer = 'west';

    const pausedStep = room.stepNpc();
    assert.equal(pausedStep.acted, false, 'NPC must pause when human has a Pon option on lastDiscard');

    room.markPlayerPassedCall('solo-human');
    const resumedStep = room.stepNpc();
    assert.equal(resumedStep.acted, true, 'NPC should resume immediately after human passes call');
  });

  it('should end the game after East 4 in Tonpuusen (east) and advance to South 1 -> end after South 4 in Tonnansen (south)', () => {
    // 1. 東風戦 (gameLength = 'east'): 東4局で子が和了すると game_end になる
    const eastRoom = new GameRoom(getDefaultRuleConfigPath());
    eastRoom.setGameLength('east');
    const eState = eastRoom.getState();
    eState.round = { wind: 'east', number: 4 };
    eState.players.forEach(p => { p.isDealer = p.seat === 'north'; });
    eastRoom.autoStartRound();

    // 東4局で親(north)がツモ和了 → 連荘でまだ終わらない (東4局 1本場)
    eState.players[3].hand = tiles('2m 3m 4m 4p 5p 6p 6s 7s 8s 5p 5p 2s 3s 4s');
    eastRoom.processEvent({ type: 'TSUMO_DECLARE', player: 'north', tile: eState.players[3].hand[13] });
    eastRoom.processEvent({ type: 'SCORING_COMPLETE' });
    eastRoom.processEvent({ type: 'ROUND_END' });
    assert.equal(eState.phase, 'waiting');
    assert.equal(eState.round.wind, 'east');
    assert.equal(eState.round.number, 4);
    assert.equal(eState.honba, 1);

    // 東4局 1本場で子(east)がツモ和了して30,000点以上に到達 → 親流れで東風戦終了 (game_end)
    eastRoom.autoStartRound();
    eState.players[0].score = 28000;
    eState.players[0].hand = tiles('2m 3m 4m 2m 3m 4m 4p 5p 6p 5p 5p 6s 7s 8s');
    eastRoom.processEvent({ type: 'TSUMO_DECLARE', player: 'east', tile: eState.players[0].hand[13] });
    eastRoom.processEvent({ type: 'SCORING_COMPLETE' });
    eastRoom.processEvent({ type: 'ROUND_END' });
    assert.equal(eState.phase, 'game_end', 'Tonpuusen must end (game_end) after East 4 dealer rotates when top >= 30,000');

    // 2. 東南戦 (gameLength = 'south'): 東4局終了時は(30,000点以上でも)南1局へ進み、南4局終了時に30,000点以上がいれば game_end になる
    const southRoom = new GameRoom(getDefaultRuleConfigPath());
    southRoom.setGameLength('south');
    const sState = southRoom.getState();
    sState.round = { wind: 'east', number: 4 };
    sState.players.forEach(p => { p.isDealer = p.seat === 'north'; });
    southRoom.autoStartRound();

    sState.players[0].score = 28000;
    sState.players[0].hand = tiles('2m 3m 4m 2m 3m 4m 4p 5p 6p 5p 5p 6s 7s 8s');
    southRoom.processEvent({ type: 'TSUMO_DECLARE', player: 'east', tile: sState.players[0].hand[13] });
    southRoom.processEvent({ type: 'SCORING_COMPLETE' });
    southRoom.processEvent({ type: 'ROUND_END' });
    assert.equal(sState.phase, 'waiting');
    assert.equal(sState.round.wind, 'south');
    assert.equal(sState.round.number, 1);

    // 南4局で子が和了 (30,000点以上到達済み) → 東南戦終了 (game_end)
    sState.round = { wind: 'south', number: 4 };
    sState.players.forEach(p => { p.isDealer = p.seat === 'north'; });
    southRoom.autoStartRound();
    sState.players[0].hand = tiles('2m 3m 4m 2m 3m 4m 4p 5p 6p 5p 5p 6s 7s 8s');
    southRoom.processEvent({ type: 'TSUMO_DECLARE', player: 'east', tile: sState.players[0].hand[13] });
    southRoom.processEvent({ type: 'SCORING_COMPLETE' });
    southRoom.processEvent({ type: 'ROUND_END' });
    assert.equal(sState.phase, 'game_end', 'Tonnansen must end (game_end) after South 4 dealer rotates when top >= 30,000');
  });

  it('should enter West round (西入 / Shaa-nyuu) when all players are under 30,000 pts after South 4, and end by sudden death once anyone reaches 30,000+', () => {
    const room = new GameRoom(getDefaultRuleConfigPath());
    room.setGameLength('south');
    const state = room.getState();

    // Set up South 4 (dealer = north) with all players around 25,000 (< 30,000)
    state.round = { wind: 'south', number: 4 };
    state.players[0].score = 26000; // east
    state.players[1].score = 25000; // south
    state.players[2].score = 25000; // west
    state.players[3].score = 24000; // north (dealer)
    state.players.forEach(p => { p.isDealer = p.seat === 'north'; });
    room.autoStartRound();

    // Ensure no dora matches so South wins a 1-han 30-fu Pinfu Ron (1,000 pts) from North:
    // South: 25,000 + 1,000 = 26,000 (< 30,000). Top is East (26,000) & South (26,000) -> NOBODY has >= 30,000!
    state.doraIndicators = tiles('white');
    const winTile6m = tiles('6m')[0];
    state.players[3].hand[0] = winTile6m;
    state.players[1].hand = tiles('1m 2m 3m 4p 5p 6p 7s 8s 9s 2p 2p 4m 5m');
    room.processEvent({ type: 'DISCARD', player: 'north', tile: winTile6m });
    room.processEvent({ type: 'RON_DECLARE', player: 'south', tile: winTile6m });
    room.processEvent({ type: 'SCORING_COMPLETE' });
    room.processEvent({ type: 'ROUND_END' });

    // Because all 4 players are < 30,000 pts (max = 26,000), the game MUST enter West 1 (西1局)!
    assert.equal(state.phase, 'waiting', 'Should NOT end game when all players are < 30,000 pts');
    assert.equal(state.round.wind, 'west', 'Must enter West round (西入)');
    assert.equal(state.round.number, 1, 'Must be West 1 (西1局)');
    assert.equal(state.players[0].isDealer, true, 'East becomes dealer in West 1');

    // In West 1: West wins a 1,000 pt Pinfu Ron from East -> West: 25,000 + 1,000 = 26,000 (still all < 30,000!)
    room.autoStartRound();
    state.doraIndicators = tiles('white');
    state.players[0].hand[0] = winTile6m;
    state.players[2].hand = tiles('1m 2m 3m 4p 5p 6p 7s 8s 9s 2p 2p 4m 5m');
    room.processEvent({ type: 'DISCARD', player: 'east', tile: winTile6m });
    room.processEvent({ type: 'RON_DECLARE', player: 'west', tile: winTile6m });
    room.processEvent({ type: 'SCORING_COMPLETE' });
    room.processEvent({ type: 'ROUND_END' });

    // Still nobody >= 30,000 -> advances to West 2 (西2局)!
    assert.equal(state.phase, 'waiting');
    assert.equal(state.round.wind, 'west');
    assert.equal(state.round.number, 2, 'Should advance to West 2 while everyone is still < 30,000');
    assert.equal(state.players[1].isDealer, true, 'South is dealer in West 2');

    // In West 2: South (dealer, 26,000 pts) wins a Tsumo hand (+7,800 pts -> 33,800 pts >= 30,000)!
    // Even though the dealer won, in sudden-death West round reaching >= 30,000 immediately ends the game!
    room.autoStartRound();
    state.players[1].hand = tiles('2m 3m 4m 2m 3m 4m 4p 5p 6p 5p 5p 6s 7s 8s');
    room.processEvent({ type: 'TSUMO_DECLARE', player: 'south', tile: state.players[1].hand[13] });
    room.processEvent({ type: 'SCORING_COMPLETE' });
    room.processEvent({ type: 'ROUND_END' });

    assert.ok(state.players[1].score >= 30000, 'South reached 30,000+ points');
    assert.equal(state.phase, 'game_end', 'Sudden-death West round must end as soon as a player reaches 30,000+ pts');
  });
});
