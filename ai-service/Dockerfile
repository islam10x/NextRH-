FROM python:3.11-slim-bookworm

WORKDIR /app

# Install system dependencies including LibreOffice for PDF conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    libtesseract-dev \
    libgl1 \
    libglib2.0-0 \
    poppler-utils \
    libreoffice-writer \
    libreoffice-common \
    fonts-liberation \
    fonts-dejavu \
    fonts-noto \
    fonts-crosextra-caladea \
    fonts-crosextra-carlito \
    wkhtmltopdf \
    libxrender1 \
    libfontconfig1 \
    libxext6 \
    cabextract \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Install Microsoft core fonts (Calibri substitutes + Arial/Times/etc.)
RUN echo "ttf-mscorefonts-installer msttcorefonts/accepted-mscorefonts-eula select true" | debconf-set-selections \
    && apt-get update && apt-get install -y --no-install-recommends ttf-mscorefonts-installer \
    && rm -rf /var/lib/apt/lists/* \
    && fc-cache -f -v

# Verify LibreOffice installation
RUN which soffice || echo "LibreOffice soffice not found in PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
