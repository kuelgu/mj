/**
 * リーチ麻雀 Webクライアント v2
 * サーバー: ws://localhost:8080
 *
 * ゲームフロー:
 *   waiting → [局開始] → dealing → [配牌完了] → playing
 *   playing: currentPlayer が draw(13枚) or discard(14枚) を繰り返す
 */

'use strict';

// ============================================================
// 牌ユーティリティ
// ============================================================

const TILE_UNICODE = {
    honor: { east: '🀀', south: '🀁', west: '🀂', north: '🀃', white: '🀆', green: '🀅', red: '🀄' },
    man: ['', '🀇', '🀈', '🀉', '🀊', '🀋', '🀌', '🀍', '🀎', '🀏'],
    pin: ['', '🀙', '🀚', '🀛', '🀜', '🀝', '🀞', '🀟', '🀠', '🀡'],
    sou: ['', '🀐', '🀑', '🀒', '🀓', '🀔', '🀕', '🀖', '🀗', '🀘'],
};

function tileChar(tile) {
    if (!tile) return '';
    if (tile.suit === 'honor') return TILE_UNICODE.honor[tile.honorType] ?? '?';
    return (TILE_UNICODE[tile.suit] ?? [])[tile.rank] ?? '?';
}

function tileCls(tile, size = 'lg') {
    if (!tile) return `tile tile-${size} back`;
    const dragon = tile.suit === 'honor' && ['white', 'green', 'red'].includes(tile.honorType) ? ' dragon' : '';
    const red = tile.isRed ? ' red-dora' : '';
    return `tile tile-${size} ${tile.suit}${dragon}${red}`;
}

function tileHtml(tile, size = 'lg', extra = '') {
    const cls = tileCls(tile, size);
    const char = tile ? tileChar(tile) : '';
    const title = attr(tileTitle(tile));
    const id = tile?.id ?? '';
    return `<div class="${cls}${extra ? ' ' + extra : ''}" title="${title}" data-tile-id="${id}">${char}</div>`;
}

function tileTitle(tile) {
    if (!tile) return '裏向き';
    if (tile.suit === 'honor')
        return ({ east: '東', south: '南', west: '西', north: '北', white: '白', green: '発', red: '中' })[tile.honorType] ?? tile.honorType;
    const S = { man: '萬', pin: '筒', sou: '索' };
    const K = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    return `${tile.isRed ? '赤' : ''}${K[tile.rank]}${S[tile.suit]}`;
}

const WIND_K = { east: '東', south: '南', west: '西', north: '北' };
const PHASE_NAMES = {
    waiting: '待機中', dealing: '配牌中', playing: 'プレイ中',
    ron_declared: 'ロン宣言', tsumo_declared: 'ツモ宣言',
    draw: '流局', scoring: '精算中', round_end: '局終了', game_end: 'ゲーム終了',
};
const PHASE_CSS = {
    playing: 'phase-playing', ron_declared: 'phase-ron', tsumo_declared: 'phase-tsumo',
    scoring: 'phase-scoring', draw: 'phase-draw', round_end: 'phase-end', game_end: 'phase-end',
};

// ============================================================
// 理牌 (手牌ソート)
// ============================================================

const SUIT_ORDER = { man: 0, pin: 1, sou: 2, honor: 3 };
const HONOR_ORDER = { east: 0, south: 1, west: 2, north: 3, white: 4, green: 5, red: 6 };

/** 手牌を理牌する。14枚目は末尾(ツモ牌)として固定 */
function sortHand(hand) {
    if (!hand || hand.length === 0) return { sorted: [], drawnTile: null };
    const drawnTile = hand.length === 14 ? hand[hand.length - 1] : null;
    const toSort = drawnTile ? hand.slice(0, 13) : [...hand];
    toSort.sort((a, b) => {
        const sa = SUIT_ORDER[a.suit] ?? 9;
        const sb = SUIT_ORDER[b.suit] ?? 9;
        if (sa !== sb) return sa - sb;
        if (a.suit === 'honor')
            return (HONOR_ORDER[a.honorType] ?? 9) - (HONOR_ORDER[b.honorType] ?? 9);
        return (a.rank ?? 0) - (b.rank ?? 0);
    });
    return { sorted: drawnTile ? [...toSort, drawnTile] : toSort, drawnTile };
}

