from setuptools import setup, find_packages

setup(
    name="ai-service",
    version="0.1.0",
    packages=find_packages(),
    install_requires=[
        "fastapi",
        "uvicorn",
        "python-multipart",
        "watchdog",
        "requests",
        "pymupdf",
        "python-docx",
        "tika",
        "pytesseract",
        "easyocr",
        "docxtpl",
        "pdfkit",
        "pydantic",
        "httpx",
        "opencv-python-headless",
        "Pillow",
        "openai",
        "langchain-openai",
    ],
)
