# Riichi Mahjong (四麻) Server

サーバー権威の日本リーチ麻雀（四人麻雀）オンライン対戦システム

## 概要

このプロジェクトは、`rules/default.rule.json` を Single Source of Truth として、複数ロン、切り上げ満貫、数え役満、パオ、流し満貫などのローカルルールを含む、サーバー権威の麻雀ゲームエンジンを実装しています。

## 特徴

### 実装済みルール

- **複数ロン**: ダブロン・トリロン対応（頭ハネなし）
- **切り上げ満貫**: 4翻30符、3翻60符を満貫扱い
- **数え役満**: 13翻以上を役満として扱う
- **パオ（責任払い）**: 大三元、大四喜などで発動
- **流し満貫**: 和了扱いで精算

### アーキテクチャ

```
src/
├── config/
│   ├── rule-config.ts       # RuleConfig型定義とバリデーション
│   └── rule-config.test.ts  # 設定のテスト
├── types/
│   ├── tiles.ts             # 牌の型定義
│   ├── game-state.ts        # ゲーム状態の型定義
│   └── scoring.ts           # 点数計算の型定義
├── engine/
│   ├── round-state-machine.ts      # 状態遷移マシン
│   ├── round-state-machine.test.ts
│   ├── scoring-engine.ts           # 純粋な点数計算エンジン
│   └── scoring-engine.test.ts
├── server/
│   ├── game-room.ts         # ゲームルーム管理
│   └── websocket-server.ts  # WebSocketサーバー
└── index.ts                 # エントリーポイント
```

## 状態遷移と分岐点

### ゲームフェーズ

```
waiting → dealing → playing → {ron_declared, tsumo_declared, draw} → scoring → round_end → waiting
```

### 分岐点一覧

システムには以下の11個の重要な分岐点があります：

#### 1. MULTIPLE_RON_CHECK
**説明**: 同じ捨て牌に対して複数のプレイヤーがロンを宣言できるかチェック

**トリガー**: `RON_DECLARE` イベント

**関連ルール**:
- `multipleRon.mode`: `allow_up_to_3` | `allow_double` | `head_bump`
- `multipleRon.atamahane`: 頭ハネの有効/無効

**結果**:
- シングルロン → `PAO_CHECK` へ
- ダブルロン → `RIICHI_BET_DISTRIBUTION` へ
- トリロン → `RIICHI_BET_DISTRIBUTION` へ（許可されている場合）

#### 2. RIICHI_BET_DISTRIBUTION
**説明**: 複数ロン時の供託立直棒の配分方法を決定

**トリガー**: 複数ロン解決時

**関連ルール**:
- `multipleRon.riichiBetDistribution`:
  - `seat_order_nearest_to_discarder`: 捨て牌者から最も近い和了者が全て取得
  - `split_equally`: 和了者で均等分配
  - `to_next_dealer`: 次の親が全て取得

#### 3. PAO_CHECK
**説明**: 和了手が特定の役満を含む場合、パオ（責任払い）が適用されるかチェック

**トリガー**: 和了判定時

**関連ルール**:
- `pao.enabled`: パオの有効/無効
- `pao.applyTo`: パオが適用される役満のリスト
  - `daisangen`: 大三元
  - `daisuushi`: 大四喜
  - `tsuuiisou_optional`: 字一色
  - `suukantsu_optional`: 四槓子

**結果**:
- パオなし → 通常の支払い計算
- パオあり → `PAO_PAYMENT_CALCULATION` へ

#### 4. PAO_PAYMENT_CALCULATION
**説明**: パオ時の支払い方法を計算

**トリガー**: パオチェック通過時

**関連ルール**:
- `pao.paymentStyle`:
  - `full`: 責任者が全額支払い
  - `split`: 責任者と放銃者で分割
  - `configurable_full_or_split`: 役満ごとに設定可能

#### 5. KIRIAGE_MANGAN_CHECK
**説明**: 切り上げ満貫の判定

