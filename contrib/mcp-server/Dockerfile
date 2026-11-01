# Build from this directory: docker build -t mediaocd-mcp .
# To update Python: change tag and digest together.
FROM python:3.12.15-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY server.py /app/server.py

# Inside a container the server has to listen on every interface to be reachable through
# a published port, so MCP_AUTH_TOKEN becomes mandatory: without it the server refuses to
# start. Publish the port on the loopback address of the host unless you need otherwise.
ENV MCP_HOST=0.0.0.0
EXPOSE 8016

USER 10001:10001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["python", "-c", "import os, socket; socket.create_connection(('127.0.0.1', int(os.environ.get('MCP_PORT') or 8016)), 3).close()"]

CMD ["python", "server.py"]
