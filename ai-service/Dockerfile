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
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Add fontconfig substitution rules: map common Microsoft fonts to free equivalents
# Calibri -> Carlito, Cambria -> Caladea, Arial -> Liberation Sans, etc.
RUN mkdir -p /etc/fonts/conf.d && printf '%s\n' \
    '<?xml version="1.0"?>' \
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' \
    '<fontconfig>' \
    '  <alias><family>Calibri</family><prefer><family>Carlito</family></prefer></alias>' \
    '  <alias><family>Calibri Light</family><prefer><family>Carlito</family></prefer></alias>' \
    '  <alias><family>Cambria</family><prefer><family>Caladea</family></prefer></alias>' \
    '  <alias><family>Cambria Math</family><prefer><family>Caladea</family></prefer></alias>' \
    '  <alias><family>Arial</family><prefer><family>Liberation Sans</family></prefer></alias>' \
    '  <alias><family>Times New Roman</family><prefer><family>Liberation Serif</family></prefer></alias>' \
    '  <alias><family>Courier New</family><prefer><family>Liberation Mono</family></prefer></alias>' \
    '</fontconfig>' \
    > /etc/fonts/conf.d/99-ms-font-substitutions.conf \
    && fc-cache -f -v

# Verify LibreOffice installation
RUN which soffice || echo "LibreOffice soffice not found in PATH"

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
