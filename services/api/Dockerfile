# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f services/api/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile --filter @happydrive/api... --ignore-scripts
COPY packages/contracts packages/contracts
COPY services/api services/api
RUN pnpm --filter @happydrive/api build && pnpm deploy --filter @happydrive/api --prod --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/ ./
# migrations and the contract are read at runtime (route schemas come from openapi.yaml)
COPY --from=build /repo/services/api/migrations ./migrations
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/v1/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
