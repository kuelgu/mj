/**
 * オンライン麻雀 リーチ麻雀 Webクライアント
 * 
 * 機能:
 * - 中央サイコロボックス（卓心）の連動表示
 * - 6枚×3段の河（捨牌）＆リーチ宣言牌横向き表示＆最新打牌マーカー
 * - 自家手牌とツモ牌の分離表示（マージン配置）
 * - 他家の竹背伏せ牌＆ツモ牌分離表示
 * - 同種牌ホバーハイライト（手牌にホバーすると河やドラの同一牌が光る）
 * - プレイヤートグル（自動和了・鳴きなし・ツモ切り・理牌）
 * - アクションボタン（ツモ・ロン・立直・ポン・チー・カン・パス）
 * - 和了・精算スコアボード
 */

'use strict';

// ============================================================
// 定数 & ユーティリティ
// ============================================================

const WIND_KANJI = { east: '東', south: '南', west: '西', north: '北' };
const WIND_ORDER = ['east', 'south', 'west', 'north'];

const SUIT_ORDER = { man: 0, pin: 1, sou: 2, honor: 3 };
const HONOR_ORDER = { east: 0, south: 1, west: 2, north: 3, white: 4, green: 5, red: 6 };

const PHASE_NAMES = {
    waiting: '待機中',
    dealing: '配牌中',
    playing: 'プレイ中',
    ron_declared: 'ロン宣言',
    tsumo_declared: 'ツモ宣言',
    draw: '流局',
    scoring: '精算中',
    round_end: '局終了',
    game_end: '対局終了',
};

const PHASE_CSS = {
    playing: 'phase-playing',
    ron_declared: 'phase-ron',
    tsumo_declared: 'phase-tsumo',
    scoring: 'phase-scoring',
    draw: 'phase-draw',
    round_end: 'phase-end',
    game_end: 'phase-end',
};

// ============================================================
// アプリ状態
// ============================================================

const App = {
    ws: null,
    connected: false,
    roomId: null,
    playerId: null,
    gameState: null,
    mySeat: 'east',   // 'east'|'south'|'west'|'north'
    
    // プレイヤートグル設定
    autoWin: true,
    noMeld: false,
    autoTsumogiri: false,
    autoSort: true,

    // 同種牌ハイライト中のキー
    hoveredTileKey: null,

    // パス済みの他家打牌ID
    passedDiscardId: null,

    // マッチング待機カウントダウンタイマー
    waitingCountdownTimer: null,
};

// ============================================================
// DOM参照キャッシュ
// ============================================================

const $ = id => document.getElementById(id);
const dom = {
    // 画面
    connectScreen: $('connect-screen'),
    gameScreen: $('game-screen'),
    connectForm: $('connect-form'),
    serverUrl: $('server-url'),
    roomId: $('room-id'),
    playerId: $('player-id'),
    connectError: $('connect-error'),
    
    // ヘッダー
    headerRoom: $('header-room-info'),
    roundTitle: $('round-title-display'),
    honbaTitle: $('honba-title-display'),
    riichiSticksDisplay: $('riichi-sticks-display'),
    statusDot: document.querySelector('#conn-status .status-dot'),
    statusText: $('conn-status-text'),
    disconnectBtn: $('disconnect-btn'),
    toggleLogBtn: $('toggle-log-btn'),

    // 中央コンソール (サイコロボックス)
    centerBox: $('center-box'),
    cboxRoundWind: $('round-wind-display'),
    cboxRoundNum: $('round-number-display'),
    cboxHonba: $('honba-display'),
    doraArea: $('dora-indicators'),
    wallCount: $('wall-count'),
    phaseBadge: $('phase-badge'),

    // アクション & トグル
    actionPanel: $('action-panel'),
    actionBtns: $('action-buttons'),
    toggleAutoWin: $('toggle-auto-win'),
    toggleNoMeld: $('toggle-no-meld'),
    toggleAutoTsumogiri: $('toggle-auto-tsumogiri'),
    toggleAutoSort: $('toggle-auto-sort'),

    // ログ
    logDrawer: $('log-drawer'),
    eventLog: $('event-log'),
    btnClearLog: $('btn-clear-log'),
    btnCloseLog: $('btn-close-log'),
    customJson: $('custom-event-json'),
    btnSendCustom: $('btn-send-custom'),

    // 和了モーダル
    resultModal: $('result-modal'),
    resultWinnerTitle: $('result-winner-title'),
    resultTypeTag: $('result-type-tag'),
    resultHandTiles: $('result-hand-tiles'),
    resultDoraIndicators: $('result-dora-indicators'),
    resultUraDoraGroup: $('result-uradora-group'),
    resultUraDoraIndicators: $('result-uradora-indicators'),
    resultYakuList: $('result-yaku-list'),
    resultFuHan: $('result-fu-han'),
    resultPointTitle: $('result-point-title'),
    resultPoints: $('result-points'),
    resultPaymentSplit: $('result-payment-split'),
    resultClose: $('result-close'),
};

// 座席 → 画面上の位置 (自分を下=bottomに固定)
function getPositionFromSeat(seat) {
    const mySeat = App.mySeat || 'east';
    const rel = ((WIND_ORDER.indexOf(seat) - WIND_ORDER.indexOf(mySeat)) + 4) % 4;
    return ['bottom', 'right', 'top', 'left'][rel];
}

// 画面位置 → 座席
function getSeatFromPosition(pos) {
    const mySeat = App.mySeat || 'east';
    const myIdx = WIND_ORDER.indexOf(mySeat);
    const relMap = { bottom: 0, right: 1, top: 2, left: 3 };
    return WIND_ORDER[(myIdx + (relMap[pos] ?? 0)) % 4];
}

// ============================================================
// 手牌状態ヘルパー & 手牌ソート (理牌)
// ============================================================

/** 打牌可能な状態か (門前14枚、1鳴き11枚、2鳴き8枚、3鳴き5枚、4鳴き2枚) */
function canPlayerDiscard(player) {
    if (!player || !player.hand) return false;
    const meldCount = player.melds ? player.melds.length : 0;
    const targetSize = 14 - meldCount * 3;
    return player.hand.length >= targetSize;
}

/** ツモ待ちの状態か (門前13枚、1鳴き10枚、2鳴き7枚、3鳴き4枚、4鳴き1枚) */
function isPlayerWaitingDraw(player) {
    if (!player || !player.hand) return false;
    const meldCount = player.melds ? player.melds.length : 0;
    const targetSize = 13 - meldCount * 3;
    return player.hand.length <= targetSize;
}

function sortHandTiles(hand, melds = []) {
    if (!hand || hand.length === 0) return { main: [], drawn: null };
    
    // 副露数を考慮して打牌待ち枚数（14 - meldCount*3）を計算
    const meldCount = melds ? melds.length : 0;
    const discardSize = 14 - meldCount * 3;
    const isDiscardReady = hand.length >= discardSize;

    const drawn = isDiscardReady ? hand[hand.length - 1] : null;
    const toSort = isDiscardReady ? hand.slice(0, hand.length - 1) : [...hand];

    if (App.autoSort) {
        toSort.sort((a, b) => {
            const sa = SUIT_ORDER[a.suit] ?? 9;
            const sb = SUIT_ORDER[b.suit] ?? 9;
            if (sa !== sb) return sa - sb;
            if (a.suit === 'honor') {
                return (HONOR_ORDER[a.honorType] ?? 9) - (HONOR_ORDER[b.honorType] ?? 9);
            }
            return (a.rank ?? 0) - (b.rank ?? 0);
        });
    }

    return { main: toSort, drawn };
}


// 牌のキー取得 (同種牌ハイライト用: 例 '1m', '5p', 'east', 'red')
function getTileKey(tile) {
    if (!tile) return '';
    if (tile.suit === 'honor') return tile.honorType;
    return `${tile.rank}${tile.suit[0]}`;
}

// ============================================================
// WebSocket 通信
// ============================================================