**トリガー**: 点数計算時

**関連ルール**:
- `scoring.kiriageMangan`: 切り上げ満貫の有効/無効

**対象**:
- 4翻30符 → 満貫（有効時）
- 3翻60符 → 満貫（有効時）

#### 6. KAZOE_YAKUMAN_CHECK
**説明**: 13翻以上を数え役満として扱うか判定

**トリガー**: 13翻以上の手の点数計算時

**関連ルール**:
- `scoring.kazoeYakuman`:
  - `yakuman`: 役満として扱う
  - `limit`: 三倍満として扱う
  - `unlimited`: 実際の翻数でカウント

#### 7. NAGASHI_MANGAN_CHECK
**説明**: 流し満貫の成立をチェック

**トリガー**: 牌山が尽きた時（流局時）

**関連ルール**:
- `nagashiMangan.enabled`: 流し満貫の有効/無効
- `nagashiMangan.treatAsWin`: 和了扱いするか流局扱いするか

**条件**:
- 全ての捨て牌が么九牌（1, 9, 字牌）
- 捨て牌が他家に鳴かれていない

**結果**:
- 無効時 → 通常の流局
- 有効 + 和了扱い → 満貫ツモとしてスコアリング
- 有効 + 流局扱い → 流局として処理

#### 8. EXHAUSTIVE_DRAW_CHECK
**説明**: 牌山が尽きたことによる流局をチェック

**トリガー**: 牌山に14枚（王牌）のみ残った時

**結果**:
- `NAGASHI_MANGAN_CHECK` へ
- 聴牌/不聴牌の判定
- 次局の本場/供託の更新

#### 9. ABORTIVE_DRAW_CHECK
**説明**: 途中流局の条件をチェック

**トリガー**: プレイ中の特定条件

**条件**:
- 四風連打: 第一巡に同じ風牌が4枚捨てられる
- 四家立直: 4人全員が立直宣言
- 四槓散了: 異なるプレイヤーが4つの槓を作る
- 九種九牌: 配牌時に9種類以上の么九牌

#### 10. HONBA_UPDATE
**説明**: 本場カウンターの更新

**トリガー**: 局終了時

**ルール**:
- 親の和了 or 親が聴牌の流局 → 本場+1
- 子の和了 or 親が不聴牌の流局 → 本場リセット

#### 11. DEALER_ROTATION
**説明**: 親の移動を決定

**トリガー**: 局終了時

**ルール**:
- 親の和了 or 親が聴牌の流局 → 親続行
- 子の和了 or 親が不聴牌の流局 → 親を次へ移動

## テスト

### テストケース

すべての分岐点をカバーするテストが含まれています：

#### 切り上げ満貫テスト
- ✅ 4翻30符が満貫になること
- ✅ 3翻60符が満貫になること
- ✅ 無効時は通常計算されること

#### 数え役満テスト
- ✅ 13翻が役満として扱われること
- ✅ 14翻以上も役満として扱われること
- ✅ `limit` 設定時は三倍満として扱われること

#### 複数ロンテスト
- ✅ ダブロン（2人ロン）の精算が正しいこと
- ✅ トリロン（3人ロン）の精算が正しいこと
- ✅ 供託立直棒が座席順で最も近い和了者に渡ること
- ✅ 供託立直棒が均等分配されること（設定による）

#### パオテスト
- ✅ 全額払い（full）が正しく計算されること
- ✅ 分割払い（split）が正しく計算されること
- ✅ 親の役満パオが正しく処理されること

#### 流し満貫テスト
- ✅ 子の流し満貫が満貫ツモとして計算されること
- ✅ 親の流し満貫が満貫ツモとして計算されること
- ✅ 本場が正しく加算されること

### テスト実行

```bash
# 依存関係のインストール
npm install

# すべてのテストを実行
npm test

# ビルド
npm run build

# サーバー起動
npm start

# 開発モード（ホットリロード）
npm run dev
```

