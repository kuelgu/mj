## 通知仕様 (Discord Embed Notifications)

タスク完了や重要イベントの発生時、Discord Webhook へ Embed（カード型リッチテキスト）形式で通知を送信してください。

### 1. 通知トリガーとステータス
通知は以下の3つの状態に分類し、対応するカラーコードを設定してください。
- **SUCCESS（緑 / 3066993）**: 長時間処理・ビルド・テスト・デプロイの正常完了
- **ERROR（赤 / 15158332）**: 実行時エラー、ビルド失敗、例外終了
- **WAITING（黄 / 16776960）**: ユーザーの確認・判断・追加の指示待ち

### 2. 送信ルール
- Webhook URL は環境変数 `DISCORD_WEBHOOK_URL` を必ず参照すること。
- エスケープ漏れによる JSON 構文エラーを防ぐため、以下のコマンド例のいずれか（Pythonワンライナーまたはヒアドキュメント）を利用して送信すること。

### 3. 送信コマンド例

#### パターンA: 正常完了時 (SUCCESS / 緑枠)
```bash
python3 -c '
import os, requests, json, datetime

webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
if not webhook_url:
    exit(0)

payload = {
    "embeds": [{
        "title": "✅ タスク正常完了",
        "color": 3066993,
        "description": "要求されたタスクの実行が正常に完了しました。",
        "fields": [
            {"name": "タスク名", "value": "Figmaコンポーネント実装", "inline": True},
            {"name": "実行時間", "value": "1m 45s", "inline": True},
            {"name": "主な変更点", "value": "- `src/components/Card.tsx` を新規作成\n- Storybook のテストをパス", "inline": False}
        ],
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }]
}
requests.post(webhook_url, json=payload)
'
```

#### パターンB: エラー発生時 (ERROR / 赤枠)
```bash
python3 -c '
import os, requests, json, datetime

webhook_url = os.environ.get("DISCORD_WEBHOOK_URL")
if not webhook_url:
    exit(0)

payload = {
    "embeds": [{
        "title": "⚠️ タスク実行エラー",
        "color": 15158332,
        "description": "ビルド処理中に予期せぬエラーが発生し中断しました。",
        "fields": [
            {"name": "失敗ステップ", "value": "npm run build", "inline": True},
            {"name": "終了コード", "value": "1", "inline": True},
            {"name": "エラー要約", "value": "```\nTS2304: Cannot find name 'UserProfileProps'\n```", "inline": False},
            {"name": "確認事項", "value": "型の定義ファイルが欠落している可能性があります。", "inline": False}
        ],
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat()
    }]
}
requests.post(webhook_url, json=payload)
'
```
#### アンチパターンチェック
#### Mandatory Self-Review (Anti-Pattern Check)
Before concluding any task or reporting completion, you MUST silently audit your own changes against the following anti-patterns and fix any violations immediately without waiting for the user to point them out:

1. **Error Handling & Resilience:**
   - Never use bare `except:` / empty `catch` blocks that swallow errors silently.
   - Always close files, DB connections, and network streams properly (use `with` / `try-with-resources` / `defer`).
2. **Performance & Resource Management:**
   - Avoid N+1 queries inside loops; batch I/O and database operations.
   - Never load unbounded large files or datasets entirely into memory when streaming/pagination is possible.
3. **Hardcoding & Security:**
   - Never hardcode credentials, API keys, tokens, or environment-specific absolute paths.
   - Use parameterized queries; never concatenate user input directly into SQL or shell commands.
4. **Maintainability & Cleanliness:**
   - Eliminate magic numbers/strings (extract to named constants).
   - Avoid deeply nested conditionals (more than 3 levels); use early returns (guard clauses).
   - Remove unused imports, dead code, and temporary debug logs before finishing.
5. **Database / SQL Anti-Patterns:**
   - Never use `SELECT *` in production queries; specify explicit columns.
   - Never execute `UPDATE` or `DELETE` without a `WHERE` clause.
   - Ensure proper transaction boundaries and avoid holding locks across external API calls.
6. **TypeScript / Async Anti-Patterns:**
   - Never use `any` unless strictly unavoidable; define explicit interfaces/types.
   - Never leave floating promises (`async` calls without `await` or `.catch()`).

If you detect and fix an anti-pattern during your self-review, briefly mention what you prevented in 1 line at the end of your response.


   