// ============================================================
// アプリ状態
// ============================================================

const App = {
    ws: null,
    connected: false,
    roomId: null,
    playerId: null,
    gameState: null,
    mySeat: null,   // 'east'|'south'|'west'|'north'
};

// ============================================================
// DOM
// ============================================================

const $ = id => document.getElementById(id);
const dom = {
    connectScreen: $('connect-screen'),
    gameScreen: $('game-screen'),
    connectForm: $('connect-form'),
    serverUrl: $('server-url'),
    roomId: $('room-id'),
    playerId: $('player-id'),
    connectError: $('connect-error'),
    statusDot: document.querySelector('#conn-status .status-dot'),
    statusText: $('conn-status-text'),
    headerRoom: $('header-room-info'),
    disconnectBtn: $('disconnect-btn'),
    roundWind: $('round-wind-display'),
    roundNum: $('round-number-display'),
    honba: $('honba-display'),
    riichiSticks: $('riichi-sticks-display'),
    wallCount: $('wall-count'),
    phaseBadge: $('phase-badge'),
    doraArea: $('dora-indicators'),
    actionBtns: $('action-buttons'),
    customJson: $('custom-event-json'),
    btnSendCustom: $('btn-send-custom'),
    eventLog: $('event-log'),
    btnClearLog: $('btn-clear-log'),
    resultModal: $('result-modal'),
    resultIcon: $('result-icon'),
    resultTitle: $('result-title'),
    resultDetails: $('result-details'),
    resultClose: $('result-close'),
};

// 座席 → 画面上の位置 (自分を下=bottomに固定)
function pos(seat) {
    const seats = ['east', 'south', 'west', 'north'];
    const rel = ((seats.indexOf(seat) - seats.indexOf(App.mySeat ?? 'east')) + 4) % 4;
    return ['bottom', 'right', 'top', 'left'][rel];
}

// ============================================================
// WebSocket
// ============================================================

function connect(url, roomId, playerId) {
    setStatus('connecting', '接続中...');
    log('system', `${url} に接続中...`);
    try { App.ws = new WebSocket(url); }
    catch (e) { showErr(`接続失敗: ${e.message}`); return; }

    App.ws.onopen = () => {
        App.connected = true;
        App.roomId = roomId;
        App.playerId = playerId;
        setStatus('connected', '接続済み');
        log('system', '接続しました');
        send({ type: 'join_room', roomId, playerId });
    };
    App.ws.onmessage = e => {
        try { onServerMsg(JSON.parse(e.data)); }
        catch (ex) { log('error', `解析エラー: ${ex.message}`); }
    };
    App.ws.onclose = () => {
        App.connected = false;
        setStatus('disconnected', '切断');
        log('system', '切断されました');
    };
    App.ws.onerror = () => {
        if (!App.connected) showErr('サーバーに接続できませんでした。');
    };
}

function disconnect() {
    App.ws?.close();
    Object.assign(App, { ws: null, connected: false, gameState: null, mySeat: null });
    switchScreen('connect');
}

function send(msg) {
    if (App.ws?.readyState === WebSocket.OPEN) App.ws.send(JSON.stringify(msg));
    else log('error', '未接続');
}

function action(event) {
    log('action', `→ ${event.type}${event.player ? ' (' + WIND_K[event.player] + ')' : ''}`);
    send({ type: 'game_action', event });
}

// ============================================================
// サーバーメッセージ処理
// ============================================================

function onServerMsg(msg) {
    switch (msg.type) {
        case 'joined': onJoined(msg); break;
        case 'game_update': onGameUpdate(msg); break;
        case 'state': onState(msg.state); break;
        case 'error': log('error', `❌ ${msg.error}`); break;
        default: log('system', `? ${msg.type}`);
    }
}