## 使用方法

### サーバー起動

```bash
npm start
```

サーバーは `ws://localhost:8080` で起動します。

### クライアント接続

WebSocketクライアントから以下のメッセージ形式で接続：

#### ルームに参加

```json
{
  "type": "join_room",
  "roomId": "room1",
  "playerId": "player1"
}
```

#### ゲームアクション

```json
{
  "type": "game_action",
  "event": {
    "type": "ROUND_START"
  }
}
```

#### 状態取得

```json
{
  "type": "get_state"
}
```

### サーバーメッセージ

#### 状態更新

```json
{
  "type": "game_update",
  "messages": [
    {
      "type": "game_event",
      "event": "Round starting"
    },
    {
      "type": "branching_point",
      "branchingPoint": "MULTIPLE_RON_CHECK"
    },
    {
      "type": "state_update",
      "state": { ... }
    }
  ]
}
```

## ルール設定

`rules/default.rule.json` を編集することで、ゲームルールをカスタマイズできます：

```json
{
  "variant": "riichi-4p",
  "multipleRon": {
    "mode": "allow_up_to_3",
    "atamahane": false,
    "riichiBetDistribution": "seat_order_nearest_to_discarder"
  },
  "scoring": {
    "kiriageMangan": true,
    "kazoeYakuman": "yakuman"
  },
  "pao": {
    "enabled": true,
    "paymentStyle": "configurable_full_or_split",
    "applyTo": ["daisangen", "daisuushi", "tsuuiisou_optional", "suukantsu_optional"]
  },
  "nagashiMangan": {
    "enabled": true,
    "treatAsWin": true
  }
}
```

### 設定項目

- **variant**: ゲームバリアント（`riichi-4p` または `riichi-3p`）
- **multipleRon.mode**: 複数ロンの許可レベル
- **multipleRon.atamahane**: 頭ハネの有効/無効
- **multipleRon.riichiBetDistribution**: 供託立直棒の配分方法
- **scoring.kiriageMangan**: 切り上げ満貫の有効/無効
- **scoring.kazoeYakuman**: 数え役満の扱い
- **pao.enabled**: パオの有効/無効
- **pao.paymentStyle**: パオの支払い方式
- **pao.applyTo**: パオが適用される役満のリスト
- **nagashiMangan.enabled**: 流し満貫の有効/無効
- **nagashiMangan.treatAsWin**: 和了扱いするか

## 実装の詳細

### サーバー権威

すべてのゲームロジックはサーバー側で実行されます：

1. クライアントはアクションを送信
2. サーバーがアクションを検証
3. サーバーがゲーム状態を更新
4. サーバーが新しい状態をすべてのクライアントにブロードキャスト

### 純粋関数

`ScoringEngine` は純粋関数として実装されており、副作用がありません：

```typescript
const score = scoringEngine.calculateScore(hand, isDealer, isTsumo);
// 状態を変更せず、計算結果のみを返す
```

### 型安全性

TypeScriptの厳格な型チェックとZodによる実行時バリデーションにより、型安全性を保証：

```typescript
const config = RuleConfigSchema.parse(jsonData);
// 不正な設定は起動時にエラーとなる
```

## ライセンス

MIT

## 開発者向けメモ

### 新しいルールの追加

1. `src/config/rule-config.ts` に型定義を追加
2. `RuleConfigSchema` にZodスキーマを追加
3. 該当する分岐点で新しいルールを処理
4. テストケースを追加

### 新しい分岐点の追加

1. `BranchingPoint` 型に追加
2. `BRANCHING_POINTS_DOCUMENTATION` にドキュメントを追加
3. `RoundStateMachine` で処理を実装
4. テストケースを追加

### デバッグ

サーバーは各状態遷移とイベントをログ出力します。WebSocketメッセージを監視することで、ゲームの流れを追跡できます。
