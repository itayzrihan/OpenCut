ARG NODE_IMAGE=node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85
FROM ${NODE_IMAGE}
WORKDIR /app/classic
COPY classic/services/peer-sync-relay/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY classic/apps/web/src/peer-sync/relay.mjs ./apps/web/src/peer-sync/relay.mjs
COPY classic/scripts/peer-sync-relay.mjs ./scripts/peer-sync-relay.mjs
ENV NODE_ENV=production OPENCUT_PEER_RELAY_HOST=0.0.0.0 OPENCUT_PEER_RELAY_PORT=3010
USER node
EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3010/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/peer-sync-relay.mjs"]
