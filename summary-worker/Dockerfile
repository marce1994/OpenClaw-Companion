FROM python:3.11-slim

WORKDIR /app

# ffmpeg for audio concatenation, no other system deps
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && \
    rm -rf /var/lib/apt/lists/*

# requests for API calls (OpenRouter, Telegram, Cognee)
RUN pip install --no-cache-dir requests

COPY worker.py .

ENV PYTHONUNBUFFERED=1

CMD ["python", "worker.py"]
