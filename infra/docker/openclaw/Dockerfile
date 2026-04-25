# RedDwarf OpenClaw toolchain image.
#
# Derived from the upstream OpenClaw gateway image. Adds:
#
#   1. A stack-agnostic system build chain (`build-essential` + the headers
#      most native gem / wheel / addon builds need) and common database /
#      cache clients. These are universal — they don't change when the
#      project's primary language does.
#
#   2. `mise` (https://mise.jdx.dev), a polyglot runtime version manager.
#      Projects pin runtimes via `.tool-versions` / `mise.toml`; the agent
#      runs `mise install` and gets whatever Ruby / Node / Python / Go / etc.
#      version the project asks for. One tool covers ~50 languages, so the
#      image stays the same when a new stack lands in a generated app.
#
#   3. Pre-created cache directories under the runtime user's home. The
#      docker-compose service mounts named volumes onto these paths so
#      package-manager state (gems, npm modules, pip wheels, cargo crates,
#      go modules, mise-installed runtimes) survives across tasks. First
#      task on a stack pays the install cost; subsequent tasks of the same
#      stack hit the cache and finish in seconds.
#
# This is the scaling counterpart to the workspace-mtime progress signal in
# `createDeveloperHandoffAwaiter`: the awaiter makes long first-installs
# survivable, the cache volumes make sure most tasks never pay them again.

ARG OPENCLAW_BASE_IMAGE=ghcr.io/openclaw/openclaw:2026.4.23
FROM ${OPENCLAW_BASE_IMAGE}

USER root

# Universal build / link / header surface. Everything here is needed by
# native extensions across multiple ecosystems (Ruby gems with C extensions,
# Python wheels with native deps, Node `node-gyp` builds, Rust crates that
# wrap C libraries) — keeping them stack-agnostic is the whole point.
#
# Database / cache clients ride along because most generated apps need at
# least one of them and the marginal image cost is small versus paying
# `apt-get install` per task.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
        gnupg \
        pkg-config \
        libssl-dev \
        libyaml-dev \
        libffi-dev \
        libreadline-dev \
        zlib1g-dev \
        libgmp-dev \
        libpq-dev \
        libsqlite3-dev \
        libxml2-dev \
        libxslt-dev \
        sqlite3 \
        postgresql-client \
        redis-tools \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# mise — polyglot runtime version manager. Installed via the official
# install script with an optional pinned version; without `MISE_VERSION`
# the install script picks the latest stable release at build time.
ARG MISE_VERSION=
RUN set -eu; \
    if [ -n "${MISE_VERSION}" ]; then \
        curl -fsSL https://mise.run | MISE_VERSION="${MISE_VERSION}" MISE_INSTALL_PATH=/usr/local/bin/mise sh; \
    else \
        curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh; \
    fi; \
    chmod 0755 /usr/local/bin/mise; \
    mise --version

# Pre-create the cache and runtime-install directories under the runtime
# user's home. docker-compose mounts named volumes onto these paths so
# their contents survive across tasks. Listed explicitly rather than via a
# loop so a future change is easy to grep for.
#
# `mise` runtimes live under `~/.local/share/mise/installs/<lang>/<ver>/`;
# everything else is the conventional package-manager cache location.
RUN install -d -o node -g node -m 0755 \
        /home/node/.cache \
        /home/node/.cache/mise \
        /home/node/.cache/pip \
        /home/node/.cache/yarn \
        /home/node/.local \
        /home/node/.local/share \
        /home/node/.local/share/mise \
        /home/node/.local/share/pnpm \
        /home/node/.local/share/pnpm/store \
        /home/node/.npm \
        /home/node/.bundle \
        /home/node/.gem \
        /home/node/.cargo \
        /home/node/.cargo/registry \
        /home/node/.cargo/git \
        /home/node/go \
        /home/node/go/pkg

# Make `mise activate` available to interactive shells and to non-login
# subprocesses spawned by the agent. The PATH prefix covers the case where
# a tool runs before `mise activate` has a chance to inject shims.
RUN printf '%s\n' \
        'export PATH="$HOME/.local/share/mise/shims:$PATH"' \
        'eval "$(/usr/local/bin/mise activate bash --shims)"' \
        > /etc/profile.d/mise.sh \
    && chmod 0644 /etc/profile.d/mise.sh

ENV PATH="/home/node/.local/share/mise/shims:${PATH}"

# Restore the upstream image's default user. The upstream entrypoint runs
# as `node`; reverting here keeps file ownership and gateway behaviour
# identical to the unmodified base image.
USER node
