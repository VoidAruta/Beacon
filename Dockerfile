# Минимальный Dockerfile для запуска Beacon Control Panel в контейнере (опционально)
FROM python:3.12-slim-bookworm

WORKDIR /opt/beacon

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends git curl ca-certificates sqlite3 && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --create-home --home-dir /home/beacon-runner --shell /usr/sbin/nologin beacon-runner

COPY requirements.txt /opt/beacon/requirements.txt
RUN pip install --no-cache-dir -r /opt/beacon/requirements.txt

COPY . /opt/beacon

RUN mkdir -p /opt/beacon/data/secrets /opt/beacon/data/logs /opt/beacon/data/backups /opt/beacon/data/generated /opt/beacon/projects && \
    chmod 0700 /opt/beacon/data /opt/beacon/data/secrets /opt/beacon/data/backups && \
    chown -R beacon-runner:beacon-runner /opt/beacon/projects /opt/beacon/data/logs

ENV PYTHONUNBUFFERED=1
ENV BEACON_DIR=/opt/beacon
ENV BEACON_PORT=8050

EXPOSE 8050

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${BEACON_PORT:-8050}/api/auth/me")" && [ "$code" = "200" -o "$code" = "401" ] || exit 1

CMD ["python3", "-m", "beacon"]
