import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { TileInstance } from '../../src/types/tiles.js';

declare const window: any;

/**
 * 4-Player Playwright Automated UI Test Suite
 * 
 * Verifies (Using 100% pure game engine logic & Deterministic Wall Injection):
 * 1. 4 players (East, South, West, North) connecting concurrently to the same room.
 * 2. Complete flow: ROUND_START -> DEAL_COMPLETE -> Deal 13/14 tiles -> playing phase.
 * 3. チー (Chi): Pre-arranged wall -> East discards 1m -> South calls Chi -> meld formed -> discard.
 * 4. ポン (Pon): Pre-arranged wall -> East discards 5p -> South calls Pon -> meld formed -> discard.
 * 5. 暗槓 (Ankan): Pre-arranged wall -> East has 4x 7s -> calls Ankan -> rinshan drawn -> new dora -> discard.
 * 6. 明槓 (Minkan / 大明槓): Pre-arranged wall -> East discards 9p -> South calls Minkan -> meld formed -> discard.
 * 7. 立直 (Riichi): Pre-arranged wall -> East tenpai -> calls Riichi -> 1000 pt deduction -> sideways discard.
 * 8. ツモ (Tsumo): Pre-arranged wall -> East winning hand -> calls Tsumo -> payment calculation & modal display.
 * 9. ロン (Ron): Pre-arranged wall -> East discards 4m -> South calls Ron -> payment calculation & modal display.
 * 10. 流局 (Exhaustive Draw): Pre-arranged short wall -> discard exhausts wall -> round_end -> reset to waiting.
 */

// ============================================================
// 牌山生成ヘルパー (Deterministic Wall Generator)
// ============================================================

function createDummyTiles(count: number, prefix: string, suit: 'man' | 'pin' | 'sou'): TileInstance[] {
  const res: TileInstance[] = [];
  for (let i = 0; i < count; i++) {
    res.push({
      id: `${prefix}-${suit}-${i}`,
      suit,
      rank: (i % 9) + 1
    });
  }
  return res;
}

function createStackedWall(config: {
  east: TileInstance[];      // 14 tiles
  south: TileInstance[];     // 13 tiles
  west?: TileInstance[];     // 13 tiles
  north?: TileInstance[];    // 13 tiles
  draws?: TileInstance[];    // tiles to draw
  deadWall?: TileInstance[]; // 14 tiles
  totalTiles?: number;       // total wall length (default: 136)
}): TileInstance[] {
  const east = [...config.east];
  const south = [...config.south];
  const west = config.west ? [...config.west] : createDummyTiles(13, 'w', 'pin');
  const north = config.north ? [...config.north] : createDummyTiles(13, 'n', 'sou');
  const deadWall = config.deadWall ? [...config.deadWall] : createDummyTiles(14, 'dw', 'sou');

  assert.equal(east.length, 14, 'East must have 14 tiles');
  assert.equal(south.length, 13, 'South must have 13 tiles');
  assert.equal(west.length, 13, 'West must have 13 tiles');
  assert.equal(north.length, 13, 'North must have 13 tiles');
  assert.equal(deadWall.length, 14, 'Dead wall must have 14 tiles');

  const dealtTiles: TileInstance[] = [];

  // Round 0 (4 each)
  dealtTiles.push(...east.splice(0, 4));
  dealtTiles.push(...south.splice(0, 4));
  dealtTiles.push(...west.splice(0, 4));
  dealtTiles.push(...north.splice(0, 4));

  // Round 1 (4 each)
  dealtTiles.push(...east.splice(0, 4));
  dealtTiles.push(...south.splice(0, 4));
  dealtTiles.push(...west.splice(0, 4));
  dealtTiles.push(...north.splice(0, 4));

  // Round 2 (4 each)
  dealtTiles.push(...east.splice(0, 4));
  dealtTiles.push(...south.splice(0, 4));
  dealtTiles.push(...west.splice(0, 4));
  dealtTiles.push(...north.splice(0, 4));

  // Round 3 (1 each)
  dealtTiles.push(...east.splice(0, 1));
  dealtTiles.push(...south.splice(0, 1));
  dealtTiles.push(...west.splice(0, 1));
  dealtTiles.push(...north.splice(0, 1));

  // Dealer extra tile (1)
  dealtTiles.push(...east.splice(0, 1));

  assert.equal(dealtTiles.length, 53, 'Dealt tiles must be 53');

  const draws = config.draws ? [...config.draws] : [];
  const total = config.totalTiles ?? 136;
  const paddingCount = Math.max(0, total - 14 - 53 - draws.length);
  const padding = createDummyTiles(paddingCount, 'pad', 'man');

  return [...dealtTiles, ...draws, ...padding, ...deadWall];
}

async function setupScenarioRound(p1: any, wall: TileInstance[]) {
  // 牌山をサーバーの部屋に注入（4席着席済みのため自動で局開始・配牌完了まで遷移）
  await p1.evaluate((w: any) => (window as any).sendMsg({ type: 'set_wall', wall: w }), wall);
  await p1.waitForTimeout(600);
}

async function discardAnyTile(page: any) {
  const drawnTile = page.locator('#drawn-bottom .tenhou-tile');
  if (await drawnTile.count() > 0) {
    await drawnTile.first().click();
  } else {
    await page.locator('#hand-bottom .tenhou-tile:last-child').click();
  }
}

// ============================================================
// メインテスト実行関数
// ============================================================

