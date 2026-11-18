# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:24-slim AS builder

WORKDIR /app

# Enable pnpm via corepack (must match packageManager in package.json)
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

# Install dependencies (layer cached unless lock changes)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# --ignore-scripts: the `prepare` script compiles TypeScript, but src/ and the
# tsconfig files are not copied yet, and git hooks are useless in an image.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Build TypeScript
COPY tsconfig.json tsconfig.build.json ./
COPY src/ src/
RUN pnpm build

# Remove dev dependencies
RUN pnpm prune --prod --ignore-scripts

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:24-slim AS production

LABEL org.opencontainers.image.title="imap-wizard" \
      org.opencontainers.image.description="IMAP/SMTP email MCP server — stdio + Streamable HTTP, IMAP IDLE push, multi-account, AI triage" \
      org.opencontainers.image.url="https://github.com/Fe2-O3/imap-wizard" \
      org.opencontainers.image.source="https://github.com/Fe2-O3/imap-wizard" \
      org.opencontainers.image.licenses="LGPL-3.0-or-later" \
      org.opencontainers.image.vendor="Fe2-O3"

WORKDIR /app

# Copy only production artifacts
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Folders for volume mounts. config: read-only from the host. state (scheduled
# email queue, writer lock) and data (local rules, audit log): mount volumes
# here, or they are lost when the container stops. cache: the local mirror,
# safe to lose. Created here so a new named volume starts owned by `node`.
RUN mkdir -p /home/node/.config/email-mcp /home/node/.local/state/email-mcp \
      /home/node/.local/share/email-mcp /home/node/.cache/email-mcp \
    && chown -R node:node /home/node/.config /home/node/.local /home/node/.cache

ENV NODE_ENV=production

# Streamable HTTP port (only used when running the `http` subcommand).
EXPOSE 8080

USER node

# Default: stdio. For HTTP, override the command, e.g.:
#   docker run -e EMAIL_MCP_HTTP_TOKEN=… -p 8080:8080 ghcr.io/fe2-o3/imap-wizard \
#     http --host 0.0.0.0 --port 8080
ENTRYPOINT ["node", "dist/main.js"]
CMD ["stdio"]
