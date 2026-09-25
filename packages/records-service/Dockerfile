# Build from repository root with -f packages/records-service/Dockerfile.
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
WORKDIR /opt/records/records-service
COPY packages/records-model/package.json ../records-model/package.json
COPY packages/records-service/deploy/runtime/package.json packages/records-service/deploy/runtime/pnpm-lock.yaml ./
RUN corepack enable && corepack prepare pnpm@11.17.0 --activate
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
ENV NODE_ENV=production
ENV RECORDS_SITE_DIR=/opt/records/site
WORKDIR /opt/records/records-service
COPY --from=dependencies /opt/records/ /opt/records/
COPY packages/records-model/src ../records-model/src
COPY packages/records-model/profiles ../records-model/profiles
COPY packages/records-model/catalogue ../records-model/catalogue
COPY packages/records-model/README.md ../records-model/README.md
COPY packages/records-service/src ./src
COPY packages/records-service/scripts ./scripts
COPY packages/records-service/sql ./sql
COPY packages/records-service/deploy/migrate.ts packages/records-service/deploy/prepare-secrets.ts ./deploy/
COPY sites/records/public /opt/records/site
COPY docs/plans/external_datastores/records-direction.md /opt/records/site/architecture-plan.md
COPY docs/plans/external_datastores/records-blueprint-adaptation.md /opt/records/site/blueprint-adaptation-plan.md
COPY docs/plans/external_datastores/records-explorer-blueprint.md /opt/records/site/explorer-blueprint-plan.md
USER node
EXPOSE 8788
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8788/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "src/server.ts"]
