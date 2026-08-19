# A studio you can run somewhere other than your laptop.
#
# The image carries the orchestrator and the agent CLIs. It deliberately does
# NOT carry credentials or your project — both are mounted or injected at run
# time, because baking either into a layer means it leaks with the image.
FROM node:22-bookworm-slim

# git and a compiler are not decoration: the agents are here to work on a
# repository and will reach for both. ca-certificates is needed for the
# providers' own API calls.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ca-certificates curl ripgrep python3 build-essential \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs. Pin these — a provider CLI that changes its stdout shape breaks
# the adapters, and you want that to happen when you choose to upgrade.
ARG CLAUDE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm install -g \
      @anthropic-ai/claude-code@${CLAUDE_VERSION} \
      @openai/codex@${CODEX_VERSION} \
 && npm cache clean --force

WORKDIR /opt/studio-floor
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY docs ./docs
COPY README.md LICENSE ./
RUN npm link

# The project the agents work on, and the state they accumulate. Both are
# volumes: the container is disposable, the work and the history are not.
VOLUME ["/workspace", "/state"]
WORKDIR /workspace

# STUDIO_WORKSPACE is where `studio clone` puts repositories: one directory
# holding many projects, so the studio can be pointed at any of them.
#
# GIT_TERMINAL_PROMPT=0 because a git operation that stops to ask for a password
# on a headless box hangs until something kills it, and reads to the human as
# the studio freezing. Failing at once with "could not read Username" is the
# better failure, and the studio turns that into a sentence about tokens.
ENV STUDIO_PROJECT_ROOT=/workspace \
    STUDIO_STATE_DIR=/state \
    STUDIO_WORKSPACE=/workspace \
    STUDIO_HOST=0.0.0.0 \
    STUDIO_PORT=4173 \
    GIT_TERMINAL_PROMPT=0

EXPOSE 4173

# There is no default token on purpose. `src/bin/serve.mjs` warns loudly when it
# is bound off-loopback without one, and that warning should be reaching a human.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS "http://127.0.0.1:${STUDIO_PORT}/api/state" -H "Authorization: Bearer ${STUDIO_TOKEN}" >/dev/null || exit 1

ENTRYPOINT ["studio"]
CMD ["start"]