function connect(url, roomId, playerId, gameLength = 'south') {
    setStatus('connecting', '接続中...');
    log('system', `${url} に接続中...`);

    try {
        App.ws = new WebSocket(url);
    } catch (e) {
        showConnectError(`接続失敗: ${e.message}`);
        return;
    }

    App.ws.onopen = () => {
        App.connected = true;
        App.roomId = roomId;
        App.playerId = playerId;
        setStatus('connected', '接続中');
        log('system', '対局サーバーに接続しました');
        sendMsg({ type: 'join_room', roomId, playerId, gameLength });
    };

    App.ws.onmessage = e => {
        try {
            onServerMessage(JSON.parse(e.data));
        } catch (ex) {
            log('error', `データ解析エラー: ${ex.message}`);
        }
    };

    App.ws.onclose = () => {
        App.connected = false;
        setStatus('disconnected', '切断');
        log('system', '対局サーバーから切断されました');
    };

    App.ws.onerror = () => {
        if (!App.connected) {
            showConnectError('サーバーに接続できませんでした。サーバーが稼働しているか確認してください。');
        }
    };
}

function disconnect() {
    App.ws?.close();
    Object.assign(App, { ws: null, connected: false, gameState: null, mySeat: 'east' });
    switchScreen('connect');
}

function sendMsg(msg) {
    if (App.ws?.readyState === WebSocket.OPEN) {
        App.ws.send(JSON.stringify(msg));
    } else {
        log('error', 'サーバー未接続です');
    }
}

function sendAction(event) {
    const pStr = event.player ? ` (${WIND_KANJI[event.player] ?? event.player})` : '';
    log('action', `→ ${event.type}${pStr}`);
    sendMsg({ type: 'game_action', event });
}

// ============================================================
// サーバーメッセージ受信処理
// ============================================================

function onServerMessage(msg) {
    switch (msg.type) {
        case 'joined':
            onPlayerJoined(msg);
            break;
        case 'game_update':
            onGameUpdate(msg);
            break;
        case 'state':
            onStateReceived(msg.state);
            break;
        case 'error':
            log('error', `❌ ${msg.error}`);
            break;
        default:
            log('system', `未処理メッセージ: ${msg.type}`);
    }
}

function onPlayerJoined(msg) {
    // サーバーから割り当てられた座席 (またはプレイヤーIDから推定)
    const seatMap = {
        p1: 'east', p2: 'south', p3: 'west', p4: 'north',
        player1: 'east', player2: 'south', player3: 'west', player4: 'north',
        '1': 'east', '2': 'south', '3': 'west', '4': 'north',
    };
    App.mySeat = msg.seat || seatMap[msg.playerId] || 'east';
    dom.headerRoom.textContent = `卓: ${msg.roomId} / ${msg.playerId} (${WIND_KANJI[App.mySeat]}家)`;
    log('system', `入室完了: ${msg.playerId} (座席: ${WIND_KANJI[App.mySeat]}家)`);
    switchScreen('game');
    sendMsg({ type: 'get_state' });
}

function onGameUpdate(msg) {
    let latestState = null;
    for (const m of (msg.messages || [])) {
        switch (m.type) {
            case 'game_event':
                log('game-event', `📋 ${m.event}`);
                break;
            case 'branching_point':
                log('system', `⚡ 分岐点: ${m.branchingPoint}`);
                break;
            case 'state_update':
                latestState = m.state;
                log('game-event', `🔄 状態遷移 → ${PHASE_NAMES[m.state.phase] ?? m.state.phase}`);
                break;
            case 'payment':
                showPaymentResult(m.payments);
                break;
            case 'error':
                log('error', `❌ ${m.error}`);
                break;
        }
    }
    if (latestState) {
        applyGameState(latestState);
    }
}

function onStateReceived(state) {
    log('game-event', '状態同期完了');
    applyGameState(state);
}

// ============================================================
// 状態適用 & 全体レンダリング
// ============================================================

function applyGameState(state) {
    App.gameState = state;
    if (state && ['playing', 'waiting', 'dealing', 'round_end'].includes(state.phase)) {
        dom.resultModal.classList.add('hidden');
    }
    renderBoard(state);
    renderActionPanel(state);
    handleAutoActions(state);
}

function renderBoard(state) {
    if (!state) return;

    // 1. ヘッダー情報
    const rWind = WIND_KANJI[state.round?.wind] || '東';
    const rNum = state.round?.number || 1;
    const honba = state.honba || 0;
    const riichiSticks = state.riichiSticks || 0;
    const modeLabel = state.gameLength === 'east' ? '東風戦' : '東南戦';

    if (App.roomId && App.playerId) {
        dom.headerRoom.textContent = `卓: ${App.roomId} [${modeLabel}] / ${App.playerId} (${WIND_KANJI[App.mySeat]}家)`;
    }
    dom.roundTitle.textContent = `${rWind} ${rNum} 局`;
    dom.honbaTitle.textContent = `${honba} 本場`;
    dom.riichiSticksDisplay.textContent = riichiSticks;

    // 2. 中央サイコロボックス (卓心)
    dom.cboxRoundWind.textContent = rWind;
    dom.cboxRoundNum.textContent = rNum;
    dom.cboxHonba.textContent = honba;
    dom.wallCount.textContent = state.wall ? state.wall.length : '--';

    // フェーズバッジ
    const phase = state.phase || 'waiting';
    dom.phaseBadge.textContent = PHASE_NAMES[phase] || phase;
    dom.phaseBadge.className = `phase-badge ${PHASE_CSS[phase] || ''}`;

    // ドラ表示牌
    dom.doraArea.innerHTML = '';
    const doras = state.doraIndicators || [];
    if (doras.length > 0) {
        doras.forEach(t => {
            dom.doraArea.insertAdjacentHTML('beforeend', 
                MahjongTiles.renderTileHtml(t, 'sm', 'is-dora')
            );
        });
    } else {
        dom.doraArea.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(null, 'sm'));
    }

    // 3. 中央コンソール四辺のプレイヤー情報・手番点灯・リーチ棒
    ['bottom', 'top', 'left', 'right'].forEach(position => {
        const seat = getSeatFromPosition(position);
        const player = (state.players || []).find(p => p.seat === seat);

        const edgeEl = $(`cbox-edge-${position}`);
        const windEl = $(`player-wind-${position}`);
        const nameEl = $(`player-name-${position}`);
        const scoreEl = $(`player-score-${position}`);
        const riichiSlot = $(`riichi-slot-${position}`);

        // 風・名前・点数
        if (windEl) windEl.textContent = WIND_KANJI[seat] || seat;
        if (nameEl) nameEl.textContent = player?.id || '--';
        if (scoreEl) scoreEl.textContent = player ? (player.score || 0).toLocaleString() : '25,000';

        // 現在の手番プレイヤー点灯 (アクティブ発光)
        const isCurrentTurn = state.currentPlayer === seat;
        edgeEl?.classList.toggle('active-turn', isCurrentTurn);

        // リーチ棒
        if (riichiSlot) {
            riichiSlot.innerHTML = '';
            if (player?.riichi?.declared) {
                riichiSlot.innerHTML = MahjongTiles.renderRiichiStickHtml();
            }
        }
    });

    // 4. 四家の手牌・副露・河（捨牌）を描画
    const inGame = !['waiting'].includes(phase);
    (state.players || []).forEach(player => {
        renderPlayerSection(player, state, inGame);
    });
}

/**
 * プレイヤーの手牌、ツモ牌スロット、副露、河を描画
 */
