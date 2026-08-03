FROM ghcr.io/foundry-rs/foundry:latest

USER root

# Same reason as the Node image: these paths are backed by named volumes, and
# Docker only seeds a volume with the right ownership when the directory
# already exists in the image. Otherwise the volume lands root-owned and forge
# fails with a permission error.
RUN mkdir -p /app/contracts/lib /app/contracts/out /app/contracts/cache \
    && chown -R foundry:foundry /app

USER foundry

WORKDIR /app/contracts
