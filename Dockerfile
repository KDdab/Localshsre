# LocalShare Production Multi-Platform Dockerfile
FROM python:3.12-slim

# Prevent python from buffering stdout and writing .pyc files
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=53317
ENV HOST=0.0.0.0
ENV HEADLESS=true
ENV DISABLE_UDP=true

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Create downloads volume directory
RUN mkdir -p /root/Downloads/LocalShare

EXPOSE 53317

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT}/api/info || exit 1

# Launch using production WSGI server
CMD ["python", "app.py", "--no-browser"]