function renderPlayerSection(player, state, inGame) {
    const position = getPositionFromSeat(player.seat);
    const isMe = position === 'bottom';
    const isMyTurn = state.currentPlayer === player.seat;
    const hand = player.hand || [];

    const handContainer = $(`hand-${position}`);
    const drawnSlot = $(`drawn-${position}`);
    const meldsContainer = $(`melds-${position}`);
    const discardsContainer = $(`discards-${position}`);

    // ---- 手牌 & ツモ牌の描画 ----
    if (handContainer && drawnSlot) {
        handContainer.innerHTML = '';
        drawnSlot.innerHTML = '';

        if (isMe && hand.length > 0) {
            // 自家手牌: 理牌 & 打牌可能時はツモ牌スロットへ分離！
            const { main, drawn } = sortHandTiles(hand, player.melds);

            const isRiichiDeclared = Boolean(player.riichi?.declared);
            const declIdx = player.riichi?.discardIndex ?? -1;
            const curDiscards = player.discards ? player.discards.length : 0;
            const isPostRiichi = isRiichiDeclared && curDiscards > declIdx;
            const isRiichiDeclTurn = isRiichiDeclared && curDiscards === declIdx;
            const riichiCandidateIds = isRiichiDeclTurn
                ? new Set(getRiichiDiscardCandidates(hand, player.melds).map(t => t.id))
                : null;

            // 純手牌
            main.forEach(tile => {
                const isHovered = App.hoveredTileKey && getTileKey(tile) === App.hoveredTileKey;
                const canClickTile = !isPostRiichi && (!riichiCandidateIds || riichiCandidateIds.size === 0 || riichiCandidateIds.has(tile.id));
                const interactClass = canClickTile ? `interactive${isMyTurn ? ' my-turn' : ''}` : 'tile-locked';
                const extra = `${interactClass}${isHovered ? ' tile-same-highlight' : ''}`;
                handContainer.insertAdjacentHTML('beforeend', 
                    MahjongTiles.renderTileHtml(tile, 'lg', extra)
                );
            });

            // 打牌待ち牌 (ツモ牌または鳴き直後の牌スロット)
            if (drawn) {
                const isHovered = App.hoveredTileKey && getTileKey(drawn) === App.hoveredTileKey;
                const canClickDrawn = !riichiCandidateIds || riichiCandidateIds.size === 0 || riichiCandidateIds.has(drawn.id);
                const interactClass = canClickDrawn ? 'interactive my-turn just-drawn' : 'tile-locked just-drawn';
                const extra = `${interactClass}${isHovered ? ' tile-same-highlight' : ''}`;
                drawnSlot.insertAdjacentHTML('beforeend', 
                    MahjongTiles.renderTileHtml(drawn, 'lg', extra)
                );
            }
        } else if (!isMe && inGame) {
            // 他家の手牌: 黄色竹背 (副露数を反映)
            const meldCount = player.melds ? player.melds.length : 0;
            const targetDrawSize = 13 - meldCount * 3;
            const targetDiscardSize = 14 - meldCount * 3;
            const count = hand.length > 0 ? hand.length : (isMyTurn ? targetDiscardSize : targetDrawSize);
            const isDiscardReady = count >= targetDiscardSize;
            const mainCount = isDiscardReady ? count - 1 : count;

            // 純手牌 (竹背)
            const isSide = (position === 'left' || position === 'right');
            const tileSize = isSide ? 'sm' : 'md';
            const orientation = isSide ? 'horizontal' : 'normal';
            for (let i = 0; i < mainCount; i++) {
                handContainer.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(null, tileSize, '', orientation));
            }

            // ツモ牌スロット
            if (isDiscardReady) {
                drawnSlot.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(null, tileSize, '', orientation));
            }
        }

    }

    // ---- 副露 (ポン・チー・カン) ----
    if (meldsContainer) {
        meldsContainer.innerHTML = '';
        (player.melds || []).forEach(meld => {
            const meldEl = document.createElement('div');
            meldEl.className = 'meld-group';

            if (meld.type === 'ankan') {
                // 暗槓: [伏せ] [表] [表] [伏せ]
                (meld.tiles || []).forEach((t, i) => {
                    const isCovered = (i === 0 || i === meld.tiles.length - 1);
                    meldEl.insertAdjacentHTML('beforeend', 
                        MahjongTiles.renderTileHtml(isCovered ? null : t, 'sm')
                    );
                });
            } else {
                // ポン・チー・明槓
                // calledFrom に応じて横向き牌の位置を決定 (上家=左端, 対面=中, 下家=右端)
                const calledFrom = meld.calledFrom;
                let rotatedIdx = -1;
                if (calledFrom) {
                    const pIdx = WIND_ORDER.indexOf(player.seat);
                    const cIdx = WIND_ORDER.indexOf(calledFrom);
                    const diff = (cIdx - pIdx + 4) % 4;
                    if (diff === 3) rotatedIdx = 0; // 上家から → 左端が横向き
                    else if (diff === 2) rotatedIdx = 1; // 対面から → 中央が横向き
                    else if (diff === 1) rotatedIdx = meld.tiles.length - 1; // 下家から → 右端が横向き
                }

                (meld.tiles || []).forEach((t, i) => {
                    const isHoriz = (i === rotatedIdx);
                    meldEl.insertAdjacentHTML('beforeend', 
                        MahjongTiles.renderTileHtml(t, 'sm', '', isHoriz ? 'horizontal' : 'normal')
                    );
                });
            }

            meldsContainer.appendChild(meldEl);
        });
    }

    // ---- 河 (捨牌 6枚×3段) ----
    if (discardsContainer) {
        discardsContainer.innerHTML = '';
        const discards = player.discards || [];
        const isLatestPlayer = state.lastDiscard && discards.length > 0 && 
                               discards[discards.length - 1].id === state.lastDiscard.id;

        discards.forEach((tile, i) => {
            // リーチ宣言牌の横向き (個人捨牌インデックス discardIndex と照合)
            const isRiichiTile = player.riichi?.declared && (
                (player.riichi.discardIndex !== undefined && player.riichi.discardIndex !== null)
                    ? i === player.riichi.discardIndex
                    : (player.riichi.turn !== null && i === player.riichi.turn)
            );
            const orientation = isRiichiTile ? 'horizontal' : 'normal';

            // 最新打牌ハイライト
            const isLatest = isLatestPlayer && i === discards.length - 1;
            const latestClass = isLatest ? 'is-latest-discard' : '';

            // 同種牌ハイライト
            const isSameHover = App.hoveredTileKey && getTileKey(tile) === App.hoveredTileKey;
            const sameClass = isSameHover ? 'tile-same-highlight' : '';

            const extra = `${latestClass} ${sameClass}`.trim();
            discardsContainer.insertAdjacentHTML('beforeend', 
                MahjongTiles.renderTileHtml(tile, 'md', extra, orientation)
            );
        });
    }
}

// ============================================================
// 鳴き (副露: チー・ポン・カン) 判定ロジック
// ============================================================

function canPon(hand, targetTile) {
    if (!hand || !targetTile) return false;
    const count = hand.filter(t => 
        t.suit === targetTile.suit && 
        t.rank === targetTile.rank && 
        t.honorType === targetTile.honorType
    ).length;
    return count >= 2;
}

function canDaiminkan(hand, targetTile) {
    if (!hand || !targetTile) return false;
    const count = hand.filter(t => 
        t.suit === targetTile.suit && 
        t.rank === targetTile.rank && 
        t.honorType === targetTile.honorType
    ).length;
    return count >= 3;
}

function canChi(hand, targetTile) {
    return getChiCombinations(hand, targetTile).length > 0;
}

/**
 * チー可能な2枚の組み合わせ一覧を返す
 */
function getChiCombinations(hand, targetTile) {
    if (!hand || !targetTile || targetTile.suit === 'honor' || typeof targetTile.rank !== 'number') return [];
    const r = targetTile.rank;
    const s = targetTile.suit;
    const findRank = rank => hand.find(t => t.suit === s && t.rank === rank);

    const combos = [];
    if (r >= 3) {
        const t1 = findRank(r - 2);
        const t2 = findRank(r - 1);
        if (t1 && t2) combos.push([t1, t2]);
    }
    if (r >= 2 && r <= 8) {
        const t1 = findRank(r - 1);
        const t2 = findRank(r + 1);
        if (t1 && t2) combos.push([t1, t2]);
    }
    if (r <= 7) {
        const t1 = findRank(r + 1);
        const t2 = findRank(r + 2);
        if (t1 && t2) combos.push([t1, t2]);
    }
    return combos;
}

// ============================================================
// クライアント側 和了形・役・聴牌・フリテン判定
// ============================================================

const CLIENT_HONORS = ['east', 'south', 'west', 'north', 'white', 'green', 'red'];
const CLIENT_YAOCHUU = new Set([0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33]);

function tileToIdx(tile) {
    if (!tile) return -1;
    if (tile.suit === 'man') return (tile.rank || 1) - 1;
    if (tile.suit === 'pin') return 9 + ((tile.rank || 1) - 1);
    if (tile.suit === 'sou') return 18 + ((tile.rank || 1) - 1);
    const h = CLIENT_HONORS.indexOf(tile.honorType);
    return h >= 0 ? 27 + h : -1;
}

