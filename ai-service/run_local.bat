@echo off
setlocal

REM Run from this script's directory
cd /d "%~dp0"

if not exist "venv" (
  echo Creating virtual environment...
  python -m venv venv
)

IF NOT EXIST "venv\Scripts\activate.bat" (
  echo [ERROR] Failed to create virtual environment.
  exit /b 1
)

call venv\Scripts\activate.bat
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
