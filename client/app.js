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

function connect(url, roomId, playerId) {
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
        sendMsg({ type: 'join_room', roomId, playerId });
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
    // プレイヤーIDから座席を推定 (p1/player1 → east, p2/player2 → south ...)
    const seatMap = {
        p1: 'east', p2: 'south', p3: 'west', p4: 'north',
        player1: 'east', player2: 'south', player3: 'west', player4: 'north',
        '1': 'east', '2': 'south', '3': 'west', '4': 'north',
    };
    App.mySeat = seatMap[msg.playerId] || 'east';
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
    if (state && (state.phase === 'playing' || state.phase === 'waiting' || state.phase === 'dealing')) {
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

            // 純手牌
            main.forEach(tile => {
                const isHovered = App.hoveredTileKey && getTileKey(tile) === App.hoveredTileKey;
                const extra = `interactive${isMyTurn ? ' my-turn' : ''}${isHovered ? ' tile-same-highlight' : ''}`;
                handContainer.insertAdjacentHTML('beforeend', 
                    MahjongTiles.renderTileHtml(tile, 'lg', extra)
                );
            });

            // 打牌待ち牌 (ツモ牌または鳴き直後の牌スロット)
            if (drawn) {
                const isHovered = App.hoveredTileKey && getTileKey(drawn) === App.hoveredTileKey;
                const extra = `interactive my-turn just-drawn${isHovered ? ' tile-same-highlight' : ''}`;
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
    if (!hand || !targetTile || targetTile.suit === 'honor' || typeof targetTile.rank !== 'number') return false;
    const r = targetTile.rank;
    const s = targetTile.suit;
    const has = rank => hand.some(t => t.suit === s && t.rank === rank);

    if (r >= 3 && has(r - 2) && has(r - 1)) return true;
    if (r >= 2 && r <= 8 && has(r - 1) && has(r + 1)) return true;
    if (r <= 7 && has(r + 1) && has(r + 2)) return true;
    return false;
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

    switch (phase) {
        case 'waiting':
            createBtn('局開始', 'act-tsumo', () => sendAction({ type: 'ROUND_START' }));
            break;

        case 'dealing':
            createBtn('配牌完了', 'act-tsumo', () => sendAction({ type: 'DEAL_COMPLETE' }));
            break;

        case 'playing': {
            const currentPlayer = state.players?.find(p => p.seat === current);
            const curHandSize = currentPlayer?.hand?.length ?? 0;
            const lastTile = state.lastDiscard;
            const discarder = getDiscarder(state);
            const prevSeat = WIND_ORDER[(WIND_ORDER.indexOf(App.mySeat) + 3) % 4];

            // 1. 他家の直前打牌に対する鳴き（ポン・チー・カン）の判定
            let meldActionAvailable = false;
            if (lastTile && discarder && discarder !== App.mySeat && !App.noMeld && !myPlayer?.riichi?.declared) {
                const ponAvailable = canPon(myPlayer?.hand, lastTile);
                const chiAvailable = (discarder === prevSeat) && canChi(myPlayer?.hand, lastTile);
                const kanAvailable = canDaiminkan(myPlayer?.hand, lastTile);

                if (ponAvailable) {
                    meldActionAvailable = true;
                    createBtn('ポン', 'act-call', () => {
                        sendAction({ type: 'PON', player: App.mySeat, tile: lastTile });
                    }, `${MahjongTiles.getTileTitle(lastTile)} をポン`);
                }

                if (chiAvailable) {
                    meldActionAvailable = true;
                    createBtn('チー', 'act-call', () => {
                        sendAction({ type: 'CHI', player: App.mySeat, tile: lastTile });
                    }, `${MahjongTiles.getTileTitle(lastTile)} をチー`);
                }

                if (kanAvailable) {
                    meldActionAvailable = true;
                    createBtn('カン (大明槓)', 'act-call', () => {
                        sendAction({ type: 'KAN', player: App.mySeat, tile: lastTile });
                    }, `${MahjongTiles.getTileTitle(lastTile)} を大明槓`);
                }

                // ロンボタン
                createBtn('ロン', 'act-ron', () => {
                    sendAction({ type: 'RON_DECLARE', player: App.mySeat, tile: lastTile });
                }, `${MahjongTiles.getTileTitle(lastTile)} でロン宣言`);

                if (meldActionAvailable) {
                    createBtn('パス', 'act-pass', () => {
                        log('action', '鳴きをパス');
                        sendMsg({ type: 'get_state' });
                    }, '鳴かずにスルー');
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
                } else {
                    // ソロ支援: 他家のツモ進行ボタン
                    createBtn(`${WIND_KANJI[current]} ツモ`, 'act-pass',
                        () => sendAction({ type: 'DRAW_TILE', player: current }));
                }
            }

            // 4. ツモ済みまたは鳴き後 → 打牌待ち (門前14枚、1鳴き11枚、2鳴き8枚...)
            if (currentPlayer && canPlayerDiscard(currentPlayer)) {
                if (isMyTurn) {
                    // ツモ和了ボタン
                    createBtn('ツモ', 'act-tsumo', () => {
                        const winTile = myPlayer.hand[handSize - 1];
                        sendAction({ type: 'TSUMO_DECLARE', player: App.mySeat, tile: winTile });
                    }, 'ツモ和了を宣言します');

                    // リーチ宣言ボタン (門前時のみ)
                    if (!myPlayer?.riichi?.declared && (!myPlayer?.melds || myPlayer.melds.length === 0)) {
                        createBtn('立直', 'act-riichi',
                            () => sendAction({ type: 'RIICHI_DECLARE', player: App.mySeat }),
                            '立直を宣言します');
                    }

                    // ツモ切りボタン (手牌の最後の牌を打牌)
                    if (myPlayer?.hand?.length) {
                        const lastTile = myPlayer.hand[myPlayer.hand.length - 1];
                        createBtn('ツモ切り', 'act-tsumogiri', () => {
                            sendAction({ type: 'DISCARD', player: App.mySeat, tile: lastTile });
                        }, `${MahjongTiles.getTileTitle(lastTile)} を打牌`);
                    }
                } else {
                    // ソロ支援: 他家の打牌進行
                    createBtn(`${WIND_KANJI[current]} 打牌`, 'act-pass', () => {
                        const cPlayer = state.players?.find(p => p.seat === current);
                        if (!cPlayer?.hand?.length) return;
                        const tile = cPlayer.hand[cPlayer.hand.length - 1];
                        sendAction({ type: 'DISCARD', player: current, tile });
                    });
                }
            }

            // 流局ボタン
            createBtn('流局', 'act-pass',
                () => sendAction({ type: 'EXHAUSTIVE_DRAW', drawType: 'wall_exhausted' }));
            break;
        }


        case 'ron_declared':
            createBtn('ロン確定 (単独)', 'act-ron',
                () => sendAction({ type: 'MULTIPLE_RON_RESOLVED', winners: [state.currentPlayer || App.mySeat || 'east'] }));
            break;

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

function showPaymentResult(payments) {
    if (!payments || !payments.length) return;
    const p = payments[0]; // 最初の和了者
    const winnerSeat = p.winner || 'east';
    const isTsumo = p.winType === 'tsumo';

    dom.resultWinnerTitle.textContent = `${WIND_KANJI[winnerSeat]}家 和了`;
    dom.resultTypeTag.textContent = isTsumo ? 'ツモ和了' : `ロン (${WIND_KANJI[p.fromPlayer] ?? p.fromPlayer}家から)`;

    // 和了手牌の表示
    dom.resultHandTiles.innerHTML = '';
    const winnerPlayer = App.gameState?.players?.find(pl => pl.seat === winnerSeat);
    if (winnerPlayer?.hand) {
        winnerPlayer.hand.forEach(t => {
            dom.resultHandTiles.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(t, 'md'));
        });
    }

    // ドラ表示牌
    dom.resultDoraIndicators.innerHTML = '';
    (App.gameState?.doraIndicators || []).forEach(t => {
        dom.resultDoraIndicators.insertAdjacentHTML('beforeend', MahjongTiles.renderTileHtml(t, 'sm'));
    });

    // 役一覧の構築 (シミュレーション役表示)
    dom.resultYakuList.innerHTML = `
        <div class="yaku-item"><span>立直 (リーチ)</span><span class="yaku-han">1飜</span></div>
        <div class="yaku-item"><span>門前清自摸和</span><span class="yaku-han">1飜</span></div>
        <div class="yaku-item"><span>平和 (ピンフ)</span><span class="yaku-han">1飜</span></div>
        <div class="yaku-item"><span>ドラ</span><span class="yaku-han">1飜</span></div>
    `;

    dom.resultFuHan.textContent = '30符 4飜';
    dom.resultPointTitle.textContent = '満貫';
    dom.resultPoints.textContent = isTsumo ? '8,000点' : '8,000点';
    dom.resultPaymentSplit.textContent = isTsumo ? '(2,000・4,000)' : `(${p.honba ? p.honba + '本場加算' : ''})`;

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

// 接続フォーム送信
dom.connectForm.addEventListener('submit', e => {
    e.preventDefault();
    dom.connectError.classList.add('hidden');
    const url = dom.serverUrl.value.trim();
    const roomId = dom.roomId.value.trim();
    const playerId = dom.playerId.value.trim();
    if (url && roomId && playerId) {
        connect(url, roomId, playerId);
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
