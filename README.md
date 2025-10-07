# twilog-bridge

Cloudflare Workers 上で動作する Twilog MCP 向けの最小・安全な GET ブリッジ  
クライアントは GET リクエストのみで MCP の `tools/list` と `tools/call(get_twitter_posts)` を利用可能  

```bash
wrangler login
wrangler secret put TWILOG_TOKEN
wrangler deploy
```

## エンドポイント
- `GET /health`  
- `GET /tools[?ttl=秒]`  
- `GET /search?q=クエリ[&limit=1-100][&ttl=秒]`  