function isKokushiCounts(counts) {
    let pair = false;
    for (let i = 0; i < 34; i++) {
        if (CLIENT_YAOCHUU.has(i)) {
            if (counts[i] === 0 || counts[i] > 2) return false;
            if (counts[i] === 2) pair = true;
        } else if (counts[i] > 0) {
            return false;
        }
    }
    return pair;
}

function isChitoitsuCounts(counts) {
    let pairs = 0;
    for (let i = 0; i < 34; i++) {
        if (counts[i] === 2) pairs++;
        else if (counts[i] !== 0) return false;
    }
    return pairs === 7;
}

function findDecompositionsClient(counts, targetSets) {
    const results = [];
    function extract(rem, minCode, current) {
        if (rem === 0) {
            results.push([...current]);
            return;
        }
        let first = -1;
        for (let i = 0; i < 34; i++) {
            if (counts[i] > 0) { first = i; break; }
        }
        if (first === -1) return;

        const kCode = first * 2;
        if (counts[first] >= 3 && kCode >= minCode) {
            counts[first] -= 3;
            current.push({ type: 'koutsu', indices: [first, first, first] });
            extract(rem - 1, kCode, current);
            current.pop();
            counts[first] += 3;
        }
        const sCode = first * 2 + 1;
        if (first < 27 && (first % 9) <= 6 && counts[first + 1] > 0 && counts[first + 2] > 0 && sCode >= minCode) {
            counts[first]--; counts[first + 1]--; counts[first + 2]--;
            current.push({ type: 'shuntsu', indices: [first, first + 1, first + 2] });
            extract(rem - 1, sCode, current);
            current.pop();
            counts[first]++; counts[first + 1]++; counts[first + 2]++;
        }
    }

    const allDecomps = [];
    for (let p = 0; p < 34; p++) {
        if (counts[p] >= 2) {
            counts[p] -= 2;
            results.length = 0;
            extract(targetSets, 0, []);
            for (const sets of results) {
                allDecomps.push({ pairIdx: p, sets });
            }
            counts[p] += 2;
        }
    }
    return allDecomps;
}

function isWinningStructureClient(handTiles, melds = []) {
    const expected = 14 - (melds ? melds.length : 0) * 3;
    if (!handTiles || handTiles.length !== expected) return false;
    const counts = new Array(34).fill(0);
    for (const t of handTiles) {
        const idx = tileToIdx(t);
        if (idx < 0) return false;
        counts[idx]++;
    }
    if (!melds || melds.length === 0) {
        if (isKokushiCounts(counts) || isChitoitsuCounts(counts)) return true;
    }
    return findDecompositionsClient(counts, 4 - (melds ? melds.length : 0)).length > 0;
}

function getWinningTileIndicesClient(hand13, melds = []) {
    const expected = 13 - (melds ? melds.length : 0) * 3;
    if (!hand13 || hand13.length !== expected) return [];
    const counts = new Array(34).fill(0);
    for (const t of hand13) {
        const idx = tileToIdx(t);
        if (idx < 0) return [];
        counts[idx]++;
    }
    for (const m of (melds || [])) {
        for (const t of (m.tiles || [])) {
            const idx = tileToIdx(t);
            if (idx >= 0) counts[idx]++;
        }
    }

    const waits = [];
    for (let idx = 0; idx < 34; idx++) {
        if (counts[idx] >= 4) continue;
        const dummy = idx < 9
            ? { suit: 'man', rank: idx + 1 }
            : idx < 18
                ? { suit: 'pin', rank: idx - 8 }
                : idx < 27
                    ? { suit: 'sou', rank: idx - 17 }
                    : { suit: 'honor', honorType: CLIENT_HONORS[idx - 27] };
        if (isWinningStructureClient([...hand13, dummy], melds)) {
            waits.push(idx);
        }
    }
    return waits;
}

function getRiichiDiscardCandidates(hand14, melds = []) {
    if (!hand14 || (melds && melds.some(m => m.type !== 'ankan'))) return [];
    const expected = 14 - (melds ? melds.length : 0) * 3;
    if (hand14.length !== expected) return [];
    const candidates = [];
    for (let i = 0; i < hand14.length; i++) {
        const rem = [...hand14.slice(0, i), ...hand14.slice(i + 1)];
        if (getWinningTileIndicesClient(rem, melds).length > 0) {
            candidates.push(hand14[i]);
        }
    }
    return candidates;
}

function hasAnyYakuClient(hand14, melds, winTile, isTsumo, player, state, chankan = false) {
    const expected = 14 - (melds ? melds.length : 0) * 3;
    if (!hand14 || hand14.length !== expected) return false;
    // 槍槓自体が1飜の役になる (形の確認は呼び出し元が済ませている)
    if (chankan) return true;
    const isMenzen = (melds || []).every(m => m.type === 'ankan');

    const counts = new Array(34).fill(0);
    for (const t of hand14) {
        const idx = tileToIdx(t);
        if (idx < 0) return false;
        counts[idx]++;
    }

    if (isMenzen && (melds || []).length === 0) {
        if (isKokushiCounts(counts) || isChitoitsuCounts(counts)) return true;
    }

    const decomps = findDecompositionsClient(counts, 4 - (melds ? melds.length : 0));
    if (decomps.length === 0) return false;

    // 状況役・門前ツモ・リーチ
    if (player?.riichi?.declared) return true;
    if (isTsumo && isMenzen) return true;
    if (state?.lastDrawWasRinshan && isTsumo) return true;
    if (state?.wall?.length === 0 && state?.deadWall?.length > 0) return true;

    const allTiles = [...hand14];
    for (const m of (melds || [])) allTiles.push(...(m.tiles || []));
    const allIndices = allTiles.map(tileToIdx);

    // 断么九
    if (allIndices.every(i => !CLIENT_YAOCHUU.has(i))) return true;

    // 混一色・清一色・字一色・混老頭・清老頭・緑一色
    const suits = new Set(allIndices.filter(i => i < 27).map(i => Math.floor(i / 9)));
    if (suits.size <= 1) return true;
    if (allIndices.every(i => CLIENT_YAOCHUU.has(i))) return true;

    const roundWindIdx = 27 + CLIENT_HONORS.indexOf(state?.round?.wind || 'east');
    const seatWindIdx = 27 + CLIENT_HONORS.indexOf(player?.seat || 'east');
    const winIdx = tileToIdx(winTile || hand14[hand14.length - 1]);

    const calledSets = (melds || []).map(m => ({
        type: m.type === 'chi' ? 'shuntsu' : 'koutsu',
        indices: (m.tiles || []).map(tileToIdx),
        isConcealed: m.type === 'ankan'
    }));

    for (const d of decomps) {
        const allSets = [...d.sets.map(s => ({ ...s, isConcealed: true })), ...calledSets];
        const shuntsu = allSets.filter(s => s.type === 'shuntsu');
        const koutsu = allSets.filter(s => s.type === 'koutsu');

        // 役牌 (場風・自風・白・發・中)
        if (koutsu.some(k => {
            const idx = k.indices[0];
            return idx === roundWindIdx || idx === seatWindIdx || (idx >= 31 && idx <= 33);
        })) return true;

        // 対々和
        if (koutsu.length === 4) return true;

        // 平和 (門前・4順子・非役牌雀頭・両面待ち)
        if (isMenzen && calledSets.length === 0 && shuntsu.length === 4) {
            const isValPair = d.pairIdx === roundWindIdx || d.pairIdx === seatWindIdx || (d.pairIdx >= 31 && d.pairIdx <= 33);
            if (!isValPair) {
                const hasRyanmen = d.sets.some(s => {
                    if (!s.indices.includes(winIdx)) return false;
                    const [a, b, c] = s.indices;
                    if (winIdx === b) return false;
                    if ((a % 9 === 0 && winIdx === c) || (a % 9 === 6 && winIdx === a)) return false;
                    return true;
                });
                if (hasRyanmen) return true;
            }
        }

        // 一盃口・二盃口
        if (isMenzen && shuntsu.length >= 2) {
            const starts = shuntsu.map(s => s.indices[0]).sort((a, b) => a - b);
            for (let i = 0; i < starts.length - 1; i++) {
                if (starts[i] === starts[i + 1]) return true;
            }
        }

        // 三色同順・一気通貫
        if (shuntsu.length >= 3) {
            const starts = new Set(shuntsu.map(s => s.indices[0]));
            for (let r = 0; r <= 6; r++) {
                if (starts.has(r) && starts.has(r + 9) && starts.has(r + 18)) return true;
            }
            for (const b of [0, 9, 18]) {
                if (starts.has(b) && starts.has(b + 3) && starts.has(b + 6)) return true;
            }
        }

        // 三暗刻・三色同刻
        if (koutsu.length >= 3) {
            const tSet = new Set(koutsu.map(k => k.indices[0]));
            for (let r = 0; r < 9; r++) {
                if (tSet.has(r) && tSet.has(r + 9) && tSet.has(r + 18)) return true;
            }
            const ankou = koutsu.filter(k => k.isConcealed && (isTsumo || k.indices[0] !== winIdx)).length;
            if (ankou >= 3) return true;
        }

        // チャンタ・純チャン
        if (shuntsu.length >= 1 && CLIENT_YAOCHUU.has(d.pairIdx) && allSets.every(s => s.indices.some(i => CLIENT_YAOCHUU.has(i)))) {
            return true;
        }
    }
    return false;
}

