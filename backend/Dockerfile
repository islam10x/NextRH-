FROM node:20-alpine AS development

WORKDIR /app

# Install document parsing runtime tools used by file-storage.service.ts
RUN apk add --no-cache \
    python3 \
    py3-pip \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    tesseract-ocr-data-fra \
    tesseract-ocr-data-osd \
    openjdk17-jre-headless \
    && pip3 install --no-cache-dir --break-system-packages pymupdf

# Install dependencies
COPY package*.json ./
RUN npm ci

# Copy source
COPY . .

# Build
RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start:dev"]

# Production stage
FROM node:20-alpine AS production

WORKDIR /app

RUN apk add --no-cache \
    python3 \
    py3-pip \
    tesseract-ocr \
    tesseract-ocr-data-eng \
    tesseract-ocr-data-fra \
    tesseract-ocr-data-osd \
    openjdk17-jre-headless \
    && pip3 install --no-cache-dir --break-system-packages pymupdf

COPY package*.json ./
RUN npm ci --only=production

COPY --from=development /app/dist ./dist

EXPOSE 3000

CMD ["node", "dist/src/main.js"]
