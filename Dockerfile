# Минимальный Dockerfile для запуска Aruta Control Panel в контейнере (опционально)
FROM python:3.12-slim-bookworm

WORKDIR /opt/aruta

RUN apt-get update -qq && \
    apt-get install -y --no-install-recommends git curl ca-certificates sqlite3 && \
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --create-home --home-dir /home/hub-runner --shell /bin/bash hub-runner

COPY requirements.txt /opt/aruta/requirements.txt
RUN pip install --no-cache-dir -r /opt/aruta/requirements.txt

COPY . /opt/aruta

RUN mkdir -p /opt/aruta/data/secrets /opt/aruta/logs /opt/aruta/projects && \
    chmod 0700 /opt/aruta/data/secrets && \
    chown -R hub-runner:hub-runner /opt/aruta/projects /opt/aruta/logs

ENV PYTHONUNBUFFERED=1
ENV ARUTA_PORT=8050

EXPOSE 8050

CMD ["python3", "-m", "aruta", "--port", "8050"]