function canTsumoWinClient(player, state) {
    if (!player || !canPlayerDiscard(player)) return false;
    const winTile = player.hand[player.hand.length - 1];
    return hasAnyYakuClient(player.hand, player.melds, winTile, true, player, state);
}

function canRonWinClient(player, targetTile, state, chankan = false) {
    if (!player || !targetTile) return false;
    if (player.furiten) return false;
    const waits = getWinningTileIndicesClient(player.hand, player.melds);
    const targetIdx = tileToIdx(targetTile);
    if (!waits.includes(targetIdx)) return false;

    // 捨牌フリテンチェック
    const discardIndices = new Set((player.discards || []).map(tileToIdx));
    if (waits.some(w => discardIndices.has(w))) return false;

    return hasAnyYakuClient([...player.hand, targetTile], player.melds, targetTile, false, player, state, chankan);
}

function getAnkanCandidates(hand) {
    if (!hand || hand.length < 4) return [];
    const counts = {};
    for (const t of hand) {
        const k = getTileKey(t);
        counts[k] = (counts[k] || 0) + 1;
    }
    const ankanKeys = Object.keys(counts).filter(k => counts[k] === 4);
    const result = [];
    const seen = new Set();
    for (const t of hand) {
        const k = getTileKey(t);
        if (ankanKeys.includes(k) && !seen.has(k)) {
            seen.add(k);
            result.push(t);
        }
    }
    return result;
}

function getKakanCandidates(hand, melds) {
    if (!hand || !melds) return [];
    const candidates = [];
    for (const m of melds) {
        if (m.type === 'pon') {
            const pTile = m.tiles[0];
            const match = hand.find(t => 
                t.suit === pTile.suit && 
                t.rank === pTile.rank && 
                t.honorType === pTile.honorType
            );
            if (match && !candidates.some(c => getTileKey(c) === getTileKey(match))) {
                candidates.push(match);
            }
        }
    }
    return candidates;
}

function getDiscarder(state) {
    if (!state?.lastDiscard || !state.players) return null;
    const target = state.lastDiscard;
    for (const p of state.players) {
        const last = p.discards[p.discards.length - 1];
        if (last && (last.id === target.id || (last.suit === target.suit && last.rank === target.rank && last.honorType === target.honorType))) {
            return p.seat;
        }
    }
    return null;
}

// ============================================================
// アクションパネル & アクションボタン生成
// ============================================================

