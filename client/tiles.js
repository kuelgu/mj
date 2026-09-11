/**
 * オンライン麻雀 麻雀牌グラフィックレンダラー
 * 
 * SVGとCSSを駆使し、解像度に依存しない極めてクリスプで美しい牌を描画します。
 * - 萬子 (1m-9m, 赤5m)
 * - 筒子 (1p-9p, 赤5p)
 * - 索子 (1s-9s, 赤5s)
 * - 字牌 (東, 南, 西, 北, 白, 發, 中)
 * - 伝統の黄色竹背 (伏せ牌)
 * - リーチ棒 (1000点棒)
 */

'use strict';

const MahjongTiles = (() => {

    // 漢字データ
    const KANJI_NUMS = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

    /**
     * 萬子 (Man) の SVG グラフィック生成
     */
    function createManSvg(rank, isRed) {
        const numColor = isRed ? '#e52521' : (rank === 7 ? '#d92b2b' : '#1a1a1a');
        const manColor = isRed ? '#e52521' : '#c82828';
        const kanji = KANJI_NUMS[rank] || '';

        return `
        <svg viewBox="0 0 60 84" class="tile-face-svg" xmlns="http://www.w3.org/2000/svg">
            <text x="30" y="36" text-anchor="middle" dominant-baseline="central" 
                  font-family="'Noto Serif JP', 'Yu Mincho', serif" font-weight="900" 
                  font-size="${rank === 1 ? '34' : '30'}" fill="${numColor}">${kanji}</text>
            <text x="30" y="65" text-anchor="middle" dominant-baseline="central" 
                  font-family="'Noto Serif JP', 'Yu Mincho', serif" font-weight="900" 
                  font-size="28" fill="${manColor}">萬</text>
        </svg>`;
    }

    /**
     * 筒子 (Pin) のピン（円文様）SVGパーツ
     */
    function pinCircle(cx, cy, r, color = '#1a5fb4', centerColor = '#e52521') {
        const strokeW = r * 0.22;
        return `
        <g>
            <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeW}"/>
            <circle cx="${cx}" cy="${cy}" r="${r * 0.45}" fill="${centerColor}"/>
            <circle cx="${cx}" cy="${cy}" r="${r * 0.15}" fill="#ffffff"/>
        </g>`;
    }

    /**
     * 筒子 (Pin) の SVG グラフィック生成
     */
    function createPinSvg(rank, isRed) {
        const cBlue = '#155bb5';
        const cRed = '#d92525';
        const cGreen = '#1f8b4c';

        let inner = '';

        if (rank === 1) {
            // 一筒: 大きな花紋様
            const cColor = isRed ? cRed : cGreen;
            inner = `
                <circle cx="30" cy="42" r="21" fill="none" stroke="${cColor}" stroke-width="3"/>
                <circle cx="30" cy="42" r="16" fill="none" stroke="${cRed}" stroke-width="2" stroke-dasharray="3,2"/>
                <circle cx="30" cy="42" r="11" fill="${cRed}"/>
                <circle cx="30" cy="42" r="6" fill="#ffffff"/>
                <circle cx="30" cy="42" r="3" fill="${cRed}"/>
                ${[0, 45, 90, 135, 180, 225, 270, 315].map(deg => {
                    const rad = deg * Math.PI / 180;
                    const x = 30 + Math.cos(rad) * 17;
                    const y = 42 + Math.sin(rad) * 17;
                    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.2" fill="${cBlue}"/>`;
                }).join('')}
            `;
        } else if (rank === 2) {
            inner = pinCircle(30, 24, 12, cBlue, cGreen) + pinCircle(30, 60, 12, cBlue, cGreen);
        } else if (rank === 3) {
            inner = pinCircle(18, 20, 10, cBlue, cGreen) + 
                    pinCircle(30, 42, 10, isRed ? cRed : cRed, isRed ? '#fff' : cBlue) + 
                    pinCircle(42, 64, 10, cBlue, cGreen);
        } else if (rank === 4) {
            inner = pinCircle(20, 24, 10, cBlue, cGreen) + pinCircle(40, 24, 10, cBlue, cGreen) +
                    pinCircle(20, 60, 10, cBlue, cGreen) + pinCircle(40, 60, 10, cBlue, cGreen);
        } else if (rank === 5) {
            const centerColor = isRed ? cRed : cRed;
            const centerInner = isRed ? '#ffffff' : cBlue;
            inner = pinCircle(18, 22, 9, cBlue, cGreen) + pinCircle(42, 22, 9, cBlue, cGreen) +
                    pinCircle(30, 42, 10, centerColor, centerInner) +
                    pinCircle(18, 62, 9, cBlue, cGreen) + pinCircle(42, 62, 9, cBlue, cGreen);
        } else if (rank === 6) {
            inner = pinCircle(20, 20, 9, cGreen, cRed) + pinCircle(40, 20, 9, cGreen, cRed) +
                    pinCircle(20, 43, 9, cRed, cBlue) + pinCircle(40, 43, 9, cRed, cBlue) +
                    pinCircle(20, 66, 9, cRed, cBlue) + pinCircle(40, 66, 9, cRed, cBlue);
        } else if (rank === 7) {
            inner = pinCircle(16, 18, 7.5, cGreen, cRed) + 
                    pinCircle(30, 26, 7.5, cGreen, cRed) + 
                    pinCircle(44, 34, 7.5, cGreen, cRed) +
                    pinCircle(20, 52, 8.5, cRed, cBlue) + pinCircle(40, 52, 8.5, cRed, cBlue) +
                    pinCircle(20, 69, 8.5, cRed, cBlue) + pinCircle(40, 69, 8.5, cRed, cBlue);
        } else if (rank === 8) {
            inner = pinCircle(20, 16, 7.5, cBlue, cGreen) + pinCircle(40, 16, 7.5, cBlue, cGreen) +
                    pinCircle(20, 33, 7.5, cBlue, cGreen) + pinCircle(40, 33, 7.5, cBlue, cGreen) +
                    pinCircle(20, 51, 7.5, cBlue, cGreen) + pinCircle(40, 51, 7.5, cBlue, cGreen) +
                    pinCircle(20, 68, 7.5, cBlue, cGreen) + pinCircle(40, 68, 7.5, cBlue, cGreen);
        } else if (rank === 9) {
            inner = pinCircle(17, 20, 8, cBlue, cGreen) + pinCircle(30, 20, 8, cBlue, cGreen) + pinCircle(43, 20, 8, cBlue, cGreen) +
                    pinCircle(17, 42, 8, cRed, cBlue)   + pinCircle(30, 42, 8, cRed, cBlue)   + pinCircle(43, 42, 8, cRed, cBlue) +
                    pinCircle(17, 64, 8, cGreen, cRed) + pinCircle(30, 64, 8, cGreen, cRed) + pinCircle(43, 64, 8, cGreen, cRed);
        }

        return `
        <svg viewBox="0 0 60 84" class="tile-face-svg" xmlns="http://www.w3.org/2000/svg">
            ${inner}
        </svg>`;
    }

    /**
     * 索子 (Sou) の竹節パーツ
     */
    function souStick(x, y, h, isRed = false) {
        const color = isRed ? '#e52521' : '#1f8b4c';
        const midH = h * 0.42;
        const w = 5.5;
        return `
        <g transform="translate(${x - w/2}, ${y})">
            <rect x="0" y="0" width="${w}" height="${midH}" rx="1.5" fill="${color}"/>
            <circle cx="${w/2}" cy="${midH * 0.5}" r="1.2" fill="#fff"/>
            <rect x="0" y="${midH + 2}" width="${w}" height="${midH}" rx="1.5" fill="${color}"/>
            <circle cx="${w/2}" cy="${midH + 2 + midH * 0.5}" r="1.2" fill="#fff"/>
            <rect x="-0.8" y="${midH}" width="${w + 1.6}" height="2" rx="0.5" fill="${isRed ? '#fff' : '#b22222'}"/>
        </g>`;
    }

    /**
     * 索子 (Sou) の SVG グラフィック生成
     */
    function createSouSvg(rank, isRed) {
        let inner = '';

        if (rank === 1) {
            // 一索: 鳳凰 / 孔雀の精緻なシンボル
            const bColor = isRed ? '#e52521' : '#188243';
            const fColor = isRed ? '#ff6666' : '#d92525';
            inner = `
            <g transform="translate(30, 42) scale(0.95)">
                <!-- 尾羽 -->
                <path d="M-18,-24 C-10,-35 10,-35 18,-24 C22,-12 16,5 12,12 C8,18 0,26 0,32 C0,26 -8,18 -12,12 C-16,5 -22,-12 -18,-24 Z" 
                      fill="none" stroke="${bColor}" stroke-width="2.5"/>
                <circle cx="-10" cy="-20" r="3" fill="${fColor}"/>
                <circle cx="0" cy="-25" r="3.5" fill="${fColor}"/>
                <circle cx="10" cy="-20" r="3" fill="${fColor}"/>
                <!-- 胴体 -->
                <ellipse cx="0" cy="4" rx="7" ry="14" fill="${bColor}"/>
                <!-- 頭部 & 冠羽 -->
                <circle cx="0" cy="-14" r="5" fill="${bColor}"/>
                <polygon points="0,-16 4,-12 0,-9 -4,-12" fill="${fColor}"/>
                <polygon points="0,-19 2,-25 -2,-25" fill="${fColor}"/>
                <!-- 目・嘴 -->
                <circle cx="-1.5" cy="-15" r="0.8" fill="#fff"/>
                <polygon points="0,-14 6,-13 0,-11" fill="#e5a125"/>
                <!-- 翼・足 -->
                <path d="M-6,4 Q-14,8 -8,16" fill="none" stroke="${bColor}" stroke-width="2"/>
                <path d="M6,4 Q14,8 8,16" fill="none" stroke="${bColor}" stroke-width="2"/>
                <line x1="-3" y1="18" x2="-4" y2="28" stroke="#333" stroke-width="2"/>
                <line x1="3" y1="18" x2="4" y2="28" stroke="#333" stroke-width="2"/>
            </g>`;
        } else if (rank === 2) {
            inner = souStick(30, 14, 26, isRed) + souStick(30, 44, 26, isRed);
        } else if (rank === 3) {
            inner = souStick(30, 14, 24, isRed) + souStick(18, 44, 24) + souStick(42, 44, 24);
        } else if (rank === 4) {
            inner = souStick(18, 14, 25) + souStick(42, 14, 25) +
                    souStick(18, 45, 25) + souStick(42, 45, 25);
        } else if (rank === 5) {
            inner = souStick(18, 14, 23) + souStick(42, 14, 23) +
                    souStick(30, 29, 26, true) +
                    souStick(18, 47, 23) + souStick(42, 47, 23);
        } else if (rank === 6) {
            inner = souStick(17, 14, 24) + souStick(30, 14, 24) + souStick(43, 14, 24) +
                    souStick(17, 46, 24) + souStick(30, 46, 24) + souStick(43, 46, 24);
        } else if (rank === 7) {
            inner = souStick(30, 12, 22, true) +
                    souStick(17, 36, 20) + souStick(43, 36, 20) +
                    souStick(17, 58, 20) + souStick(30, 58, 20) + souStick(43, 58, 20);
        } else if (rank === 8) {
            inner = `
                <g transform="rotate(22 23 24)">${souStick(23, 12, 22, isRed)}</g>
                <g transform="rotate(-22 37 24)">${souStick(37, 12, 22, isRed)}</g>
                <g transform="rotate(-22 23 60)">${souStick(23, 48, 22, isRed)}</g>
                <g transform="rotate(22 37 60)">${souStick(37, 48, 22, isRed)}</g>
            `;
        } else if (rank === 9) {
            inner = souStick(17, 12, 18) + souStick(30, 12, 18) + souStick(43, 12, 18) +
                    souStick(17, 33, 18) + souStick(30, 33, 18) + souStick(43, 33, 18) +
                    souStick(17, 54, 18) + souStick(30, 54, 18) + souStick(43, 54, 18);
        }

        return `
        <svg viewBox="0 0 60 84" class="tile-face-svg" xmlns="http://www.w3.org/2000/svg">
            ${inner}
        </svg>`;
    }

    /**
     * 字牌 (Honor) の SVG グラフィック生成
     */
    function createHonorSvg(type) {
        let text = '';
        let color = '#1a1a1a';
        let fontSize = '46';

        switch (type) {
            case 'east':  text = '東'; color = '#1c1c1c'; break;
            case 'south': text = '南'; color = '#1c1c1c'; break;
            case 'west':  text = '西'; color = '#1c1c1c'; break;
            case 'north': text = '北'; color = '#1c1c1c'; break;
            case 'white':
                // 白 (枠線のみ、純白の洗練された美)
                return `
                <svg viewBox="0 0 60 84" class="tile-face-svg" xmlns="http://www.w3.org/2000/svg">
                    <rect x="13" y="17" width="34" height="50" rx="3" fill="none" stroke="#2563eb" stroke-width="2.4" opacity="0.85"/>
                    <rect x="16" y="20" width="28" height="44" rx="1.5" fill="none" stroke="#2563eb" stroke-width="0.9" opacity="0.45"/>
                </svg>`;
            case 'green':
                // 發 (伝統の深緑草書)
                text = '發';
                color = '#178140';
                break;
            case 'red':
                // 中 (鮮烈な真紅)
                text = '中';
                color = '#d92525';
                fontSize = '48';
                break;
            default:
                text = '?';
        }

        return `
        <svg viewBox="0 0 60 84" class="tile-face-svg" xmlns="http://www.w3.org/2000/svg">
            <text x="30" y="44" text-anchor="middle" dominant-baseline="central" 
                  font-family="'Noto Serif JP', 'Yu Mincho', serif" font-weight="900" 
                  font-size="${fontSize}" fill="${color}">${text}</text>
        </svg>`;
    }

    /**
     * 牌情報オブジェクトからSVGの内部HTMLを生成
     */
    function getTileSvg(tile) {
        if (!tile) return '';
        if (tile.suit === 'man') return createManSvg(tile.rank, tile.isRed);
        if (tile.suit === 'pin') return createPinSvg(tile.rank, tile.isRed);
        if (tile.suit === 'sou') return createSouSvg(tile.rank, tile.isRed);
        if (tile.suit === 'honor') return createHonorSvg(tile.honorType);
        return '';
    }

    /**
     * 牌の日本語名称（ツールチップ用）
     */
    function getTileTitle(tile) {
        if (!tile) return '伏せ牌';
        if (tile.suit === 'honor') {
            const honors = { east: '東', south: '南', west: '西', north: '北', white: '白', green: '發', red: '中' };
            return honors[tile.honorType] || tile.honorType;
        }
        const suits = { man: '萬', pin: '筒', sou: '索' };
        return `${tile.isRed ? '赤' : ''}${tile.rank}${suits[tile.suit] || ''}`;
    }

    /**
     * 牌のHTML要素を生成 (オンライン麻雀スタイル)
     * @param {Object|null} tile - 牌データ { suit, rank, honorType, isRed, id }
     * @param {string} size - 'lg' (手牌), 'md' (河), 'sm' (王牌/ドラ), 'xs' (超小型)
     * @param {string} extraClass - 追加CSSクラス
     * @param {string} tileOrientation - 'normal' | 'horizontal' (横向き/チー・ポン・リーチ)
     */
    function renderTileHtml(tile, size = 'lg', extraClass = '', tileOrientation = 'normal') {
        const isBack = !tile;
        const title = getTileTitle(tile);
        const tileId = tile?.id ?? '';
        const isRed = tile?.isRed ? 'red-tile' : '';
        const orientationClass = tileOrientation === 'horizontal' ? 'tile-horizontal' : '';

        // 背面牌（イエロー竹背）
        if (isBack) {
            return `
            <div class="tenhou-tile tile-back tile-${size} ${orientationClass} ${extraClass}" 
                 data-tile-id="" title="伏せ牌">
                <div class="tile-body">
                    <div class="tile-bamboo-back"></div>
                </div>
            </div>`;
        }

        const svgContent = getTileSvg(tile);
        const tileTypeKey = tile.suit === 'honor' ? tile.honorType : `${tile.rank}${tile.suit[0]}`;

        return `
        <div class="tenhou-tile tile-face tile-${size} ${isRed} ${orientationClass} ${extraClass}" 
             data-tile-id="${tileId}" 
             data-tile-type="${tileTypeKey}"
             title="${title}">
            <div class="tile-body">
                <div class="tile-front-layer">
                    ${svgContent}
                </div>
            </div>
        </div>`;
    }

    /**
     * リーチ棒 (1000点棒) HTMLを生成
     */
    function renderRiichiStickHtml(extraClass = '') {
        return `
        <div class="tenhou-riichi-stick ${extraClass}" title="立直棒 (1,000点)">
            <span class="stick-dot"></span>
        </div>`;
    }

    return {
        renderTileHtml,
        renderRiichiStickHtml,
        getTileTitle,
        getTileSvg,
    };

})();

// グローバルスコープおよびモジュールとして公開
if (typeof window !== 'undefined') {
    window.MahjongTiles = MahjongTiles;
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = MahjongTiles;
}

