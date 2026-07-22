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

WORKDIR /app

# Copy requirements and source code first so local modules are available
COPY requirements.txt .
COPY app/ ./app/

# Added --no-build-isolation to stop pip from spinning up an isolated 
# environment that trips over local workspace module resolution
RUN pip install --no-cache-dir --no-build-isolation -r requirements.txt

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY --from=web-builder /web/dist ./web-dist

RUN mkdir -p /data \
    && groupadd -r runlog && useradd -r -g runlog -d /app runlog \
    && chown -R runlog:runlog /app /data

EXPOSE 8000

ENTRYPOINT ["docker-entrypoint.sh"]