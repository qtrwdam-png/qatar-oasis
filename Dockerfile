# Railway deployment via Dockerfile
# Using node:20 image which already includes npm (no auto-detection issues)
FROM node:20-slim

WORKDIR /app

# Copy entire repo (backend needs ../frontend at runtime)
COPY . .

# Install backend dependencies
RUN cd backend && npm install

EXPOSE 3000

CMD ["sh", "-c", "cd backend && node server.js"]