async function runFourPlayerTests() {
  console.log('============================================================');
  console.log('Starting 4-Player Playwright UI Automated Tests...');
  console.log('(Pure Engine Logic with Deterministic Wall Injection)');
  console.log('============================================================\n');

  const browser = await chromium.launch({ headless: true });
  const baseURL = 'http://localhost:3000';
  const roomId = `e2e-${Date.now()}`;

  try {
    // 1. 4プレイヤーのブラウザコンテキスト・ページを生成
    console.log('[Step 1] Creating 4 browser contexts for players...');
    const ctx1 = await browser.newContext({ viewport: { width: 1200, height: 750 } });
    const ctx2 = await browser.newContext({ viewport: { width: 1200, height: 750 } });
    const ctx3 = await browser.newContext({ viewport: { width: 1200, height: 750 } });
    const ctx4 = await browser.newContext({ viewport: { width: 1200, height: 750 } });

    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();
    const p3 = await ctx3.newPage();
    const p4 = await ctx4.newPage();

    const players = [
      { page: p1, id: 'player1', name: '東家 (p1)' },
      { page: p2, id: 'player2', name: '南家 (p2)' },
      { page: p3, id: 'player3', name: '西家 (p3)' },
      { page: p4, id: 'player4', name: '北家 (p4)' }
    ];

    // 2. 4プレイヤーが同時に入室
    console.log('[Step 2] Connecting all 4 players to room:', roomId);
    for (const pl of players) {
      await pl.page.goto(baseURL);
      await pl.page.fill('#room-id', roomId);
      await pl.page.fill('#player-id', pl.id);
      await pl.page.click('#connect-btn');
      await pl.page.waitForSelector('#game-screen.active', { timeout: 5000 });
      console.log(`  ✓ ${pl.name} successfully joined room ${roomId}`);
    }

    await p1.waitForTimeout(600);

    // 3. 4人入室完了時点で自動的に局開始・配牌完了（playing フェーズ）になっていることを検証
    console.log('\n[Step 3] Testing automatic round start upon 4 players gathering...');
    await p1.waitForTimeout(600);
    const p1HandCount = await p1.locator('#hand-bottom .tenhou-tile').count();
    const p1DrawnCount = await p1.locator('#drawn-bottom .tenhou-tile').count();
    assert.equal(p1HandCount, 13, 'East should automatically have 13 hand tiles upon 4th player join');
    assert.equal(p1DrawnCount, 1, 'East should automatically have 1 drawn tile upon 4th player join');
    console.log(`  ✓ Round auto-started when 4th player joined: East has 13 hand tiles + 1 drawn tile (total 14)`);

    const p2HandCount = await p2.locator('#hand-bottom .tenhou-tile').count();
    assert.equal(p2HandCount, 13, 'South should have 13 hand tiles');
    console.log(`  ✓ South hand verified: 13 hand tiles`);

    // 4. チー (Chi) の検証 (東家が1m打牌、南家が2m・3m所持)
    console.log('\n[Step 4] Testing チー (Chi) via injected wall...');
    const chiWall = createStackedWall({
      east: [
        { id: 'chi-1m', suit: 'man', rank: 1 },
        ...createDummyTiles(13, 'e-sou', 'sou')
      ],
      south: [
        { id: 'chi-2m', suit: 'man', rank: 2 },
        { id: 'chi-3m', suit: 'man', rank: 3 },
        ...createDummyTiles(11, 's-pin', 'pin')
      ]
    });
    await setupScenarioRound(p1, chiWall);

    // 東家が 1m を打牌
    const tile1m = p1.locator('#player-area-bottom [data-tile-id="chi-1m"]');
    await tile1m.waitFor({ state: 'visible', timeout: 5000 });
    await tile1m.click();
    await p2.waitForTimeout(600);

    // 南家に「チー」ボタンが出現
    const chiBtn = p2.locator('.btn-th-act:has-text("チー")');
    await chiBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✓ "チー" button appeared on South UI');
    await chiBtn.click();
    await p2.waitForTimeout(600);

    // 南家の副露スロットにチー面子（3枚）が存在することを検証
    const p2Melds = await p2.locator('#melds-bottom .meld-group').count();
    assert.ok(p2Melds >= 1, 'South should have at least 1 meld after Chi');
    const p2MeldTiles = await p2.locator('#melds-bottom .meld-group:last-child .tenhou-tile').count();
    assert.equal(p2MeldTiles, 3, 'Chi meld should contain 3 tiles');
    console.log('  ✓ South Chi meld verified in UI (3 tiles formed)');

    // 南家が打牌して手牌が10枚になることを検証
    await discardAnyTile(p2);
    await p2.waitForTimeout(600);
    const p2PostDiscardHand = await p2.locator('#hand-bottom .tenhou-tile').count() + await p2.locator('#drawn-bottom .tenhou-tile').count();
    assert.equal(p2PostDiscardHand, 10, 'South hand should be 10 tiles after chi + discard');
    console.log('  ✓ South successfully discarded after Chi (hand size: 10)');

    // 5. ポン (Pon) の検証 (東家が5p打牌、南家が5p×2枚所持)
    console.log('\n[Step 5] Testing ポン (Pon) via injected wall...');
    const ponWall = createStackedWall({
      east: [
        { id: 'pon-5p-e', suit: 'pin', rank: 5 },
        ...createDummyTiles(13, 'e-sou', 'sou')
      ],
      south: [
        { id: 'pon-5p-s1', suit: 'pin', rank: 5 },
        { id: 'pon-5p-s2', suit: 'pin', rank: 5 },
        ...createDummyTiles(11, 's-man', 'man')
      ]
    });
    await setupScenarioRound(p1, ponWall);

    // 東家が 5p を打牌
    const tile5p = p1.locator('#player-area-bottom [data-tile-id="pon-5p-e"]');
    await tile5p.waitFor({ state: 'visible', timeout: 5000 });
    await tile5p.click();
    await p2.waitForTimeout(600);

    // 南家に「ポン」ボタンが出現
    const ponBtn = p2.locator('.btn-th-act:has-text("ポン")');
    await ponBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✓ "ポン" button appeared on South UI');
    await ponBtn.click();
    await p2.waitForTimeout(600);

    const p2PonTiles = await p2.locator('#melds-bottom .meld-group:last-child .tenhou-tile').count();
    assert.equal(p2PonTiles, 3, 'Pon meld should contain 3 tiles');
    console.log('  ✓ South Pon meld verified in UI (3 tiles formed)');

    // ポン後の打牌
    await discardAnyTile(p2);
    await p2.waitForTimeout(600);
    console.log('  ✓ South successfully discarded after Pon');

    // 6. 暗槓 (Ankan) の検証 (東家が7s×4枚所持)
    console.log('\n[Step 6] Testing 暗槓 (Ankan) via injected wall...');
    const ankanWall = createStackedWall({
      east: [
        { id: 'ankan-7s-1', suit: 'sou', rank: 7 },
        { id: 'ankan-7s-2', suit: 'sou', rank: 7 },
        { id: 'ankan-7s-3', suit: 'sou', rank: 7 },
        { id: 'ankan-7s-4', suit: 'sou', rank: 7 },
        ...createDummyTiles(10, 'e-man', 'man')
      ],
      south: createDummyTiles(13, 's-pin', 'pin')
    });
    await setupScenarioRound(p1, ankanWall);

    const initialDoraCount = await p1.locator('#dora-indicators .tenhou-tile').count();
    const ankanBtn = p1.locator('.btn-th-act:has-text("暗槓")');
    await ankanBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✓ "暗槓" button appeared on East UI');
    await ankanBtn.click();
    await p1.waitForTimeout(600);

    // 暗槓面子 (4枚) & 新カンドラ開示の検証
    const p1AnkanTiles = await p1.locator('#melds-bottom .meld-group:last-child .tenhou-tile').count();
    assert.equal(p1AnkanTiles, 4, 'Ankan meld should contain 4 tiles');
    const newDoraCount = await p1.locator('#dora-indicators .tenhou-tile').count();
    assert.ok(newDoraCount >= initialDoraCount + 1, 'New dora indicator should be revealed after kan');
    console.log(`  ✓ East Ankan meld verified (4 tiles, dora count: ${newDoraCount})`);

    // 嶺上牌ツモ後の打牌
    await discardAnyTile(p1);
    await p1.waitForTimeout(600);
    console.log('  ✓ East successfully discarded rinshan tile');

    // 7. 明槓 (Minkan / 大明槓) の検証 (東家が9p打牌、南家が9p×3枚所持)
    console.log('\n[Step 7] Testing 明槓 (Minkan / 大明槓) via injected wall...');
    const minkanWall = createStackedWall({
      east: [
        { id: 'kan-9p-e', suit: 'pin', rank: 9 },
        ...createDummyTiles(13, 'e-sou', 'sou')
      ],
      south: [
        { id: 'kan-9p-s1', suit: 'pin', rank: 9 },
        { id: 'kan-9p-s2', suit: 'pin', rank: 9 },
        { id: 'kan-9p-s3', suit: 'pin', rank: 9 },
        ...createDummyTiles(10, 's-man', 'man')
      ]
    });
    await setupScenarioRound(p1, minkanWall);

    const tile9p = p1.locator('#player-area-bottom [data-tile-id="kan-9p-e"]');
    await tile9p.waitFor({ state: 'visible', timeout: 5000 });
    await tile9p.click();
    await p2.waitForTimeout(600);

    const daiminkanBtn = p2.locator('.btn-th-act:has-text("カン")');
    await daiminkanBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✓ "カン (大明槓)" button appeared on South UI');
    await daiminkanBtn.click();
    await p2.waitForTimeout(600);

    const p2KanTiles = await p2.locator('#melds-bottom .meld-group:last-child .tenhou-tile').count();
    assert.equal(p2KanTiles, 4, 'Daiminkan meld should contain 4 tiles');
    console.log('  ✓ South Daiminkan meld verified (4 tiles)');

    await discardAnyTile(p2);
    await p2.waitForTimeout(600);
    console.log('  ✓ South successfully discarded rinshan tile');

    // 8. リーチ (Riichi) の検証 (東家が門前聴牌14枚)
    console.log('\n[Step 8] Testing 立直 (Riichi) via injected wall...');
    const riichiWall = createStackedWall({
      east: [
        { id: 'r-1m', suit: 'man', rank: 1 },
        { id: 'r-2m', suit: 'man', rank: 2 },
        { id: 'r-3m', suit: 'man', rank: 3 },
        { id: 'r-4p', suit: 'pin', rank: 4 },
        { id: 'r-5p', suit: 'pin', rank: 5 },
        { id: 'r-6p', suit: 'pin', rank: 6 },
        { id: 'r-7s', suit: 'sou', rank: 7 },
        { id: 'r-8s', suit: 'sou', rank: 8 },
        { id: 'r-9s', suit: 'sou', rank: 9 },
        { id: 'r-wh1', suit: 'honor', honorType: 'white' },
        { id: 'r-wh2', suit: 'honor', honorType: 'white' },
        { id: 'r-ch1', suit: 'honor', honorType: 'red' },
        { id: 'r-ch2', suit: 'honor', honorType: 'red' },
        { id: 'r-extra-1s', suit: 'sou', rank: 1 }
      ],
      south: createDummyTiles(13, 's-pin', 'pin')
    });
    await setupScenarioRound(p1, riichiWall);

    const riichiBtn = p1.locator('.btn-th-act:has-text("立直")');
    await riichiBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✓ "立直" button appeared on East UI');
    await riichiBtn.click();
    await p1.waitForTimeout(600);

    const eastScoreText = await p1.locator('#player-score-bottom').textContent();
    assert.equal(eastScoreText?.trim(), '24,000', 'East score should decrease by 1,000 to 24,000');
    const riichiStickCount = await p1.locator('#riichi-slot-bottom .tenhou-riichi-stick').count();
    assert.equal(riichiStickCount, 1, 'Riichi stick should appear in East slot');
    console.log('  ✓ Score decreased to 24,000 and 1,000pt riichi stick placed on table');

    // リーチ宣言牌を打牌
    const tileExtra = p1.locator('#player-area-bottom [data-tile-id="r-extra-1s"]');
    await tileExtra.click();
    await p1.waitForTimeout(600);

    const latestDiscard = p1.locator('#discards-bottom .tenhou-tile:last-child');
    const hasHorizontalClass = await latestDiscard.evaluate(el => el.classList.contains('tile-horizontal'));
    assert.ok(hasHorizontalClass, 'Riichi declaration tile in kawa should have tile-horizontal class');
    console.log('  ✓ Riichi declaration tile in kawa is rendered sideways (tile-horizontal)');

    // 9. ツモ (Tsumo) の検証 (東家が和了配牌14枚所持)
    console.log('\n[Step 9] Testing ツモ (Tsumo) via injected wall...');
    const tsumoWall = createStackedWall({
      east: [
        { id: 'ts-2m', suit: 'man', rank: 2 },
        { id: 'ts-3m', suit: 'man', rank: 3 },
        { id: 'ts-4m', suit: 'man', rank: 4 },
        { id: 'ts-4p', suit: 'pin', rank: 4 },
        { id: 'ts-5p', suit: 'pin', rank: 5 },
        { id: 'ts-6p', suit: 'pin', rank: 6 },
        { id: 'ts-7s', suit: 'sou', rank: 7 },
        { id: 'ts-8s', suit: 'sou', rank: 8 },
        { id: 'ts-9s', suit: 'sou', rank: 9 },
        { id: 'ts-wh1', suit: 'honor', honorType: 'white' },
        { id: 'ts-wh2', suit: 'honor', honorType: 'white' },
        { id: 'ts-ch1', suit: 'honor', honorType: 'red' },
        { id: 'ts-ch2', suit: 'honor', honorType: 'red' },
        { id: 'ts-ch3', suit: 'honor', honorType: 'red' }
      ],
      south: createDummyTiles(13, 's-pin', 'pin')
    });
    await setupScenarioRound(p1, tsumoWall);

    const tsumoBtn = p1.locator('.btn-th-act.act-tsumo:text-is("ツモ")');
    await tsumoBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✓ "ツモ" button appeared on East UI');
    await tsumoBtn.click();
    await p1.waitForTimeout(800);

    const resultModal1 = p1.locator('#result-modal');
    const isModalVisible1 = await resultModal1.evaluate(el => !el.classList.contains('hidden'));
    assert.ok(isModalVisible1, 'Result modal should be displayed on Tsumo');
    const winnerTitle1 = await p1.locator('#result-winner-title').textContent();
    assert.ok(winnerTitle1?.includes('東家'), 'Winner title should state 東家');
    const winTag1 = await p1.locator('#result-type-tag').textContent();
    assert.ok(winTag1?.includes('ツモ'), 'Win type tag should state ツモ');
    console.log(`  ✓ Tsumo result modal displayed: "${winnerTitle1}" (${winTag1})`);

    // モーダルを閉じる
    for (const pl of players) {
      const closeBtn = pl.page.locator('#result-close');
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      }
    }
    await p1.waitForTimeout(600);

    // 10. ロン (Ron) の検証 (南家が4m待ち聴牌、東家が4m打牌)
    console.log('\n[Step 10] Testing ロン (Ron) via injected wall...');
    const ronWall = createStackedWall({
      east: [
        { id: 'target-4m', suit: 'man', rank: 4 },
        ...createDummyTiles(13, 'e-sou', 'sou')
      ],
      south: [
        { id: 'ron-2m', suit: 'man', rank: 2 },
        { id: 'ron-3m', suit: 'man', rank: 3 },
        { id: 'ron-4p', suit: 'pin', rank: 4 },
        { id: 'ron-5p', suit: 'pin', rank: 5 },
        { id: 'ron-6p', suit: 'pin', rank: 6 },
        { id: 'ron-7s', suit: 'sou', rank: 7 },
        { id: 'ron-8s', suit: 'sou', rank: 8 },
        { id: 'ron-9s', suit: 'sou', rank: 9 },
        { id: 'ron-wh1', suit: 'honor', honorType: 'white' },
        { id: 'ron-wh2', suit: 'honor', honorType: 'white' },
        { id: 'ron-ch1', suit: 'honor', honorType: 'red' },
        { id: 'ron-ch2', suit: 'honor', honorType: 'red' },
        { id: 'ron-ch3', suit: 'honor', honorType: 'red' }
      ]
    });
    await setupScenarioRound(p1, ronWall);

    const tile4m = p1.locator('#player-area-bottom [data-tile-id="target-4m"]');
    await tile4m.waitFor({ state: 'visible', timeout: 5000 });
    await tile4m.click();
    await p2.waitForTimeout(600);

    const ronBtn = p2.locator('.btn-th-act.act-ron:text-is("ロン")');
    await ronBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✓ "ロン" button appeared on South UI');
    await ronBtn.click();
    await p2.waitForTimeout(800);

    const resultModal2 = p2.locator('#result-modal');
    const isModalVisible2 = await resultModal2.evaluate(el => !el.classList.contains('hidden'));
    assert.ok(isModalVisible2, 'Result modal should be displayed on Ron');
    const winnerTitle2 = await p2.locator('#result-winner-title').textContent();
    assert.ok(winnerTitle2?.includes('南家'), 'Winner title should state 南家');
    const winTag2 = await p2.locator('#result-type-tag').textContent();
    assert.ok(winTag2?.includes('ロン'), 'Win type tag should state ロン');
    console.log(`  ✓ Ron result modal displayed: "${winnerTitle2}" (${winTag2})`);

    // モーダルを閉じる
    for (const pl of players) {
      const closeBtn = pl.page.locator('#result-close');
      if (await closeBtn.isVisible()) {
        await closeBtn.click();
      }
    }
    await p2.waitForTimeout(600);

    // 11. 流局 (Exhaustive Draw) & 局終了・次局遷移の検証 (山牌残数0での打牌)
    console.log('\n[Step 11] Testing 流局 (Exhaustive Draw) via wall exhaustion...');
    const drawWall = createStackedWall({
      east: createDummyTiles(14, 'e-man', 'man'),
      south: createDummyTiles(13, 's-pin', 'pin'),
      west: createDummyTiles(13, 'w-sou', 'sou'),
      north: createDummyTiles(13, 'n-sou', 'sou'),
      totalTiles: 67 // 53 配牌 + 14 王牌 = 67枚 (配牌完了時点で山牌残り0枚)
    });
    await setupScenarioRound(p1, drawWall);

    // 東家が打牌（山牌が尽きているため即時流局判定）
    await discardAnyTile(p1);
    await p1.waitForTimeout(600);

    // 局終了へボタン
    const endRoundBtn = p1.locator('.btn-th-act:has-text("局終了へ")');
    await endRoundBtn.waitFor({ state: 'visible', timeout: 5000 });
    await endRoundBtn.click();
    await p1.waitForTimeout(600);

    // 次局へボタンをクリックすると、手動の「局開始」ボタンなしで自動的に次局の配牌・対局(playing)が始まることを検証
    const nextRoundBtn = p1.locator('.btn-th-act:has-text("次局へ")');
    await nextRoundBtn.waitFor({ state: 'visible', timeout: 5000 });
    await nextRoundBtn.click();
    await p1.waitForTimeout(600);

    const nextPhase = await p1.evaluate(() => (window as any).App.gameState.phase);
    assert.equal(nextPhase, 'playing', 'Next round should automatically start and enter playing phase');
    console.log('  ✓ Round successfully completed and next round automatically started');

    // 12. 非聴牌・非和了時の不要ボタン非表示 & 他家手牌マスク検証
    console.log('\n[Step 12] Testing button visibility on non-tenpai/non-winning hand & hand masking...');
    const nonTenpaiWall = createStackedWall({
      east: [
        { id: 'nt-1m', suit: 'man', rank: 1 },
        { id: 'nt-4m', suit: 'man', rank: 4 },
        { id: 'nt-7m', suit: 'man', rank: 7 },
        { id: 'nt-1p', suit: 'pin', rank: 1 },
        { id: 'nt-4p', suit: 'pin', rank: 4 },
        { id: 'nt-7p', suit: 'pin', rank: 7 },
        { id: 'nt-1s', suit: 'sou', rank: 1 },
        { id: 'nt-4s', suit: 'sou', rank: 4 },
        { id: 'nt-7s', suit: 'sou', rank: 7 },
        { id: 'nt-e', suit: 'honor', honorType: 'east' },
        { id: 'nt-s', suit: 'honor', honorType: 'south' },
        { id: 'nt-w', suit: 'honor', honorType: 'west' },
        { id: 'nt-n', suit: 'honor', honorType: 'north' },
        { id: 'nt-wh', suit: 'honor', honorType: 'white' }
      ],
      south: [
        { id: 'nts-1m', suit: 'man', rank: 1 },
        { id: 'nts-4m', suit: 'man', rank: 4 },
        { id: 'nts-7m', suit: 'man', rank: 7 },
        { id: 'nts-1p', suit: 'pin', rank: 1 },
        { id: 'nts-4p', suit: 'pin', rank: 4 },
        { id: 'nts-7p', suit: 'pin', rank: 7 },
        { id: 'nts-1s', suit: 'sou', rank: 1 },
        { id: 'nts-4s', suit: 'sou', rank: 4 },
        { id: 'nts-7s', suit: 'sou', rank: 7 },
        { id: 'nts-e', suit: 'honor', honorType: 'east' },
        { id: 'nts-s', suit: 'honor', honorType: 'south' },
        { id: 'nts-w', suit: 'honor', honorType: 'west' },
        { id: 'nts-n', suit: 'honor', honorType: 'north' }
      ]
    });
    await setupScenarioRound(p1, nonTenpaiWall);

    const p1BtnsNonTenpai = await p1.locator('#action-buttons button').allTextContents();
    assert.ok(!p1BtnsNonTenpai.includes('立直'), 'Riichi button must NOT appear on non-tenpai hand');
    assert.ok(!p1BtnsNonTenpai.includes('ツモ'), 'Tsumo win button must NOT appear on non-winning hand');
    console.log('  ✓ Riichi and Tsumo buttons hidden on non-tenpai/non-winning hand');

    // WebSocket上で他家の手牌がマスクされていることを検証
    const p2HandSeenByP1 = await p1.evaluate(() => {
      const st = (window as any).App.gameState;
      const south = st.players.find((p: any) => p.seat === 'south');
      return south.hand.map((t: any) => t.id);
    });
    assert.ok(p2HandSeenByP1.every((id: string) => id.startsWith('hand-hidden-')), 'Other players hands must be masked during active play');
    console.log('  ✓ Other players hand contents are masked over WebSocket during active play');

    // 東家が打牌した際、ロンできない南家・西家・北家に「ロン」ボタンが出ないことを検証
    await discardAnyTile(p1);
    await p2.waitForTimeout(400);
    const p2BtnsAfterDiscard = await p2.locator('#action-buttons button').allTextContents();
    assert.ok(!p2BtnsAfterDiscard.includes('ロン'), 'Ron button must NOT appear when player cannot win');
    console.log('  ✓ Ron button hidden when player cannot win on discard');

    // 13. 複数通りの「チー」選択肢表示 & 「パス」による即時ツモ進行の検証
    console.log('\n[Step 13] Testing multiple Chi options and Pass button progression...');
    const multiChiWall = createStackedWall({
      east: [
        { id: 'mc-4m', suit: 'man', rank: 4 },
        ...createDummyTiles(13, 'e-sou', 'sou')
      ],
      south: [
        { id: 'mc-2m', suit: 'man', rank: 2 },
        { id: 'mc-3m', suit: 'man', rank: 3 },
        { id: 'mc-5m', suit: 'man', rank: 5 },
        { id: 'mc-6m', suit: 'man', rank: 6 },
        ...createDummyTiles(9, 's-pin', 'pin')
      ]
    });
    await setupScenarioRound(p1, multiChiWall);

    await p1.locator('#player-area-bottom [data-tile-id="mc-4m"]').click();
    await p2.waitForTimeout(400);

    const p2ChiBtns = await p2.locator('#action-buttons button:has-text("チー")').allTextContents();
    assert.equal(p2ChiBtns.length, 3, 'South should see 3 distinct Chi combination buttons for 4m with 2356m');
    console.log(`  ✓ 3 Chi combination buttons displayed: ${p2ChiBtns.join(' / ')}`);

    // 南家が「パス」をクリック → 即座に鳴きボタンが消え、南家のツモが自動実行されて14枚になることを検証
    await p2.locator('.btn-th-act:has-text("パス")').click();
    await p2.waitForTimeout(400);
    const p2HandAfterPass = await p2.locator('#hand-bottom .tenhou-tile').count() + await p2.locator('#drawn-bottom .tenhou-tile').count();
    assert.equal(p2HandAfterPass, 14, 'Clicking Pass on own turn should immediately draw a tile (14 tiles)');
    console.log('  ✓ Clicking Pass immediately dismissed Chi options and drew South tile');

    // 14. フリテン時の「ロン」ボタン非表示検証
    console.log('\n[Step 14] Testing Furiten Ron suppression in UI...');
    const furitenWall = createStackedWall({
      east: [
        { id: 'ft-dummy-1s', suit: 'sou', rank: 1 },
        { id: 'ft-target-4m', suit: 'man', rank: 4 },
        ...createDummyTiles(12, 'e-sou', 'sou')
      ],
      south: [
        { id: 'ft-1m-discard', suit: 'man', rank: 1 }, // 南家が最初に捨てる1m（1m-4m待ちの片割れ）
        { id: 'ft-2m', suit: 'man', rank: 2 },
        { id: 'ft-3m', suit: 'man', rank: 3 },
        { id: 'ft-4p', suit: 'pin', rank: 4 },
        { id: 'ft-5p', suit: 'pin', rank: 5 },
        { id: 'ft-6p', suit: 'pin', rank: 6 },
        { id: 'ft-7s', suit: 'sou', rank: 7 },
        { id: 'ft-8s', suit: 'sou', rank: 8 },
        { id: 'ft-9s', suit: 'sou', rank: 9 },
        { id: 'ft-wh1', suit: 'honor', honorType: 'white' },
        { id: 'ft-wh2', suit: 'honor', honorType: 'white' },
        { id: 'ft-ch1', suit: 'honor', honorType: 'red' },
        { id: 'ft-ch2', suit: 'honor', honorType: 'red' }
      ],
      draws: [
        { id: 'ft-draw-ch3', suit: 'honor', honorType: 'red' } // 南家がツモって中刻子完成・23m両面待ち聴牌
      ]
    });
    await setupScenarioRound(p1, furitenWall);

    // 1巡目: 東家が1s打牌 -> 南家がツモ(中) -> 南家が1mを打牌（これで南家は1m・4m待ちだが自分の河に1mがあるためフリテン！）
    await p1.locator('#player-area-bottom [data-tile-id="ft-dummy-1s"]').click();
    await p2.waitForTimeout(300);
    await p2.locator('.btn-th-act:has-text("ツモ (牌を引く)")').click();
    await p2.waitForTimeout(300);
    await p2.locator('#player-area-bottom [data-tile-id="ft-1m-discard"]').click();
    await p2.waitForTimeout(300);

    // 西家・北家がツモ切りして2巡目の東家へ回す
    for (const page of [p3, p4]) {
      await page.locator('.btn-th-act:has-text("ツモ (牌を引く)")').click();
      await page.waitForTimeout(200);
      await page.locator('.btn-th-act:has-text("ツモ切り")').click();
      await page.waitForTimeout(200);
    }

    // 2巡目: 東家がツモって 4m を打牌 -> 南家はフリテンのため「ロン」ボタンが出ないことを検証
    await p1.locator('.btn-th-act:has-text("ツモ (牌を引く)")').click();
    await p1.waitForTimeout(200);
    await p1.locator('#player-area-bottom [data-tile-id="ft-target-4m"]').click();
    await p2.waitForTimeout(400);

    const p2BtnsFuriten = await p2.locator('#action-buttons button').allTextContents();
    assert.ok(!p2BtnsFuriten.includes('ロン'), 'Furiten player must NOT see Ron button even on winning tile 4m');
    console.log('  ✓ Furiten player prevented from seeing Ron button on 4m discard');

    // 15. ロン和了後のモーダル「次へ」から次局（東2局・親移動）への完全遷移検証
    console.log('\n[Step 15] Testing Ron modal "次へ" -> ROUND_END -> East 2 dealer rotation...');
    await setupScenarioRound(p1, ronWall);
    await p1.locator('#player-area-bottom [data-tile-id="target-4m"]').click();
    await p2.waitForTimeout(400);
    await p2.locator('.btn-th-act.act-ron:text-is("ロン")').click();
    await p2.waitForTimeout(500);

    // モーダルの「次へ」をクリック → エラーなく round_end フェーズ（「次局へ」ボタン）に遷移することを検証
    await p2.locator('#result-close').click();
    await p1.waitForTimeout(400);
    const nextRoundBtnAfterRon = p1.locator('.btn-th-act:has-text("次局へ")');
    await nextRoundBtnAfterRon.waitFor({ state: 'visible', timeout: 5000 });
    await nextRoundBtnAfterRon.click();
    await p1.waitForTimeout(400);

    // 子の南家が和了したため、自動的に東2局 0本場・南家が親(13+1枚)でスタートしていることを検証
    const roundTitleText = await p1.locator('#round-title-display').textContent();
    assert.equal(roundTitleText?.trim(), '東 2 局', 'Round should advance to 東 2 局 after South wins');
    console.log('  ✓ Round advanced to 東 2 局 and South became dealer after non-dealer Ron win');

    const p2East2Hand = await p2.locator('#hand-bottom .tenhou-tile').count();
    const p2East2Drawn = await p2.locator('#drawn-bottom .tenhou-tile').count();
    assert.equal(p2East2Hand, 13, 'New dealer South should have 13 main tiles in East 2');
    assert.equal(p2East2Drawn, 1, 'New dealer South should have 1 drawn tile in East 2');
    console.log('  ✓ East 2 automatically started with South as dealer (13 + 1 tiles)');

    // 16. リーチ後の手出し禁止 (.tile-locked) & リーチ和了時の裏ドラ表示牌公開の検証
    console.log('\n[Step 16] Testing post-Riichi hand tile lock & Ura-Dora reveal on Riichi win...');
    const riichiLockAndWinWall = createStackedWall({
      east: [
        { id: 'rl-1m', suit: 'man', rank: 1 },
        { id: 'rl-2m', suit: 'man', rank: 2 },
        { id: 'rl-3m', suit: 'man', rank: 3 },
        { id: 'rl-4p', suit: 'pin', rank: 4 },
        { id: 'rl-5p', suit: 'pin', rank: 5 },
        { id: 'rl-6p', suit: 'pin', rank: 6 },
        { id: 'rl-7s', suit: 'sou', rank: 7 },
        { id: 'rl-8s', suit: 'sou', rank: 8 },
        { id: 'rl-9s', suit: 'sou', rank: 9 },
        { id: 'rl-wh1', suit: 'honor', honorType: 'white' },
        { id: 'rl-wh2', suit: 'honor', honorType: 'white' },
        { id: 'rl-2s', suit: 'sou', rank: 2 },
        { id: 'rl-3s', suit: 'sou', rank: 3 },
        { id: 'rl-decl-9m', suit: 'man', rank: 9 }
      ],
      south: [
        { id: 'rl-s-4s', suit: 'sou', rank: 4 }, // 南家が捨てるか東家が次巡ツモ和了
        ...createDummyTiles(12, 's-pin', 'pin')
      ],
      draws: [
        { id: 'd-s', suit: 'pin', rank: 1 },
        { id: 'd-w', suit: 'pin', rank: 2 },
        { id: 'd-n', suit: 'pin', rank: 3 },
        { id: 'd-e-win-1s', suit: 'sou', rank: 1 } // 東家が2巡目にツモる和了牌 1s
      ]
    });
    await setupScenarioRound(p1, riichiLockAndWinWall);

    // 東家が立直して 9m を宣言打牌 (1s-4s待ち)
    await p1.locator('.btn-th-act:has-text("立直")').click();
    await p1.waitForTimeout(300);
    await p1.locator('#player-area-bottom [data-tile-id="rl-decl-9m"]').click();
    await p1.waitForTimeout(300);

    // 南・西・北がツモ切りして東家の2巡目へ
    for (const page of [p2, p3, p4]) {
      await page.locator('.btn-th-act:has-text("ツモ (牌を引く)")').click();
      await page.waitForTimeout(200);
      await page.locator('.btn-th-act:has-text("ツモ切り")').click();
      await page.waitForTimeout(200);
    }

    // 東家が2巡目のツモ (1s = 和了牌)
    await p1.locator('.btn-th-act:has-text("ツモ (牌を引く)")').click();
    await p1.waitForTimeout(300);

    // リーチ後のため純手牌13枚すべてが .tile-locked になっていることを検証
    const lockedCount = await p1.locator('#hand-bottom .tenhou-tile.tile-locked').count();
    assert.equal(lockedCount, 13, 'All 13 main hand tiles must be locked (.tile-locked) after Riichi');
    console.log('  ✓ All 13 main hand tiles locked (.tile-locked) on post-Riichi turn');

    // 東家がツモ和了 → 裏ドラ表示牌が表向き (.tile-face) でモーダルに表示されることを検証
    await p1.locator('.btn-th-act.act-tsumo:text-is("ツモ")').click();
    await p1.waitForTimeout(400);
    const uraFaceCount = await p1.locator('#result-uradora-indicators .tenhou-tile.tile-face').count();
    assert.ok(uraFaceCount >= 1, 'Ura-dora indicator must be revealed face-up for Riichi winner');
    const yakuText = await p1.locator('#result-yaku-list').textContent();
    assert.ok(yakuText?.includes('ダブル立直') || yakuText?.includes('立直'), 'Result modal should list Riichi/Double Riichi');
    assert.ok(yakuText?.includes('一発'), 'Result modal should list Ippatsu on first round Tsumo after Riichi');
    console.log('  ✓ Ura-dora indicator revealed face-up and Double Riichi + Ippatsu + Tsumo verified in modal');

    // 17. 1〜3人入室時の1分待機カウントダウン＆タイムアウト時の自動NPC補充・自動局開始のE2E検証
    console.log('\n[Step 17] Testing 1-3 player 1-minute matchmaking wait -> auto NPC replenishment & round start...');
    const soloCtx = await browser.newContext({ viewport: { width: 1200, height: 750 } });
    const soloPage = await soloCtx.newPage();
    const soloRoomId = `solo-npc-${Date.now()}`;

    await soloPage.goto(baseURL);
    // ロビーで「東風戦」を選択して入室
    await soloPage.locator('label.length-option:has(#game-length-east)').click();
    await soloPage.fill('#room-id', soloRoomId);
    await soloPage.fill('#player-id', 'soloPlayer');
    await soloPage.click('#connect-btn');
    await soloPage.waitForSelector('#game-screen.active', { timeout: 5000 });
    await soloPage.waitForTimeout(300);

    // 東風戦モードで入室できており、ヘッダーにも [東風戦] が表示されていることを検証
    const headerRoomText = await soloPage.locator('#header-room-info').textContent();
    assert.ok(headerRoomText?.includes('[東風戦]'), `Header should display [東風戦] (got: ${headerRoomText})`);
    console.log('  ✓ Lobby selection "東風戦" applied and displayed in room header');

    // 1人入室直後はまだ対局開始せず、1分(60秒)のカウントダウン待機状態であり、空席が3つあることを検証
    const waitingInfo = await soloPage.evaluate(() => {
      const st = (window as any).App.gameState;
      return {
        phase: st.phase,
        remMs: st.autoStartDeadline ? st.autoStartDeadline - Date.now() : 0,
        unoccupiedCount: st.players.filter((p: any) => !p.isOccupied).length
      };
    });
    assert.equal(waitingInfo.phase, 'waiting', '1-player room must initially wait in waiting phase');
    assert.ok(waitingInfo.remMs > 50_000 && waitingInfo.remMs <= 61_000, `Default matchmaking deadline should be ~60,000ms (got ${waitingInfo.remMs}ms)`);
    assert.equal(waitingInfo.unoccupiedCount, 3, 'Remaining 3 seats must be unoccupied while waiting for humans');
    const manualStartBtnCount = await soloPage.locator('.btn-th-act:has-text("局開始")').count();
    assert.equal(manualStartBtnCount, 0, 'Manual "局開始" button must NOT be shown');
    console.log(`  ✓ Verified 1-minute (60s) matchmaking countdown active (remaining: ${Math.ceil(waitingInfo.remMs / 1000)}s, 3 empty seats)`);

    // 「鳴きなし」をONにしておく
    await soloPage.locator('.th-toggle-item:has(#toggle-no-meld)').click();

    // 待機タイマー満了をシミュレート (300ms後にタイムアウト発火) -> 自動でNPC3体が補充され、自動配牌・局開始されることを検証
    await soloPage.evaluate(() => (window as any).sendMsg({ type: 'set_matchmaking_timeout', timeoutMs: 300 }));
    await soloPage.waitForTimeout(700);

    const afterTimeoutInfo = await soloPage.evaluate(() => {
      const st = (window as any).App.gameState;
      return {
        phase: st.phase,
        npcNames: st.players.filter((p: any) => p.isNpc).map((p: any) => p.id)
      };
    });
    assert.equal(afterTimeoutInfo.phase, 'playing', 'Round must automatically start when matchmaking timeout expires');
    assert.deepEqual(afterTimeoutInfo.npcNames, ['CPU-南', 'CPU-西', 'CPU-北'], '3 NPCs must be automatically replenished into empty seats');
    console.log(`  ✓ Timeout expired -> Auto-replenished NPCs (${afterTimeoutInfo.npcNames.join(', ')}) and auto-started round`);

    // 東家(人間)が1枚打牌 -> 3体のNPC(南・西・北)が自動でツモ＆打牌し、東家の2巡目(14枚)まで自動進行することを検証
    await discardAnyTile(soloPage);
    await soloPage.waitForTimeout(2600);

    const npcSouthDiscards = await soloPage.locator('#discards-right .tenhou-tile').count();
    const npcWestDiscards = await soloPage.locator('#discards-top .tenhou-tile').count();
    const npcNorthDiscards = await soloPage.locator('#discards-left .tenhou-tile').count();
    assert.equal(npcSouthDiscards, 1, 'NPC South should have automatically discarded 1 tile');
    assert.equal(npcWestDiscards, 1, 'NPC West should have automatically discarded 1 tile');
    assert.equal(npcNorthDiscards, 1, 'NPC North should have automatically discarded 1 tile');

    const soloHand2 = await soloPage.locator('#hand-bottom .tenhou-tile').count();
    const soloDrawn2 = await soloPage.locator('#drawn-bottom .tenhou-tile').count();
    assert.equal(soloHand2 + soloDrawn2, 14, 'Human player should automatically receive 2nd turn draw (14 tiles) after 3 NPCs finish');
    console.log('  ✓ All 3 NPCs automatically drew & discarded, and human player seamlessly started Turn 2 with 14 tiles');
    await soloCtx.close();

    // 18. 西入 (Shaa-nyuu / West Round Entry) のブラウザUI検証 (東風戦の南入 / 東南戦の西入)
    console.log('\n[Step 18] Testing 西入 (West round entry when all players < 30,000 pts at end of South 4)...');
    // 東1局 -> 東2局 -> 東3局 -> 東4局 -> 南1局 -> 南2局 -> 南3局 -> 南4局 まで低打点ロン(1,000点: 平和のみ)で全員30,000点未満のまま進行させる壁
    const lowScoreRonWall = createStackedWall({
      east: [
        { id: 'ls-6m', suit: 'man', rank: 6 },
        ...createDummyTiles(13, 'e-sou', 'sou')
      ],
      south: [
        { id: 'ls-1m', suit: 'man', rank: 1 },
        { id: 'ls-2m', suit: 'man', rank: 2 },
        { id: 'ls-3m', suit: 'man', rank: 3 },
        { id: 'ls-4p', suit: 'pin', rank: 4 },
        { id: 'ls-5p', suit: 'pin', rank: 5 },
        { id: 'ls-6p', suit: 'pin', rank: 6 },
        { id: 'ls-7s', suit: 'sou', rank: 7 },
        { id: 'ls-8s', suit: 'sou', rank: 8 },
        { id: 'ls-9s', suit: 'sou', rank: 9 },
        { id: 'ls-2p1', suit: 'pin', rank: 2 },
        { id: 'ls-2p2', suit: 'pin', rank: 2 },
        { id: 'ls-4m', suit: 'man', rank: 4 },
        { id: 'ls-5m', suit: 'man', rank: 5 }
      ],
      deadWall: Array.from({ length: 14 }, (_, i) => ({
        id: `dw-wh-${i}`,
        suit: 'honor' as const,
        honorType: 'white' as const
      }))
    });

    // 東風戦に設定し、全員30,000点未満のまま東1局〜東4局を1,000点ロン×4回で通過して「南入 (南 1 局)」になることをUIで検証
    await setupScenarioRound(p1, lowScoreRonWall);
    await p1.evaluate(() => (window as any).sendMsg({ type: 'set_game_length', gameLength: 'east' }));
    await p1.waitForTimeout(200);

    // 東1局〜東4局まで、親以外のプレイヤーに1,000点ロン(平和のみ)を4局連続させても最高点は 25,000 + 4,000 = 29,000 (< 30,000)
    // ※ setupScenarioRound は東1局にリセットするため、1局目はsetupScenarioRound済みの山を使い、2〜4局目は流局(親不聴)で親を流す
    const noten13 = (prefix: string): TileInstance[] => [
      { id: `${prefix}-1`, suit: 'honor', honorType: 'east' },
      { id: `${prefix}-2`, suit: 'honor', honorType: 'south' },
      { id: `${prefix}-3`, suit: 'honor', honorType: 'west' },
      { id: `${prefix}-4`, suit: 'honor', honorType: 'north' },
      { id: `${prefix}-5`, suit: 'man', rank: 1 },
      { id: `${prefix}-6`, suit: 'man', rank: 7 },
      { id: `${prefix}-7`, suit: 'pin', rank: 1 },
      { id: `${prefix}-8`, suit: 'pin', rank: 4 },
      { id: `${prefix}-9`, suit: 'pin', rank: 7 },
      { id: `${prefix}-10`, suit: 'sou', rank: 1 },
      { id: `${prefix}-11`, suit: 'sou', rank: 4 },
      { id: `${prefix}-12`, suit: 'sou', rank: 7 },
      { id: `${prefix}-13`, suit: 'man', rank: 4 }
    ];
    const shortNotenDrawWall = createStackedWall({
      east: [...noten13('nt-e'), { id: 'nt-e14', suit: 'man', rank: 4 }],
      south: noten13('nt-s'),
      west: noten13('nt-w'),
      north: noten13('nt-n'),
      totalTiles: 67
    });

    await setupScenarioRound(p1, shortNotenDrawWall);
    // 東南戦(デフォルト)で東1〜東4・南1〜南4の計8局を全員25,000点(30,000点未満)のまま流局通過させ、南4局終了後に「西 1 局」(西入)へ突入することを検証！
    await p1.evaluate(() => (window as any).sendMsg({ type: 'set_game_length', gameLength: 'south' }));
    await p1.waitForTimeout(200);

    // 1局目(東1局)は既に山残り0枚なので東家が1枚捨てて流局
    await discardAnyTile(p1);
    await p1.waitForTimeout(300);
    await p1.locator('.btn-th-act:has-text("局終了へ")').click();
    await p1.waitForTimeout(300);
    await p1.locator('.btn-th-act:has-text("次局へ")').click();
    await p1.waitForTimeout(400);

    // 2局目(東2局)〜8局目(南4局)まで順番に親が1枚打牌(山残り0枚のため即荒牌流局・親不聴)して親流れを進める
    const dealerPages = [p2, p3, p4, p1, p2, p3, p4]; // 東2(南), 東3(西), 東4(北), 南1(東), 南2(南), 南3(西), 南4(北)
    for (const dPage of dealerPages) {
      await discardAnyTile(dPage);
      await p1.waitForTimeout(250);
      await p1.locator('.btn-th-act:has-text("局終了へ")').click();
      await p1.waitForTimeout(250);
      await p1.locator('.btn-th-act:has-text("次局へ")').click();
      await p1.waitForTimeout(350);
    }

    // 南4局が全員25,000点(<30,000点)で終了したため、対局終了せず「西 1 局」(西入)に突入していることを検証！
    const westRoundTitle = await p1.locator('#round-title-display').textContent();
    assert.equal(westRoundTitle?.trim(), '西 1 局', `Must enter 西 1 局 (West round) when all scores < 30,000 after South 4 (got: ${westRoundTitle})`);
    console.log('  ✓ Confirmed 西入 (Shaa-nyuu): game entered "西 1 局" in UI after South 4 ended with all players < 30,000 pts');

    console.log('\n============================================================');
    console.log('🎉 ALL 18 E2E UI TESTS PASSED SUCCESSFULLY! (100% PURE ENGINE LOGIC)');
    console.log('============================================================\n');

  } finally {
    await browser.close();
  }
}

// 実行
runFourPlayerTests()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('\n❌ Test execution failed:');
    console.error(err);
    process.exit(1);
  });
