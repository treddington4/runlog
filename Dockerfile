FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app/ .
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN mkdir -p /data \
    && groupadd -r runlog && useradd -r -g runlog -d /app runlog \
    && chown -R runlog:runlog /app /data

EXPOSE 8000

ENTRYPOINT ["docker-entrypoint.sh"]
