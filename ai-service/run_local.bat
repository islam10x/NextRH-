@echo off
setlocal

REM Run from this script's directory
cd /d "%~dp0"

IF NOT EXIST "venv\Scripts\activate.bat" (
  echo [ERROR] Virtual environment not found: venv\Scripts\activate.bat
  echo Create it first with: python -m venv venv
  exit /b 1
)

call venv\Scripts\activate.bat
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