function onJoined(msg) {
    // プレイヤーIDから座席を決定 (p1→east, p2→south, p3→west, p4→north)
    // フォールバック: player1→east, player2→south...
    const seatMap = {
        p1: 'east', p2: 'south', p3: 'west', p4: 'north',
        player1: 'east', player2: 'south', player3: 'west', player4: 'north',
        '1': 'east', '2': 'south', '3': 'west', '4': 'north',
    };
    App.mySeat = seatMap[msg.playerId] ?? 'east';
    dom.headerRoom.textContent = `${msg.roomId} / ${msg.playerId} (${WIND_K[App.mySeat]})`;
    log('system', `参加完了 → 席: ${WIND_K[App.mySeat]}`);
    switchScreen('game');
    send({ type: 'get_state' });
}

function onGameUpdate(msg) {
    let latest = null;
    for (const m of (msg.messages ?? [])) {
        switch (m.type) {
            case 'game_event': log('game-event', `📋 ${m.event}`); break;
            case 'branching_point': log('branching', `⚡ ${m.branchingPoint}`); break;
            case 'state_update': latest = m.state; log('state-update', `🔄 → ${PHASE_NAMES[m.state.phase] ?? m.state.phase}`); break;
            case 'payment': showPayment(m.payments); break;
            case 'error': log('error', `❌ ${m.error}`); break;
        }
    }
    if (latest) applyState(latest);
}

function onState(state) {
    log('state-update', `📊 状態取得`);
    applyState(state);
}

// ============================================================
// 状態適用 & UI描画
// ============================================================

function applyState(state) {
    App.gameState = state;
    render(state);
    renderActionPanel(state);
}

function render(state) {
    if (!state) return;

    // ヘッダー
    const wk = WIND_K;
    dom.roundWind.textContent = wk[state.round?.wind] ?? '--';
    dom.roundNum.textContent = state.round?.number ?? '--';
    dom.honba.textContent = state.honba ?? 0;
    dom.riichiSticks.textContent = state.riichiSticks ?? 0;
    dom.wallCount.textContent = state.wall?.length ?? '--';

    // フェーズバッジ
    const phase = state.phase ?? 'waiting';
    dom.phaseBadge.textContent = PHASE_NAMES[phase] ?? phase;
    dom.phaseBadge.className = 'phase-badge ' + (PHASE_CSS[phase] ?? '');

    // ドラ
    dom.doraArea.innerHTML = '';
    const doras = state.doraIndicators ?? [];
    if (doras.length) doras.forEach(t => dom.doraArea.insertAdjacentHTML('beforeend', tileHtml(t, 'sm', 'is-dora')));
    else dom.doraArea.insertAdjacentHTML('beforeend', tileHtml(null, 'sm'));

    // 王牌
    const deadWallEl = $('dead-wall-tiles');
    if (deadWallEl) {
        deadWallEl.innerHTML = '';
        const dw = state.deadWall ?? [];
        // 先頭4枚だけ表示（スペース節約）、残りは枚数表示
        dw.slice(0, 4).forEach(t => deadWallEl.insertAdjacentHTML('beforeend', tileHtml(t, 'xs')));
        if (dw.length > 4) {
            const rest = document.createElement('span');
            rest.className = 'dead-wall-rest';
            rest.textContent = `+${dw.length - 4}`;
            deadWallEl.appendChild(rest);
        }
    }

    // プレイヤー描画
    const inGame = !['waiting'].includes(phase);
    (state.players ?? []).forEach(p => renderPlayer(p, state, inGame));

    // 現在プレイヤーハイライト
    ['bottom', 'top', 'left', 'right'].forEach(position =>
        $(`player-area-${position}`)?.classList.remove('current-turn'));
    if (state.currentPlayer) {
        $(`player-area-${pos(state.currentPlayer)}`)?.classList.add('current-turn');
    }
}

