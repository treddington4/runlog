# Build stage: the new React frontend (Phase 0 rewrite, see PLAN.md 0.10). Pinned
# to node:22-slim (not a floating tag) to match the dev workflow documented in
# .RUNBOOK.md — Vite 8 needs ^20.19 || >=22.12, confirmed by that same pin there.
FROM node:22-slim AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM python:3.12-slim

# WORKDIR is the package's *parent* directory — `app/` is a real installable
# package now (pyproject.toml + app/__init__.py, every internal cross-module import
# converted to relative `from . import x`), not a flat directory of top-level
# modules living directly at the working directory the way it used to.
WORKDIR /srv

COPY requirements.txt pyproject.toml ./
COPY app ./app

# requirements.txt stays the source of truth for third-party dependency versions;
# the second install just registers `app` itself as an importable package
# (--no-deps: pyproject.toml's own dependency list mirrors requirements.txt, so this
# skips redundantly re-resolving what the first install already satisfied).
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir --no-deps .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# web-dist must land as a *sibling of main.py inside the package* — main.py resolves
# it via os.path.dirname(__file__), not the process's CWD (see main.py's WEB_DIST_DIR).
COPY --from=web-builder /web/dist ./app/web-dist

RUN mkdir -p /data \
    && groupadd -r runlog && useradd -r -g runlog -d /srv runlog \
    && chown -R runlog:runlog /srv /data

EXPOSE 8000

# curl isn't installed in python:3.12-slim, so use urllib instead of adding a
# dependency just for this. /health has no auth/DB dependency (see app/main.py) so
# this only ever reflects whether uvicorn itself is up and serving. Reads $PORT to
# match docker-entrypoint.sh's actual bind port, not the 8000 default.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import os,urllib.request; urllib.request.urlopen('http://localhost:' + os.environ.get('PORT','8000') + '/health', timeout=2)" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]