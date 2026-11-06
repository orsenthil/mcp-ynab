# Deploy to Cloudflare (personal remote server for Claude.ai)

Runs this MCP server as a **Cloudflare Container** behind a **Worker** that handles
OAuth, so you can add it to Claude.ai (web, mobile and voice) as a custom connector.

```
Claude.ai ──OAuth──▶ Worker (cloudflare/src/index.ts) ──▶ Container (repo-root Dockerfile) ──▶ YNAB API
```

- Login goes through GitHub, and **only the GitHub account in `ALLOWED_GITHUB_LOGIN`** gets a token.
  A consent screen appears before GitHub, so a link sent by someone else can't silently authorize their client.
- Your YNAB token is a Worker secret, passed into the container's environment at start. It is never in the image or in git.
- The container sleeps after 15 idle minutes. The first request after a sleep takes a few seconds,
  and the SQLite cache starts cold, since it's only a cache.

## Prerequisites

- A Cloudflare account on the **Workers Paid** plan (required for Containers)
- Docker running locally (wrangler builds the image)
- A YNAB personal access token: https://app.ynab.com/settings/developer

## Steps

```bash
cd cloudflare
npm install
npx wrangler login

# 1. Storage for OAuth clients/grants/tokens. Paste the printed id into wrangler.jsonc.
npx wrangler kv namespace create OAUTH_KV

# 2. First deploy, to learn your URL: https://ynab-mcp.<your-subdomain>.workers.dev
npx wrangler deploy
```

3. Create a GitHub OAuth App at https://github.com/settings/developers → **New OAuth App**:
   - Homepage URL: `https://ynab-mcp.<your-subdomain>.workers.dev`
   - Authorization callback URL: `https://ynab-mcp.<your-subdomain>.workers.dev/callback`

4. Set the secrets:

```bash
npx wrangler secret put YNAB_API_KEY
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ALLOWED_GITHUB_LOGIN   # your GitHub username
```

5. In Claude.ai: **Settings → Connectors → Add custom connector**, URL
   `https://ynab-mcp.<your-subdomain>.workers.dev/mcp`, then **Connect**. Approve the consent
   screen and sign in with GitHub, then turn the connector on in a chat.

## Day to day

- **Update:** `git pull && cd cloudflare && npx wrangler deploy`
- **Logs:** `npx wrangler tail`
- **Lock everyone out:** change `ALLOWED_GITHUB_LOGIN`. Existing tokens are re-checked against it on every request.
- **Rotate YNAB token:** `npx wrangler secret put YNAB_API_KEY`. The container picks it up on its next start.
- **Local run:** copy `.dev.vars.example` to `.dev.vars`, fill it in, `npx wrangler dev`
  (GitHub callback must then be `http://localhost:8787/callback`).

The container is a plain image, so it also runs on any other host:
`docker build -t mcp-ynab . && docker run -e YNAB_API_KEY=… -e MCP_ALLOWED_HOSTS=your.host -p 8080:8080 mcp-ynab`.
Don't expose it publicly without an authenticating proxy in front, because it has full read/write access to your budget.