function renderActionPanel(state) {
    const phase = state?.phase ?? 'waiting';
    const current = state?.currentPlayer;
    const isMyTurn = current === App.mySeat;
    const myPlayer = state?.players?.find(p => p.seat === App.mySeat);
    const handSize = myPlayer?.hand?.length ?? 0;

    dom.actionBtns.innerHTML = '';

    const createBtn = (label, actClass, onClick, title = '') => {
        const b = document.createElement('button');
        b.className = `btn-th-act ${actClass}`;
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        dom.actionBtns.appendChild(b);
        return b;
    };

    if (App.waitingCountdownTimer) {
        clearInterval(App.waitingCountdownTimer);
        App.waitingCountdownTimer = null;
    }

    switch (phase) {
        case 'waiting': {
            const players = state?.players || [];
            const humanCount = players.filter(p => p.isOccupied && !p.isNpc).length;
            const infoSpan = document.createElement('span');
            infoSpan.className = 'waiting-player-status';

            const updateCountdownText = () => {
                if (state?.autoStartDeadline) {
                    const remSec = Math.max(0, Math.ceil((state.autoStartDeadline - Date.now()) / 1000));
                    infoSpan.textContent = `対局相手を待機中 (${humanCount}/4人) — あと ${remSec}秒 でNPCを補充して自動開始`;
                } else {
                    infoSpan.textContent = `対局相手を待機中 (${humanCount}/4人) — 4人揃うか1分経過で自動開始`;
                }
            };
            updateCountdownText();
            dom.actionBtns.appendChild(infoSpan);

            if (state?.autoStartDeadline) {
                App.waitingCountdownTimer = setInterval(updateCountdownText, 500);
            }
            break;
        }

        case 'dealing': {
            const infoSpan = document.createElement('span');
            infoSpan.className = 'waiting-player-status';
            infoSpan.textContent = '自動配牌中...';
            dom.actionBtns.appendChild(infoSpan);
            break;
        }

        case 'playing': {
            // G-2: 槍槓確認中はロン/パスのみ (ポン・チー・打牌は不可)
            if (state.pendingKan?.tile) {
                const kanTile = state.pendingKan.tile;
                const kanPlayer = state.pendingKan.player;
                const kanPassed = App.passedDiscardId === kanTile.id;
                if (kanPlayer !== App.mySeat && !kanPassed) {
                    if (canRonWinClient(myPlayer, kanTile, state, true)) {
                        createBtn('ロン', 'act-ron', () => {
                            sendAction({ type: 'RON_DECLARE', player: App.mySeat, tile: kanTile });
                        }, `${MahjongTiles.getTileTitle(kanTile)} で槍槓ロン宣言`);
                    }
                    createBtn('パス', 'act-pass', () => {
                        App.passedDiscardId = kanTile.id;
                        log('action', '槍槓ロンを見送り');
                        sendMsg({ type: 'pass_call' });
                        renderActionPanel(state);
                    }, 'スルーします');
                } else {
                    const infoSpan = document.createElement('span');
                    infoSpan.className = 'waiting-player-status';
                    infoSpan.textContent = '槍槓確認中...';
                    dom.actionBtns.appendChild(infoSpan);
                }
                break;
            }

            // G-1: 九種九牌の宣言ボタン (対象者のみ・最初の打牌まで・誰も鳴いていない場合)
            if ((state.kyuushuEligible || []).includes(App.mySeat) &&
                (myPlayer?.discards || []).length === 0 &&
                !(state.players || []).some(p => (p.melds || []).length > 0)) {
                createBtn('九種九牌', 'act-call', () => {
                    sendAction({ type: 'KYUUSHU_DECLARE', player: App.mySeat });
                }, '九種九牌による流局を宣言します');
            }

            const currentPlayer = state.players?.find(p => p.seat === current);
            const lastTile = state.lastDiscard;
            const discarder = getDiscarder(state);
            const prevSeat = WIND_ORDER[(WIND_ORDER.indexOf(App.mySeat) + 3) % 4];

            // 新しい打牌が出たらパス状態を解除
            if (!lastTile || (App.passedDiscardId && App.passedDiscardId !== lastTile.id)) {
                if (!lastTile) App.passedDiscardId = null;
            }
            const hasPassedThisTile = Boolean(lastTile && App.passedDiscardId === lastTile.id);

            // 1. 他家の直前打牌に対する鳴き（ポン・チー・カン）およびロンの判定
            let callOrRonAvailable = false;
            if (lastTile && discarder && discarder !== App.mySeat && !hasPassedThisTile) {
                if (!App.noMeld && !myPlayer?.riichi?.declared) {
                    const ponAvailable = canPon(myPlayer?.hand, lastTile);
                    const chiCombos = (discarder === prevSeat) ? getChiCombinations(myPlayer?.hand, lastTile) : [];
                    const kanAvailable = canDaiminkan(myPlayer?.hand, lastTile);

                    if (ponAvailable) {
                        callOrRonAvailable = true;
                        createBtn('ポン', 'act-call', () => {
                            sendAction({ type: 'PON', player: App.mySeat, tile: lastTile });
                        }, `${MahjongTiles.getTileTitle(lastTile)} をポン`);
                    }

                    if (chiCombos.length === 1) {
                        callOrRonAvailable = true;
                        createBtn('チー', 'act-call', () => {
                            sendAction({ type: 'CHI', player: App.mySeat, tile: lastTile, meldTiles: chiCombos[0] });
                        }, `${MahjongTiles.getTileTitle(lastTile)} をチー`);
                    } else if (chiCombos.length > 1) {
                        callOrRonAvailable = true;
                        chiCombos.forEach(pair => {
                            const label = `チー (${MahjongTiles.getTileTitle(pair[0])}・${MahjongTiles.getTileTitle(pair[1])})`;
                            createBtn(label, 'act-call', () => {
                                sendAction({ type: 'CHI', player: App.mySeat, tile: lastTile, meldTiles: pair });
                            }, `${MahjongTiles.getTileTitle(lastTile)} を ${label} で鳴く`);
                        });
                    }

                    if (kanAvailable) {
                        callOrRonAvailable = true;
                        createBtn('カン (大明槓)', 'act-call', () => {
                            sendAction({ type: 'KAN', player: App.mySeat, tile: lastTile });
                        }, `${MahjongTiles.getTileTitle(lastTile)} を大明槓`);
                    }
                }

                // ロンボタン (実手牌でロン和了可能かつ非フリテン時のみ表示！)
                if (canRonWinClient(myPlayer, lastTile, state)) {
                    callOrRonAvailable = true;
                    createBtn('ロン', 'act-ron', () => {
                        sendAction({ type: 'RON_DECLARE', player: App.mySeat, tile: lastTile });
                    }, `${MahjongTiles.getTileTitle(lastTile)} でロン宣言`);
                }

                if (callOrRonAvailable) {
                    createBtn('パス', 'act-pass', () => {
                        App.passedDiscardId = lastTile.id;
                        log('action', '鳴き/ロンをパス');
                        sendMsg({ type: 'pass_call' });
                        if (isMyTurn && isPlayerWaitingDraw(myPlayer)) {
                            sendAction({ type: 'DRAW_TILE', player: App.mySeat });
                        } else {
                            renderActionPanel(state);
                        }
                    }, 'スルーします');
                } else if (App.noMeld && lastTile && App.passedDiscardId !== lastTile.id) {
                    // 「鳴きなし」ONでロンもできない場合はサーバーへ自動パス通知を送ってNPCを待たせない
                    App.passedDiscardId = lastTile.id;
                    sendMsg({ type: 'pass_call' });
                }
            }

            // 2. 自家のツモ番（打牌可能時）の暗槓・加槓
            if (isMyTurn && canPlayerDiscard(myPlayer) && !myPlayer?.riichi?.declared) {
                const ankanList = getAnkanCandidates(myPlayer?.hand);
                ankanList.forEach(cand => {
                    createBtn(`暗槓 (${MahjongTiles.getTileTitle(cand)})`, 'act-call', () => {
                        sendAction({ type: 'KAN', player: App.mySeat, tile: cand });
                    });
                });

                const kakanList = getKakanCandidates(myPlayer?.hand, myPlayer?.melds);
                kakanList.forEach(cand => {
                    createBtn(`加槓 (${MahjongTiles.getTileTitle(cand)})`, 'act-call', () => {
                        sendAction({ type: 'KAN', player: App.mySeat, tile: cand });
                    });
                });
            }

            // 3. ツモ待ち (門前13枚、1鳴き10枚、2鳴き7枚...)
            if (currentPlayer && isPlayerWaitingDraw(currentPlayer)) {
                if (isMyTurn) {
                    createBtn('ツモ (牌を引く)', 'act-tsumo',
                        () => sendAction({ type: 'DRAW_TILE', player: App.mySeat }),
                        '山から牌を1枚引きます');
                }
            }

            // 4. ツモ済みまたは鳴き後 → 打牌待ち (門前14枚、1鳴き11枚、2鳴き8枚...)
            if (currentPlayer && canPlayerDiscard(currentPlayer)) {
                if (isMyTurn) {
                    // ツモ和了ボタン (和了可能時のみ表示！)
                    if (canTsumoWinClient(myPlayer, state)) {
                        createBtn('ツモ', 'act-tsumo', () => {
                            const winTile = myPlayer.hand[handSize - 1];
                            sendAction({ type: 'TSUMO_DECLARE', player: App.mySeat, tile: winTile });
                        }, 'ツモ和了を宣言します');
                    }

                    // リーチ宣言ボタン (門前・未リーチ・1000点以上・聴牌になる打牌候補がある時のみ表示！)
                    const canRiichi =
                        !myPlayer?.riichi?.declared &&
                        (myPlayer?.melds || []).every(m => m.type === 'ankan') &&
                        (myPlayer?.score ?? 25000) >= 1000 &&
                        getRiichiDiscardCandidates(myPlayer?.hand, myPlayer?.melds).length > 0;

                    if (canRiichi) {
                        createBtn('立直', 'act-riichi',
                            () => sendAction({ type: 'RIICHI_DECLARE', player: App.mySeat }),
                            '立直を宣言します');
                    }

                    // ツモ切りボタン (手牌の最後の牌を打牌)
                    if (myPlayer?.hand?.length) {
                        const lastInHand = myPlayer.hand[myPlayer.hand.length - 1];
                        createBtn('ツモ切り', 'act-tsumogiri', () => {
                            sendAction({ type: 'DISCARD', player: App.mySeat, tile: lastInHand });
                        }, `${MahjongTiles.getTileTitle(lastInHand)} を打牌`);
                    }
                }
            }
            break;
        }


        case 'ron_declared': {
            // G-4: ロン収集中は追加宣言/パスを受け付ける (確定はサーバーが自動で行う)
            const pending = state.pendingRon;
            const alreadyDeclared = (pending?.declarers || []).some(d => d.wind === App.mySeat);
            if (pending?.tile && !alreadyDeclared && pending.discarder !== App.mySeat &&
                App.passedDiscardId !== pending.tile.id &&
                canRonWinClient(myPlayer, pending.tile, state, Boolean(pending.chankan))) {
                createBtn('ロン', 'act-ron', () => {
                    sendAction({ type: 'RON_DECLARE', player: App.mySeat, tile: pending.tile });
                }, `${MahjongTiles.getTileTitle(pending.tile)} でロン宣言`);
                createBtn('パス', 'act-pass', () => {
                    App.passedDiscardId = pending.tile.id;
                    log('action', 'ロンをパス');
                    sendMsg({ type: 'pass_call' });
                    renderActionPanel(state);
                }, 'スルーします');
            } else {
                const infoSpan = document.createElement('span');
                infoSpan.className = 'waiting-player-status';
                const count = pending?.declarers?.length ?? 0;
                infoSpan.textContent = count > 0 ? `ロン宣言受付中 (${count}人)...` : 'ロン宣言受付中...';
                dom.actionBtns.appendChild(infoSpan);
            }
            break;
        }

        case 'tsumo_declared':
            createBtn('精算へ進む', 'act-tsumo',
                () => sendAction({ type: 'SCORING_COMPLETE' }));
            break;

        case 'scoring':
            createBtn('精算完了', 'act-tsumo',
                () => sendAction({ type: 'SCORING_COMPLETE' }));
            break;

        case 'round_end':
            createBtn('次局へ', 'act-tsumo',
                () => sendAction({ type: 'ROUND_END' }));
            break;

        case 'draw':
            createBtn('局終了へ', 'act-tsumo',
                () => sendAction({ type: 'ROUND_END' }));
            break;

        case 'game_end': {
            const modeLabel = state?.gameLength === 'east' ? '東風戦' : '東南戦';
            const ranked = [...(state?.players || [])].sort((a, b) => (b.score || 0) - (a.score || 0));
            const rankStr = ranked
                .map((p, i) => `${i + 1}位:${p.id}(${(p.score || 0).toLocaleString()}点)`)
                .join(' / ');
            const infoSpan = document.createElement('span');
            infoSpan.className = 'waiting-player-status';
            infoSpan.textContent = `🏆 ${modeLabel}終了 — ${rankStr}`;
            dom.actionBtns.appendChild(infoSpan);

            createBtn('新しい対局へ', 'act-tsumo',
                () => sendAction({ type: 'ROUND_END' }));
            break;
        }
    }

    // 状態更新ボタン
    createBtn('同期', 'act-pass', () => sendMsg({ type: 'get_state' }));
}

