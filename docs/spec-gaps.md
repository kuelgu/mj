# 仕様ギャップ一覧 (Spec Gap Issues)

エンジン全域の調査 (2026-11-23) で確認した未実装・不整合の一覧。各項目は GitHub issue 化を想定している。
凡例: 🔴 高 / 🟡 中 / 🟢 低
対応状況: ✅ 対応済み (2026-11-23, G-1〜G-7 を実装・テスト追加)

## G-1 🔴 途中流局4種が未実装 ✅

対応: `DISCARD` / `RIICHI_DECLARE` / `KAN` / `KAN_COMPLETE` に四風連打・四家立直・四槓散了の検出を追加
(単独4槓は続行)、`KYUUSHU_DECLARE` イベントと配牌時の `kyuushuEligible` 算出・NPC 自動宣言を追加。
`state.drawType` で流局種別を保持し、途中流局は連荘・本場+1・供託据え置きとした。

`DrawType` (`src/types/game-state.ts`) には型だけあり、検出ロジックがどこにもない。
`ABORTIVE_DRAW_CHECK` 分岐点はドキュメントのみ。

| 条件 | あるべき検出箇所 | 現状 |
|---|---|---|
| 四風連打 | `DISCARD` (`src/engine/round-state-machine.ts:246`) | 判定なし |
| 四家立直 | `RIICHI_DECLARE` (`src/engine/round-state-machine.ts:605`) | 4人目チェックなし |
| 四槓散了 | `KAN` (`src/engine/round-state-machine.ts:501`) | 槓数チェックなし |
| 九種九牌 | 配牌直後 (`dealTiles`, `src/engine/round-state-machine.ts:966`) | 判定なし。`ActionType` の `kyuushu_kyuuhai` は型のみ |

対応案: 各イベント処理に検出を追加し、成立時は `phase: 'draw'` + `drawType` 設定へ遷移させる。
九種九牌のみ親の第一ツモ前に宣言できる選択式のため、クライアント通知も必要。

## G-2 🟡 槍槓(チャンカン)の受付フローが未実装 ✅

対応: 加槓時に `pendingKan` を設定して嶺上ツモ・新ドラを延期し、`KAN_COMPLETE` で確定する
2段階フローにした。ロン受付は G-4 の収集フローに合流 (`chankan` フラグで役判定)。
ウィンドウ中はロン/パス以外の行動を禁止し、NPC は自動ロン・人間の判断待ちに対応した。

`KAN` 処理 (`src/engine/round-state-machine.ts:501-602`) は加槓・暗槓・大明槓の直後に
即座に嶺上ツモ＋新ドラめくりを行う。加槓牌に対する他家のロン受付ウィンドウがない。

`HandEvaluator` は `chankan` フラグ対応済みだが、設定する呼び出し元が存在しない。

対応案: 加槓時に `lastDiscard` 相当として一定時間ロンを受付け、なければ嶺上ツモへ進む
2段階フローを追加する(複数ロン収集 G-4 と共通化できる)。

## G-3 🟡 パオ(責任払い)の検出が未実装 ✅

対応: `ScoringEngine.detectPao` (副露履歴から決め手の鳴き主を判定) を追加し、ツモ・ロン精算に配線した。
`configurable_full_or_split` はツモ=全額・ロン=折半に解決する。`split` はゼロサムに修正
(ロン: 責任者・放銃者が半額ずつ切り上げ払い / ツモ: 責任者が半額・残りを他家で按分)。

支払い計算 (`calculatePaoPayment`, `src/engine/scoring-engine.ts:435`) はあるが、
副露から `PaoInfo` (責任者) を算出する検出ロジックがない。
`GameRoom` のツモ・ロン処理 (`src/server/game-room.ts:140-277`) は `paoInfo` を渡していないため、
パオがあり得る対局でも常に通常精算になる。

付随する不整合:

