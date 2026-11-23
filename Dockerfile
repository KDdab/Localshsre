# Production Node.js Multi-Platform Dockerfile
FROM node:20-alpine

# Set production environment
ENV NODE_ENV=production
ENV PORT=5000
ENV HOST=0.0.0.0
ENV SHARE_EXPIRATION_MINUTES=30
ENV STORAGE_PATH=/app/server/uploads

WORKDIR /app

# Install dependencies first for better caching
COPY package*.json ./
RUN npm ci --omit=dev || npm install --production

# Copy server and public assets
COPY server/ ./server/
COPY public/ ./public/

# Create persistent uploads directory
RUN mkdir -p /app/server/uploads

EXPOSE 5000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:${PORT}/api/health || exit 1

# Start server
CMD ["node", "server/server.js"]
