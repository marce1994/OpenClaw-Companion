FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip && \
    rm -rf /var/lib/apt/lists/*

RUN pip3 install --no-cache-dir faster-whisper numpy

WORKDIR /app
COPY server.py .

ENV MODEL=Systran/faster-whisper-large-v3-turbo
ENV DEVICE=cuda
ENV COMPUTE_TYPE=int8
ENV PORT=9000

EXPOSE 9000

CMD ["python3", "server.py"]
