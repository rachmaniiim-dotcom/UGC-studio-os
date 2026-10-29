# Research toolkit (Claude Code)

| Piece | What | Source |
|---|---|---|
| `.mcp.json` → `apify` | Hosted Apify MCP (Reddit / G2 / Trustpilot / Product Hunt / app-review scrapers). OAuth sign-in on first use. | apify/actors-mcp-server |
| `.mcp.json` → `firecrawl` | Hosted Firecrawl MCP. `scrape` and `search` work keyless (rate-limited). For crawl/map, add a key (see below). | mendableai/firecrawl-mcp-server |
| `skills/customer-research` | JTBD / pains / workarounds research framework | coreyhaines31/marketingskills (MIT, copied as-is) |
| `skills/reddit-pain-points` | Reddit + review mining → ranked markdown report in `research/` | written for this repo |

## First run
1. Open Claude Code in this repo and approve the two project MCP servers when prompted (or run `/mcp`).
2. In `/mcp`, select **apify** and sign in. Firecrawl works without signing in.
3. Ask: *"Find pain points for <idea>. Competitors: X, Y. Subreddits: r/a, r/b."*

## Optional: Firecrawl API key (full tool set)
Don't commit keys. Instead, add the server once on your machine:
`claude mcp add -s user firecrawl-pro https://mcp.firecrawl.dev/v2/mcp -t http -H "Authorization: Bearer $FIRECRAWL_API_KEY"`

## Claude.ai / Desktop
Skills in this folder only load in Claude Code. In the Claude app, add Apify under **Settings → Connectors**, and add a custom connector for `https://mcp.firecrawl.dev/v2/mcp-oauth`.

## Not installed
- `the-wc/reddit-painpointer` is a standalone web app, not a Claude skill. It needs Reddit API and OpenRouter keys. Its keyword method is built into `reddit-pain-points`.
- `assafkip/reddit-business-research` is not publicly available on GitHub. `reddit-pain-points` replaces it.
