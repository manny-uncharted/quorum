# Quorum desk UI (Bun SSE server).
#
# IMPORTANT: build with the REPO ROOT as context, not quorum/ — the LLM path
# resolves `@veridex/agents` from the monorepo's node_modules (a workspace pkg).
#   docker build -f quorum/Dockerfile -t quorum .
#   docker run -p 8787:8787 --env-file quorum/.env quorum
FROM oven/bun:1.3

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile || bun install

WORKDIR /app/quorum
ENV PORT=8787
EXPOSE 8787
CMD ["bun", "run", "src/scripts/serve.ts"]
