# RedDwarf OpenClaw toolchain image.
#
# Derived from the upstream OpenClaw gateway image, this layer pre-bakes the
# language runtimes and package managers that complex-app tasks repeatedly
# install on first run (Ruby/Rails, Python, modern Node package managers,
# common build deps). Without it, a Rails scaffold + `bundle install` + test
# run frequently exceeds the developer-phase timeout because all of bundler
# resolution, native gem compiles, and gem cache priming happen inside the
# task's wall clock budget.
#
# See `infra/docker/openclaw/build.sh` for the canonical build invocation.
# After building, set OPENCLAW_IMAGE in your .env to the tag this Dockerfile
# produces (defaults to reddwarf/openclaw-toolchains:<base-tag>).

ARG OPENCLAW_BASE_IMAGE=ghcr.io/openclaw/openclaw:2026.4.23
FROM ${OPENCLAW_BASE_IMAGE}

USER root

# Build essentials and headers commonly needed by native gem / wheel builds.
# Kept intentionally broad — these are tens of MB and the alternative is an
# install-time stall on the first task that needs them.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        curl \
        git \
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
        python3 \
        python3-pip \
        python3-venv \
    && rm -rf /var/lib/apt/lists/*

# Ruby + Rails. Use the distro Ruby (Debian bookworm ships 3.1) rather than
# building from source — version freshness is a non-goal here; what matters
# is that `bundle` and `rails new` work without internet round trips.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ruby-full \
    && rm -rf /var/lib/apt/lists/*

ARG RAILS_VERSION=7.2.2
RUN gem install --no-document bundler \
    && gem install --no-document rails -v "${RAILS_VERSION}"

# Modern Node package managers. The base image already has Node + npm; pnpm
# and yarn are common in scaffolded projects and otherwise cost ~20s on
# first use to install via `corepack`.
RUN if command -v node >/dev/null 2>&1; then \
        npm install -g pnpm yarn || true; \
    fi

# Frequently-used Python tooling. Held to a minimal floor so the image stays
# below ~1.5 GB; tasks that need a specific framework still install it via
# pip, but the wheel cache + base interpreter are no longer the long pole.
RUN python3 -m pip install --no-cache-dir --break-system-packages \
        pipx \
        virtualenv \
        || true

# Restore the upstream image's default user. The upstream entrypoint runs as
# `node`; reverting here keeps file ownership and gateway behaviour
# identical to the unmodified base image.
USER node