- `split` 支払いは半分がどこからも徴収されない (`src/engine/scoring-engine.ts:452-462`
  のコメントに自認あり)。勝者は全額受領するので点棒が増殖する。
- `paymentStyle: configurable_full_or_split` の役満ごとの解決ロジックがない。

対応案: 和了時に副露履歴から責任者を判定する `detectPao(melds, yaku)` を追加し、
`split` 配分(放銃者/他家への按分)を正しく実装する。

## G-4 🔴 複数ロンの宣言収集フローが未実装 ✅

対応: `pendingRon` による宣言収集を追加した (NPC は即時自動収集、人間は宣言/パス待ち)。
確定時に `mode` (`allow_up_to_3` / `allow_double` / `head_bump` + `atamahane`) を判定し、
不許可のトリロンは `triple_ron` 流局とする。`to_next_dealer` は次期親が勝者なら配分、
非勝者なら供託を次局へ持ち越す (`riichiSticksCarryOver`)。

精算ロジック (`calculateMultipleRonPayments`, `src/engine/scoring-engine.ts:223`) と
`MULTIPLE_RON_RESOLVED` イベントはあるが、2人目以降の宣言を集める待機・収集フローがない。
`GameRoom` の `RON_DECLARE` 処理 (`src/server/game-room.ts:192-277`) は単独勝者を即精算する。

未適用の設定・ルール:

- `multipleRon.mode` (`allow_up_to_3` / `allow_double` / `head_bump`) と `atamahane` の判定なし。
  頭ハネ時の上家優先解決もない。
- トリロン時の流局扱い (`DrawType: 'triple_ron'`) なし。
- `riichiBetDistribution: to_next_dealer` は暫定実装
  (「次の親が不明なので先頭勝者に渡す」, `src/engine/scoring-engine.ts:420-425`)。

対応案: ロン宣言後に短い収集ウィンドウを設け、宣言者を集めてから mode 判定→精算する。
NPC/人間の待機は `canAnyHumanCallOrRon` の仕組みを流用できる。

## G-5 🟡 鳴きの座席・タイミング検証が不足(サーバー権威の穴) ✅

対応: ポン・チー・大明槓は直前の捨牌 (`lastDiscard`, ID 一致) への発声のみ受理し、
河の最新牌であること・発声者≠捨牌者を検証する。チーは上家からのみ、リーチ中は
ポン・チー・大明槓を禁止した (フリテンはロンのみ制限が正規ルールのため据え置き)。

- `CHI` (`src/engine/round-state-machine.ts:424-499`) に下家チェックがない。上家・対面からもチーが通る。
- `PON` / `CHI` / `KAN` が直前の捨牌 (`lastDiscard`) に対する発声かを厳密に検証していない。
  牌の一致のみで、`id` 不一致時は種類一致フォールバックで通る。
- フリテン中・リーチ中の鳴き制限も未検証。

対応案: 各鳴きイベントで「発声者と捨牌者の座席関係」「対象牌 == lastDiscard」
「リーチ・フリテン状態」を検証し、不正はエラー返却する。

## G-6 🟢 リーチ後のカン制限(送りカン禁止)がない ✅

対応: リーチ中のカンはカン前後の待ち集合が同一の場合のみ許可する (暗槓・加槓共通)。

リーチ後の加槓・暗槓は待ちが変わらない場合のみ可能だが、`KAN` 処理にその検証がない。

対応案: リーチ中の `KAN` はカン前後で待ち牌集合が同一か検証する。

## G-7 🟢 `split_equally` 配分で端数の供託が消滅する ✅

対応: 端数は捨牌者に座席順で最も近い勝者から順に1本ずつ配分する (消滅なし)。

`distributeRiichiBets` (`src/engine/scoring-engine.ts:413-418`) は `Math.floor` で按分し、
余りをどこにも配分しない。供託が場から消える。

対応案: 余りは座席順で最も近い勝者へ寄せる等、配分先を決める。
