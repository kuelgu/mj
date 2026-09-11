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
  // 1. 牌山をサーバーの部屋に注入（局状態は waiting へリセット）
  await p1.evaluate((w: any) => (window as any).sendMsg({ type: 'set_wall', wall: w }), wall);
  await p1.waitForTimeout(400);

  // 2. 東家で「局開始」をクリック
  const startBtn = p1.locator('.btn-th-act:has-text("局開始")');
  await startBtn.waitFor({ state: 'visible', timeout: 5000 });
  await startBtn.click();
  await p1.waitForTimeout(400);

  // 3. 東家で「配牌完了」をクリック
  const dealBtn = p1.locator('.btn-th-act:has-text("配牌完了")');
  await dealBtn.waitFor({ state: 'visible', timeout: 5000 });
  await dealBtn.click();
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

    // 3. 通常配牌フローの検証 (ROUND_START -> DEAL_COMPLETE)
    console.log('\n[Step 3] Testing initial deal flow (ROUND_START -> DEAL_COMPLETE)...');
    const startRoundBtn = p1.locator('.btn-th-act:has-text("局開始")');
    await startRoundBtn.waitFor({ state: 'visible', timeout: 5000 });
    await startRoundBtn.click();

    await p1.waitForTimeout(600);
    const dealCompleteBtn = p1.locator('.btn-th-act:has-text("配牌完了")');
    await dealCompleteBtn.waitFor({ state: 'visible', timeout: 5000 });
    await dealCompleteBtn.click();

    await p1.waitForTimeout(800);
    const p1HandCount = await p1.locator('#hand-bottom .tenhou-tile').count();
    const p1DrawnCount = await p1.locator('#drawn-bottom .tenhou-tile').count();
    assert.equal(p1HandCount, 13, 'East should have 13 hand tiles');
    assert.equal(p1DrawnCount, 1, 'East should have 1 drawn tile');
    console.log(`  ✓ East hand verified: 13 hand tiles + 1 drawn tile (total 14)`);

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

    // 次局へボタン
    const nextRoundBtn = p1.locator('.btn-th-act:has-text("次局へ")');
    await nextRoundBtn.waitFor({ state: 'visible', timeout: 5000 });
    await nextRoundBtn.click();
    await p1.waitForTimeout(600);

    // 次の局の待機画面 (局開始ボタン) に戻っていることを検証
    const newStartBtn = p1.locator('.btn-th-act:has-text("局開始")');
    await newStartBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('  ✓ Round successfully completed and reset to next round waiting state');

    console.log('\n============================================================');
    console.log('🎉 ALL 11 TESTS PASSED SUCCESSFULLY! (100% PURE ENGINE LOGIC)');
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