function renderPlayer(player, state, inGame) {
    const position = pos(player.seat);
    const isMe = position === 'bottom';

    // プレイヤー情報帯
    const wEl = $(`player-wind-${position}`);
    const nEl = $(`player-name-${position}`);
    const sEl = $(`player-score-${position}`);
    const rEl = $(`riichi-badge-${position}`);
    if (wEl) wEl.textContent = WIND_K[player.seat] ?? player.seat;
    if (nEl) nEl.textContent = player.id;
    if (sEl) sEl.textContent = (player.score?.toLocaleString() ?? '0') + '点';
    if (rEl) rEl.classList.toggle('hidden', !player.riichi?.declared);

    // 手牌
    const handEl = $(`hand-${position}`);
    if (handEl) {
        handEl.innerHTML = '';
        const hand = player.hand ?? [];
        const phase = state.phase;
        const isMyTurn = state.currentPlayer === player.seat;

        if (isMe && hand.length > 0) {
            // 自分の手牌: 理牌して表向き表示。ツモ牌は末尾に金色強調
            const { sorted, drawnTile } = sortHand(hand);
            sorted.forEach((tile) => {
                const isDrawn = drawnTile && tile.id === drawnTile.id;
                const extra = `interactive${isMyTurn ? ' my-turn' : ''}${isDrawn ? ' just-drawn' : ''}`;
                handEl.insertAdjacentHTML('beforeend', tileHtml(tile, 'lg', extra));
            });
        } else if (!isMe && inGame) {
            // 他家: 手牌枚数分だけ裏牌
            const count = hand.length > 0 ? hand.length : (phase === 'playing' ? 13 : 0);
            for (let i = 0; i < count; i++)
                handEl.insertAdjacentHTML('beforeend', tileHtml(null, 'sm'));
        }

        // 副露
        (player.melds ?? []).forEach(meld => {
            const meldEl = document.createElement('div');
            meldEl.className = 'meld';
            (meld.tiles ?? []).forEach(t => meldEl.insertAdjacentHTML('beforeend', tileHtml(t, 'sm')));
            const meldWrap = handEl.querySelector('.melds-area') ?? (() => {
                const d = document.createElement('div');
                d.className = 'melds-area';
                handEl.appendChild(d);
                return d;
            })();
            meldWrap.appendChild(meldEl);
        });
    }

    // 捨て牌
    const dEl = $(`discards-${position}`);
    if (dEl) {
        dEl.innerHTML = '';
        (player.discards ?? []).forEach((tile, i) => {
            const rot = player.riichi?.declared && player.riichi.turn !== null && i === player.riichi.turn ? 'rotated' : '';
            dEl.insertAdjacentHTML('beforeend', tileHtml(tile, 'xs', rot));
        });
    }
}

// ============================================================
// アクションパネル (フェーズ・ターン連動)
// ============================================================

