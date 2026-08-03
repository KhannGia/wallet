# Node 26 runs TypeScript directly via native type stripping, so there is no
# build step and no bundler in this project.
FROM node:26-bookworm-slim

# curl is used by container healthchecks; ca-certificates for outbound TLS.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The `node` user is uid 1000, matching the host user, so bind-mounted files
# keep their ownership instead of turning up as root-owned on the host.
#
# These node_modules directories must exist in the image: Docker seeds an empty
# named volume from the image path, and if the path is missing it creates the
# volume root-owned, which then makes npm fail with EACCES.
RUN mkdir -p /app/node_modules \
             /app/services/api/node_modules \
             /app/packages/shared/node_modules \
    && chown -R node:node /app

USER node

CMD ["node", "--version"]
