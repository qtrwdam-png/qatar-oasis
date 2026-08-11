# Railway deployment via Dockerfile
# Using node:20 image which already includes npm (no auto-detection issues)
FROM node:20-slim

WORKDIR /app

# Copy package.json FIRST (separate layer = cached npm install)
COPY backend/package.json backend/package-lock.json ./backend/

# Install backend dependencies (cached unless package.json changes)
RUN cd backend && npm install

# Copy entire repo (backend needs ../frontend at runtime)
# This layer always reflects latest code changes
COPY . .

EXPOSE 3000

CMD ["sh", "-c", "cd backend && node server.js"]
