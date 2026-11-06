# Container image for running the MCP server over Streamable HTTP.
# Used by the Cloudflare deployment in cloudflare/, but works on any container host.
FROM python:3.13-slim

COPY --from=ghcr.io/astral-sh/uv:0.8.17 /uv /bin/uv

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_NO_DEV=1

COPY pyproject.toml uv.lock README.md ./
RUN uv sync --frozen --no-install-project
COPY src ./src
RUN uv sync --frozen

ENV MCP_TRANSPORT=streamable-http \
    MCP_HOST=0.0.0.0 \
    MCP_PORT=8080 \
    CACHE_DB_PATH=/tmp/ynab-cache.db \
    PATH="/app/.venv/bin:$PATH"

EXPOSE 8080
# YNAB_API_KEY must be supplied at runtime; never bake it into the image.
CMD ["python", "-m", "src.server"]
