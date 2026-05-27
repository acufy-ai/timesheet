FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for PDF/image processing.
# procps provides pgrep, used by the worker container healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    poppler-utils \
    antiword \
    libpq-dev \
    gcc \
    procps \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create uploads directory and a non-root user, then hand /app to it.
RUN useradd --create-home --shell /sbin/nologin --uid 1001 appuser \
    && mkdir -p /app/uploads/attachments /app/uploads/tenant-logos \
    && chown -R appuser:appuser /app

# Install gosu so the entrypoint can drop from root to appuser cleanly.
# (We need root briefly to chown the named-volume mount that docker-compose
# overlays on /app/uploads — see entrypoint.sh.)
RUN apt-get update && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

# Entrypoint runs as root, fixes the volume ownership if it drifted (the
# named volume `uploads:/app/uploads` persists across image rebuilds and
# can keep stale ownership from an older image variant), then drops to
# appuser to run the actual command. The brief root window is bounded to
# a single chown call.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Note: USER is intentionally NOT set here — the entrypoint starts as
# root and uses ``gosu appuser`` to demote before exec-ing the command.

EXPOSE 8000

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default: run the API server. The entrypoint passes any CMD to ``gosu
# appuser exec``, so the running uvicorn (or worker) process is the
# unprivileged user.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