// ============================================================
// 自動トグル機能 (自動和了・ツモ切り)
// ============================================================

function handleAutoActions(state) {
    if (!state || state.phase !== 'playing') return;
    const isMyTurn = state.currentPlayer === App.mySeat;
    const myPlayer = state.players?.find(p => p.seat === App.mySeat);
    if (!myPlayer) return;

    // 1. 自動ツモ切り
    if (App.autoTsumogiri && isMyTurn && canPlayerDiscard(myPlayer)) {
        const lastTile = myPlayer.hand[myPlayer.hand.length - 1];
        if (lastTile) {
            log('action', `⚡ 自動ツモ切り実行: ${MahjongTiles.getTileTitle(lastTile)}`);
            setTimeout(() => {
                sendAction({ type: 'DISCARD', player: App.mySeat, tile: lastTile });
            }, 250);
        }
    }
}

// ============================================================
// 手牌クリックによる打牌 & 同種牌ホバーイベント
// ============================================================

document.addEventListener('click', e => {
    const tileEl = e.target.closest('.tenhou-tile');
    if (!tileEl) return;

    const state = App.gameState;
    if (!state || state.phase !== 'playing') return;

    // 自家手牌ゾーン（hand-bottom または drawn-bottom）内の牌かチェック
    const handZone = $('player-area-bottom');
    if (!handZone || !handZone.contains(tileEl)) return;

    const current = state.currentPlayer;
    const myPlayer = state.players?.find(p => p.seat === App.mySeat);
    if (!myPlayer) return;

    // 自分の手番かチェック
    if (current !== App.mySeat) {
        log('error', `今は手番ではありません（現在: ${WIND_KANJI[current] ?? current}家の手番）`);
        return;
    }

    // 打牌可能かチェック (門前14枚、1鳴き11枚、2鳴き8枚、3鳴き5枚、4鳴き2枚)
    if (!canPlayerDiscard(myPlayer)) {
        const meldCount = myPlayer.melds ? myPlayer.melds.length : 0;
        const required = 14 - meldCount * 3;
        log('error', `手牌が${myPlayer.hand.length}枚です (打牌には${required}枚必要)。まず牌をツモってください。`);
        return;
    }


    // 牌IDで検索
    const tileId = tileEl.dataset.tileId;
    let tile = myPlayer.hand.find(t => t.id === tileId);

    // 見つからない場合はDOM順でフォールバック
    if (!tile) {
        const allMyTiles = Array.from(handZone.querySelectorAll('.tenhou-tile.interactive'));
        const idx = allMyTiles.indexOf(tileEl);
        if (idx >= 0 && myPlayer.hand[idx]) {
            tile = myPlayer.hand[idx];
        }
    }

    if (tile) {
        // リーチ後の打牌制限チェック
        if (myPlayer.riichi?.declared) {
            const declIdx = myPlayer.riichi.discardIndex ?? -1;
            const curDiscards = myPlayer.discards ? myPlayer.discards.length : 0;
            if (curDiscards > declIdx) {
                const drawnTile = myPlayer.hand[myPlayer.hand.length - 1];
                if (drawnTile && tile.id !== drawnTile.id) {
                    log('error', 'リーチ後はツモ牌のみ打牌できます');
                    return;
                }
            } else if (curDiscards === declIdx) {
                const candidates = getRiichiDiscardCandidates(myPlayer.hand, myPlayer.melds);
                if (candidates.length > 0 && !candidates.some(c => c.id === tile.id)) {
                    log('error', 'その牌を切ると聴牌にならないため立直宣言牌として選べません');
                    return;
                }
            }
        }
        log('action', `打牌: ${MahjongTiles.getTileTitle(tile)}`);
        sendAction({ type: 'DISCARD', player: App.mySeat, tile });
    }
});

// 同種牌ホバーハイライト
document.addEventListener('mouseover', e => {
    const tileEl = e.target.closest('.tenhou-tile');
    if (!tileEl) {
        if (App.hoveredTileKey) {
            App.hoveredTileKey = null;
            updateSameTileHighlight();
        }
        return;
    }

    const tileType = tileEl.dataset.tileType;
    if (tileType && tileType !== App.hoveredTileKey) {
        App.hoveredTileKey = tileType;
        updateSameTileHighlight();
    }
});

function updateSameTileHighlight() {
    const key = App.hoveredTileKey;
    document.querySelectorAll('.tenhou-tile').forEach(el => {
        if (key && el.dataset.tileType === key) {
            el.classList.add('tile-same-highlight');
        } else {
            el.classList.remove('tile-same-highlight');
        }
    });
}

// ============================================================
// トグルスイッチの変更監視
// ============================================================

dom.toggleAutoWin.addEventListener('change', e => { App.autoWin = e.target.checked; });
dom.toggleNoMeld.addEventListener('change', e => { App.noMeld = e.target.checked; });
dom.toggleAutoTsumogiri.addEventListener('change', e => {
    App.autoTsumogiri = e.target.checked;
    if (App.autoTsumogiri && App.gameState) {
        handleAutoActions(App.gameState);
    }
});
dom.toggleAutoSort.addEventListener('change', e => {
    App.autoSort = e.target.checked;
    if (App.gameState) renderBoard(App.gameState);
});

// ============================================================
// 和了・精算モーダル
// ============================================================

const YAKU_NAMES_JA = {
    riichi: '立直 (リーチ)',
    ippatsu: '一発',
    tsumo: '門前清自摸和',
    tanyao: '断么九 (タンヤオ)',
    pinfu: '平和 (ピンフ)',
    iipeikou: '一盃口 (イーペーコー)',
    bakaze: '役牌: 場風牌',
    jikaze: '役牌: 自風牌',
    haku: '役牌: 白',
    hatsu: '役牌: 發',
    chun: '役牌: 中',
    rinshan: '嶺上開花',
    chankan: '槍槓',
    haitei: '海底摸月',
    houtei: '河底撈魚',
    double_riichi: 'ダブル立直',
    sanshoku_doujun: '三色同順',
    ittsu: '一気通貫',
    chanta: '混全帯么九 (チャンタ)',
    chitoitsu: '七対子 (チートイツ)',
    toitoi: '対々和 (トイトイ)',
    sanankou: '三暗刻',
    sanshoku_doukou: '三色同刻',
    sankantsu: '三槓子',
    honroutou: '混老頭',
    shousangen: '小三元',
    honitsu: '混一色 (ホンイツ)',
    junchanta: '純全帯么九 (ジュンチャン)',
    ryanpeikou: '二盃口 (リャンペーコー)',
    chinitsu: '清一色 (チンイツ)',
    kokushi: '国士無双',
    suuankou: '四暗刻',
    daisangen: '大三元',
    shousuushi: '小四喜',
    daisuushi: '大四喜',
    tsuuiisou: '字一色',
    chinroutou: '清老頭',
    ryuuiisou: '緑一色',
    chuuren: '九蓮宝燈',
    suukantsu: '四槓子',
    tenhou: '天和',
    chiihou: '地和'
};

const LIMIT_NAMES_JA = {
    mangan: '満貫',
    haneman: '跳満',
    baiman: '倍満',
    sanbaiman: '三倍満',
    yakuman: '役満',
    double_yakuman: 'ダブル役満',
    triple_yakuman: 'トリプル役満'
};

