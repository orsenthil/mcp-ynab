/**
 * Cloudflare front door for the YNAB MCP server.
 *
 *   Claude.ai ──OAuth 2.1──▶ this Worker ──▶ YnabContainer (Python server, streamable-http)
 *
 * The Worker is the OAuth authorization server Claude.ai's custom connectors expect
 * (dynamic client registration, PKCE). Logging in goes through GitHub, and only the
 * GitHub account named in ALLOWED_GITHUB_LOGIN is ever issued a token. The container
 * is not publicly addressable; every MCP request reaches it through the token check.
 */
import { Container, getContainer } from "@cloudflare/containers";
import OAuthProvider, {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  YNAB_CONTAINER: DurableObjectNamespace<YnabContainer>;
  YNAB_API_KEY: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_LOGIN: string;
  /** Optional: canonical public origin, e.g. https://ynab-mcp.<you>.workers.dev. Defaults to the request origin. */
  PUBLIC_URL?: string;
}

interface Props {
  login: string;
}

export class YnabContainer extends Container<Env> {
  defaultPort = 8080;
  // Stop after idle so you're not billed for an always-on container. The SQLite
  // cache lives on ephemeral disk and simply starts cold after a sleep.
  sleepAfter = "15m";

  constructor(ctx: DurableObjectState<{}>, env: Env) {
    super(ctx, env);
    this.envVars = {
      YNAB_API_KEY: env.YNAB_API_KEY,
      // Only this Worker can reach the container, and it has already checked the
      // OAuth token, so the SDK's Host-header (DNS rebinding) check adds nothing.
      MCP_ALLOWED_HOSTS: "*",
    };
  }
}

function allowedLogin(env: Env): string {
  const login = (env.ALLOWED_GITHUB_LOGIN ?? "").trim().toLowerCase();
  if (!login) throw new Error("ALLOWED_GITHUB_LOGIN is not set; refusing all logins");
  return login;
}

// ---------------------------------------------------------------------------
// Protected MCP endpoint: only reached with a valid access token.
// ---------------------------------------------------------------------------
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: Props }) {
    // Re-check on every call, so changing ALLOWED_GITHUB_LOGIN revokes old tokens.
    if (ctx.props?.login?.toLowerCase() !== allowedLogin(env)) {
      return new Response("Forbidden", { status: 403 });
    }
    const forwarded = new Request(request);
    forwarded.headers.delete("Authorization"); // the container never sees our token
    // One named instance: a personal server needs no fan-out, and it keeps the cache warm.
    return getContainer(env.YNAB_CONTAINER, "ynab").fetch(forwarded);
  },
};

// ---------------------------------------------------------------------------
// Login flow: consent page → GitHub → callback → token for Claude.ai.
// ---------------------------------------------------------------------------
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

interface UpstreamData {
  verifier: string;
}

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function withHeaders(base: Headers, extra: Record<string, string>): Headers {
  const h = new Headers(base);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return h;
}