function renderActionPanel(state) {
    const phase = state?.phase ?? 'waiting';
    const current = state?.currentPlayer;
    const isMyTurn = current === App.mySeat;
    const myPlayer = state?.players?.find(p => p.seat === App.mySeat);
    const handSize = myPlayer?.hand?.length ?? 0;

    // ボタンリストをクリアして再構築
    dom.actionBtns.innerHTML = '';

    const addBtn = (label, cls, onClick, title = '') => {
        const b = document.createElement('button');
        b.className = `btn ${cls}`;
        b.textContent = label;
        if (title) b.title = title;
        b.addEventListener('click', onClick);
        dom.actionBtns.appendChild(b);
        return b;
    };

    switch (phase) {
        case 'waiting':
            addBtn('局開始', 'btn-action btn-success', () => action({ type: 'ROUND_START' }));
            break;

        case 'dealing':
            addBtn('配牌完了', 'btn-action btn-success', () => action({ type: 'DEAL_COMPLETE' }));
            break;

        case 'playing': {
            const currentPlayer = state.players?.find(p => p.seat === current);
            const curHandSize = currentPlayer?.hand?.length ?? 0;

            // 現在プレイヤー表示
            const badge = document.createElement('span');
            badge.className = 'turn-badge';
            badge.textContent = `${WIND_K[current] ?? current}のターン`;
            dom.actionBtns.appendChild(badge);

            // ツモ待ち (13枚) → 牌を引く
            if (curHandSize === 13) {
                addBtn(`牌を引く (${WIND_K[current]})`, 'btn-action btn-primary',
                    () => action({ type: 'DRAW_TILE', player: current }),
                    `${WIND_K[current]}が山から1枚ツモる`);
            }

            // ツモ済み (14枚) → 打牌待ち (自分のターンなら手牌クリックで、それ以外はボタン)
            if (curHandSize === 14) {
                if (isMyTurn) {
                    const hint = document.createElement('span');
                    hint.className = 'action-hint';
                    hint.textContent = '手牌をクリックして打牌';
                    dom.actionBtns.appendChild(hint);
                    // ツモ和了ボタン
                    addBtn('ツモ', 'btn-action btn-danger',
                        () => action({ type: 'TSUMO_DECLARE', player: App.mySeat, tile: myPlayer.hand[handSize - 1] }),
                        'ツモ和了を宣言');
                } else {
                    // 他家の打牌をシミュレート: ランダムに1枚捨てる
                    addBtn(`打牌 (${WIND_K[current]})`, 'btn-action',
                        () => {
                            const cPlayer = state.players?.find(p => p.seat === current);
                            if (!cPlayer?.hand?.length) return;
                            // 最後の牌を捨てる（ツモ切り）
                            const tile = cPlayer.hand[cPlayer.hand.length - 1];
                            action({ type: 'DISCARD', player: current, tile });
                        },
                        `${WIND_K[current]}がツモ切り`);
                }
            }

            // 流局ボタン
            addBtn('流局', 'btn-action btn-danger btn-sm',
                () => action({ type: 'EXHAUSTIVE_DRAW', drawType: 'wall_exhausted' }));
            break;
        }

        case 'ron_declared':
            // ダブロン・トリロンのシミュレーション用
            addBtn('ロン解決 (単独)', 'btn-action btn-success',
                () => {
                    const winner = state.lastDiscard ? state.currentPlayer : (App.mySeat ?? 'east');
                    action({ type: 'MULTIPLE_RON_RESOLVED', winners: [App.mySeat ?? 'east'] });
                });
            break;

        case 'tsumo_declared':
            // scoring へ自動遷移 (サーバーが処理)
            addBtn('精算へ', 'btn-action btn-success',
                () => action({ type: 'SCORING_COMPLETE' }));
            break;

        case 'scoring':
            addBtn('精算完了', 'btn-action btn-success',
                () => action({ type: 'SCORING_COMPLETE' }));
            break;

        case 'round_end':
            addBtn('次の局へ', 'btn-action btn-success',
                () => action({ type: 'ROUND_END' }));
            break;

        case 'draw':
            addBtn('局終了へ', 'btn-action',
                () => action({ type: 'ROUND_END' }));
            break;
    }

    // 常時表示
    addBtn('状態取得', 'btn-ghost btn-sm', () => send({ type: 'get_state' }));
}

// ============================================================
// 手牌クリックで打牌
// ============================================================

