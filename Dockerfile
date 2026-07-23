FROM node:22-slim AS web-builder
WORKDIR /web
COPY web/package.json web/package-lock.json ./

# DEBUG: Check available memory before npm install
RUN echo "--- MEMORY BEFORE NPM CI ---" && free -m || cat /proc/meminfo

# DEBUG: Run npm ci with verbose logging to see exactly where it hangs
RUN echo "--- STARTING NPM CI ---"
RUN npm ci --loglevel verbose

COPY web/ .

# DEBUG: Check memory before React build
RUN echo "--- MEMORY BEFORE NPM BUILD ---" && free -m || cat /proc/meminfo
RUN echo "--- STARTING NPM BUILD ---"
RUN npm run build

FROM python:3.12-slim
WORKDIR /srv

COPY requirements.txt pyproject.toml ./
COPY app ./app

# DEBUG: Check memory before Python pip install
RUN echo "--- MEMORY BEFORE PIP INSTALL ---" && free -m || cat /proc/meminfo
RUN echo "--- STARTING PIP INSTALL ---"

# DEBUG: Added -v (verbose) to pip install
RUN pip install -v --no-cache-dir -r requirements.txt \
    && pip install -v --no-cache-dir --no-deps .

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY --from=web-builder /web/dist ./app/web-dist

RUN mkdir -p /data \
    && groupadd -r runlog && useradd -r -g runlog -d /srv runlog \
    && chown -R runlog:runlog /srv /data

EXPOSE 8000
USER runlog

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/healthz', timeout=2)" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]