async function showConsent(request: Request, env: Env): Promise<Response> {
  const authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  const info = await env.OAUTH_PROVIDER.describeConsent(authReq);
  const { handle, headers } = await env.OAUTH_PROVIDER.beginConsent(authReq);
  const client = esc(info.clientDomain ? `${info.clientName} (${info.clientDomain})` : info.clientName);
  const html = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect YNAB</title>
<style>body{font:16px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222}
.box{border:1px solid #ddd;border-radius:12px;padding:1.5rem}button{font:inherit;padding:.6rem 1.2rem;border-radius:8px;border:1px solid #888;cursor:pointer}
.ok{background:#1f6feb;color:#fff;border-color:#1f6feb}code{background:#f3f3f3;padding:0 .3rem;border-radius:4px}</style></head>
<body><div class="box"><h2>Connect to your YNAB MCP server?</h2>
<p><b>${client}</b> is asking for full read and write access to your YNAB budget.</p>
<p>After approval you'll be sent back to <code>${esc(info.redirectHost)}</code>.</p>
<p>Only approve if you started this from Claude yourself.</p>
<form method="post" action="/authorize"><input type="hidden" name="handle" value="${esc(handle)}">
<button class="ok" name="action" value="approve">Continue with GitHub</button>
<button name="action" value="deny">Cancel</button></form></div></body></html>`;
  return new Response(html, { headers: withHeaders(headers, { "Content-Type": "text/html; charset=utf-8" }) });
}

async function submitConsent(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("action") !== "approve") {
    const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(approved.request, {
    data: { verifier } satisfies UpstreamData,
    headers: approved.headers,
  });
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  gh.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
  gh.searchParams.set("scope", "read:user");
  gh.searchParams.set("state", state);
  gh.searchParams.set("allow_signup", "false");
  gh.searchParams.set("code_challenge", b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))));
  gh.searchParams.set("code_challenge_method", "S256");
  return new Response(null, { status: 302, headers: withHeaders(headers, { Location: gh.href }) });
}

async function githubCallback(request: Request, env: Env): Promise<Response> {
  const { request: authReq, data, headers } = await env.OAUTH_PROVIDER.finishUpstream<UpstreamData>(request);
  const params = new URL(request.url).searchParams;
  const code = params.get("code");
  if (params.get("error") || !code) {
    // Declined or failed at GitHub: tell the MCP client instead of stranding it.
    return new Response(null, {
      status: 302,
      headers: withHeaders(headers, { Location: authorizationErrorRedirect(authReq, "access_denied") }),
    });
  }

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      code_verifier: data.verifier,
      redirect_uri: new URL("/callback", request.url).href,
    }),
  });
  const { access_token } = (await tokenRes.json()) as { access_token?: string };
  if (!access_token) return new Response("GitHub token exchange failed", { status: 502 });

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${access_token}`, "User-Agent": "ynab-mcp-worker", Accept: "application/vnd.github+json" },
  });
  if (!userRes.ok) return new Response("Could not read GitHub user", { status: 502 });
  const { login } = (await userRes.json()) as { login: string };

  if (login.toLowerCase() !== allowedLogin(env)) {
    return new Response(`GitHub user "${login}" is not allowed to use this server.`, { status: 403 });
  }
  return finish(authReq, login, env, headers);
}

async function finish(authReq: AuthRequest, login: string, env: Env, headers: Headers) {
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId: login,
    metadata: { label: login },
    scope: authReq.scope,
    props: { login } satisfies Props,
  });
  return new Response(null, { status: 302, headers: withHeaders(headers, { Location: redirectTo }) });
}

const loginHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/authorize" && request.method === "GET") return await showConsent(request, env);
      if (pathname === "/authorize" && request.method === "POST") return await submitConsent(request, env);
      if (pathname === "/callback") return await githubCallback(request, env);
    } catch (err) {
      if (err instanceof AuthorizationError) return new Response(err.message, { status: 400 });
      throw err;
    }
    if (pathname === "/") return new Response("YNAB MCP server. Connect Claude to /mcp.\n");
    return new Response("Not found", { status: 404 });
  },
};

// resourceMetadata needs the public URL, which is only known from env or the first
// request, so the provider is built lazily (once per isolate).
let provider: OAuthProvider<Env> | undefined;

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (!provider) {
      const origin = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, "");
      provider = new OAuthProvider<Env>({
        apiRoute: "/mcp",
        apiHandler: mcpHandler as any,
        defaultHandler: loginHandler as any,
        authorizeEndpoint: "/authorize",
        tokenEndpoint: "/token",
        clientRegistrationEndpoint: "/register", // Dynamic Client Registration
        clientIdMetadataDocumentEnabled: true, // ...or Client ID Metadata Documents
        resourceMetadata: {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          resource_name: "YNAB",
        },
      });
    }
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