document.addEventListener('click', e => {
    if (!e.target.classList.contains('interactive')) return;
    const state = App.gameState;
    if (state?.phase !== 'playing') return;

    const current = state?.currentPlayer;
    if (!current) return;

    // ソロテスト: 現在のプレイヤーが誰でも、その hand-bottom の牌をクリックで打牌
    // (App.mySeatのプレイヤーか、currentPlayerの手牌エリアのどちらでも)
    const tileId = e.target.dataset.tileId;
    if (!tileId) return;

    // クリックされた牌がどのプレイヤーの手牌か確認
    // hand-bottom エリアの interactive 牌 → currentPlayer の打牌とみなす
    const handBottom = $('hand-bottom');
    if (!handBottom?.contains(e.target)) return;

    const currentPlayerData = state.players?.find(p => p.seat === current);
    if (!currentPlayerData) return;

    // data-tile-id で牌を特定
    const tile = currentPlayerData.hand?.find(t => t.id === tileId);
    if (!tile) {
        // IDが一致しない場合は手牌インデックスでフォールバック
        const tiles = Array.from(handBottom.querySelectorAll('.interactive'));
        const idx = tiles.indexOf(e.target);
        const fallback = currentPlayerData.hand?.[idx];
        if (!fallback) { log('error', `打牌エラー: 牌が見つかりません (${tileId})`); return; }
        action({ type: 'DISCARD', player: current, tile: fallback });
        return;
    }

    action({ type: 'DISCARD', player: current, tile });
});

// ============================================================
// カスタムイベント送信
// ============================================================

dom.btnSendCustom.addEventListener('click', () => {
    const raw = dom.customJson.value.trim();
    if (!raw) return;
    try {
        action(JSON.parse(raw));
        dom.customJson.value = '';
    } catch (e) {
        log('error', `JSON解析エラー: ${e.message}`);
    }
});

dom.customJson.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) dom.btnSendCustom.click();
});

// ============================================================
// ログ
// ============================================================

function log(type, message) {
    const time = new Date().toTimeString().slice(0, 8);
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML =
        `<span class="log-time">${time}</span>` +
        `<span class="log-event log-${type}">${html(String(message))}</span>`;
    dom.eventLog.appendChild(entry);
    dom.eventLog.scrollTop = dom.eventLog.scrollHeight;
    if (dom.eventLog.children.length > 500) dom.eventLog.children[0].remove();
}

dom.btnClearLog.addEventListener('click', () => dom.eventLog.innerHTML = '');

// ============================================================
// モーダル
// ============================================================

function showPayment(payments) {
    if (!payments?.length) return;
    let details = '';
    payments.forEach(p => {
        details += `<strong>${WIND_K[p.winner] ?? p.winner} 和了</strong><br>`;
        details += p.winType === 'tsumo' ? 'ツモ和了<br>' : `ロン (${WIND_K[p.fromPlayer] ?? p.fromPlayer}から)<br>`;
        details += `本場:${p.honba} / 供託:${p.riichiSticksWon}<br><br>`;
    });
    dom.resultIcon.textContent = '🎉';
    dom.resultTitle.textContent = '和了!';
    dom.resultDetails.innerHTML = details || '詳細なし';
    dom.resultModal.classList.remove('hidden');
}

dom.resultClose.addEventListener('click', () => dom.resultModal.classList.add('hidden'));
dom.resultModal.addEventListener('click', e => { if (e.target === dom.resultModal) dom.resultModal.classList.add('hidden'); });

// ============================================================
// UIヘルパー
// ============================================================

function setStatus(status, text) {
    dom.statusText.textContent = text;
    dom.statusDot.className = 'status-dot ' + status;
}

function showErr(msg) {
    dom.connectError.textContent = msg;
    dom.connectError.classList.remove('hidden');
}

function switchScreen(screen) {
    dom.connectScreen.classList.toggle('active', screen === 'connect');
    dom.gameScreen.classList.toggle('active', screen === 'game');
}

function html(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function attr(s) { return String(s).replace(/"/g, '&quot;'); }

// ============================================================
// 接続フォーム
// ============================================================

dom.connectForm.addEventListener('submit', e => {
    e.preventDefault();
    dom.connectError.classList.add('hidden');
    const url = dom.serverUrl.value.trim();
    const roomId = dom.roomId.value.trim();
    const playerId = dom.playerId.value.trim();
    if (url && roomId && playerId) connect(url, roomId, playerId);
});

dom.disconnectBtn.addEventListener('click', disconnect);

// ============================================================
// 起動
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
    switchScreen('connect');
    log('system', 'クライアント初期化完了');
});