function showPaymentResult(payments) {
    if (!payments || !payments.length) return;
    const p = payments[0]; // 最初の和了者
    const winnerSeat = p.winner || 'east';
    const isTsumo = p.winType === 'tsumo';

    dom.resultWinnerTitle.textContent = `${WIND_KANJI[winnerSeat]}家 和了`;
    dom.resultTypeTag.textContent = isTsumo ? 'ツモ和了' : `ロン (${WIND_KANJI[p.fromPlayer] ?? p.fromPlayer}家から)`;

    // 和了手牌の表示 (純手牌 + ロン時の和了牌 + 副露面子)
    dom.resultHandTiles.innerHTML = '';
    const winnerPlayer = App.gameState?.players?.find(pl => pl.seat === winnerSeat);
    if (winnerPlayer?.hand) {
        winnerPlayer.hand.forEach(t => {
            dom.resultHandTiles.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(t, 'md'));
        });
        if (!isTsumo && p.winningTile && !winnerPlayer.hand.some(t => t.id === p.winningTile.id)) {
            dom.resultHandTiles.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(p.winningTile, 'md', 'is-dora'));
        }
    }
    if (winnerPlayer?.melds?.length) {
        winnerPlayer.melds.forEach(m => {
            (m.tiles || []).forEach(t => {
                dom.resultHandTiles.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(t, 'sm'));
            });
        });
    }

    // ドラ表示牌
    dom.resultDoraIndicators.innerHTML = '';
    (App.gameState?.doraIndicators || []).forEach(t => {
        dom.resultDoraIndicators.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(t, 'sm'));
    });

    // 裏ドラ表示牌 (リーチ和了時は表向き公開、非リーチ時は伏せ牌)
    if (dom.resultUraDoraIndicators) {
        dom.resultUraDoraIndicators.innerHTML = '';
        const isRiichiWinner = Boolean(winnerPlayer?.riichi?.declared);
        const uraList = App.gameState?.uraDoraIndicators || [];
        if (isRiichiWinner && uraList.length > 0) {
            uraList.forEach(t => {
                dom.resultUraDoraIndicators.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(t, 'sm'));
            });
        } else {
            dom.resultUraDoraIndicators.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(null, 'sm'));
        }
    }

    // 役一覧の構築 (実手牌評価データから動的生成)
    const handEval = p.handEvaluation;
    const scoreCalc = p.scoreCalculation;
    if (handEval && Array.isArray(handEval.yaku) && handEval.yaku.length > 0) {
        const yakuRows = handEval.yaku.map(y => {
            const name = YAKU_NAMES_JA[y.type] || y.type;
            const hanText = y.isYakuman ? '役満' : `${y.han}飜`;
            return `<div class="yaku-item"><span>${escapeHtml(name)}</span><span class="yaku-han">${hanText}</span></div>`;
        });
        if (!handEval.yakuman) {
            if (handEval.dora > 0) {
                yakuRows.push(`<div class="yaku-item"><span>ドラ</span><span class="yaku-han">${handEval.dora}飜</span></div>`);
            }
            if (handEval.akaDora > 0) {
                yakuRows.push(`<div class="yaku-item"><span>赤ドラ</span><span class="yaku-han">${handEval.akaDora}飜</span></div>`);
            }
            if (handEval.uraDora > 0) {
                yakuRows.push(`<div class="yaku-item"><span>裏ドラ</span><span class="yaku-han">${handEval.uraDora}飜</span></div>`);
            }
        }
        dom.resultYakuList.innerHTML = yakuRows.join('');
    } else {
        dom.resultYakuList.innerHTML = `
            <div class="yaku-item"><span>和了</span><span class="yaku-han">1飜</span></div>
        `;
    }

    if (scoreCalc) {
        dom.resultFuHan.textContent = handEval?.yakuman
            ? '役満'
            : `${scoreCalc.fu}符 ${scoreCalc.han}飜`;
        dom.resultPointTitle.textContent = scoreCalc.limitName
            ? (LIMIT_NAMES_JA[scoreCalc.limitName] || '')
            : '';
        dom.resultPoints.textContent = `${scoreCalc.score.toLocaleString()}点`;

        if (isTsumo) {
            if (scoreCalc.dealerScore) {
                dom.resultPaymentSplit.textContent = `(${scoreCalc.dealerScore.tsumo.toLocaleString()}点オール)`;
            } else if (scoreCalc.nonDealerScore) {
                dom.resultPaymentSplit.textContent = `(${scoreCalc.nonDealerScore.tsumo.toLocaleString()}・${scoreCalc.nonDealerScore.tsumoFromDealer.toLocaleString()})`;
            } else {
                dom.resultPaymentSplit.textContent = '';
            }
        } else {
            dom.resultPaymentSplit.textContent = p.honba ? `(${p.honba}本場加算)` : '';
        }
    } else {
        const wonAmount = p.payments?.[winnerSeat] ?? 0;
        dom.resultFuHan.textContent = '';
        dom.resultPointTitle.textContent = '';
        dom.resultPoints.textContent = `${wonAmount.toLocaleString()}点`;
        dom.resultPaymentSplit.textContent = '';
    }

    dom.resultModal.classList.remove('hidden');
}

dom.resultClose.addEventListener('click', () => {
    dom.resultModal.classList.add('hidden');
    sendAction({ type: 'SCORING_COMPLETE' });
});

dom.resultModal.addEventListener('click', e => {
    if (e.target === dom.resultModal) {
        dom.resultModal.classList.add('hidden');
    }
});

// ============================================================
// ログ表示パネル & デバッグ
// ============================================================

dom.toggleLogBtn.addEventListener('click', () => {
    dom.logDrawer.classList.toggle('hidden');
});

dom.btnCloseLog.addEventListener('click', () => {
    dom.logDrawer.classList.add('hidden');
});

dom.btnClearLog.addEventListener('click', () => {
    dom.eventLog.innerHTML = '';
});

function log(type, message) {
    const time = new Date().toTimeString().slice(0, 8);
    const item = document.createElement('div');
    item.className = 'log-entry';
    item.innerHTML = `<span class="log-time">${time}</span><span class="log-${type}">${escapeHtml(String(message))}</span>`;
    dom.eventLog.appendChild(item);
    dom.eventLog.scrollTop = dom.eventLog.scrollHeight;
    if (dom.eventLog.children.length > 300) {
        dom.eventLog.children[0].remove();
    }
}

dom.btnSendCustom.addEventListener('click', () => {
    const text = dom.customJson.value.trim();
    if (!text) return;
    try {
        sendAction(JSON.parse(text));
        dom.customJson.value = '';
    } catch (e) {
        log('error', `JSONエラー: ${e.message}`);
    }
});

// ============================================================
// UI ヘルパー & 接続画面
// ============================================================

function setStatus(status, text) {
    dom.statusText.textContent = text;
    dom.statusDot.className = `status-dot ${status}`;
}

function showConnectError(msg) {
    dom.connectError.textContent = msg;
    dom.connectError.classList.remove('hidden');
}

function switchScreen(screen) {
    dom.connectScreen.classList.toggle('active', screen === 'connect');
    dom.gameScreen.classList.toggle('active', screen === 'game');
}

function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// 対局形式ラジオボタンの変更連動
document.querySelectorAll('input[name="game-length"]').forEach(radio => {
    radio.addEventListener('change', e => {
        const pill = $('preview-length-pill');
        if (pill) {
            pill.textContent = e.target.value === 'east' ? '東風戦' : '東南戦';
        }
    });
});

// 接続フォーム送信
dom.connectForm.addEventListener('submit', e => {
    e.preventDefault();
    dom.connectError.classList.add('hidden');
    const url = dom.serverUrl.value.trim();
    const roomId = dom.roomId.value.trim();
    const playerId = dom.playerId.value.trim();
    const selectedLengthEl = document.querySelector('input[name="game-length"]:checked');
    const gameLength = selectedLengthEl ? selectedLengthEl.value : 'south';
    if (url && roomId && playerId) {
        connect(url, roomId, playerId, gameLength);
    }
});

dom.disconnectBtn.addEventListener('click', disconnect);

// 初期化
document.addEventListener('DOMContentLoaded', () => {
    switchScreen('connect');
    log('system', 'オンライン麻雀クライアント準備完了');
});

// テスト自動化・デバッグ用公開
window.App = App;
window.sendAction = sendAction;
window.sendMsg = sendMsg;
