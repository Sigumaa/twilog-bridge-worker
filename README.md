# twilog-bridge (Deno Deploy)

Twilog MCP の `tools/list` / `tools/call(get_twitter_posts)` を GET のみで呼び出せる HTTP ブリッジ。  
Deno Deploy 上で動作し、Accept ヘッダーに依存せず常に JSON を返却。


## エンドポイント
- `GET /health`  
  稼働確認用。`{"ok":true,"service":"twilog-bridge","time":"..."}` を返却。
- `GET /tools[?ttl=秒]`  
  上流の `tools/list` を呼び、JSON を透過的に返却します。TTL は 0〜600 秒で指定可能（既定 60 秒）。
- `GET /search?q=クエリ[&limit=1-100][&ttl=秒]`  
  `get_twitter_posts` を呼び出します。`q` は 1〜1000 文字必須、`limit` は既定 20。
