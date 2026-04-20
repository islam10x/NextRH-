@echo off
setlocal

REM Run from this script's directory
cd /d "%~dp0"

echo Setting up AI Service environment...

if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

echo Activating virtual environment...
call venv\Scripts\activate.bat

echo Installing dependencies...
pip install -r requirements.txt

echo Starting AI Service...
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
