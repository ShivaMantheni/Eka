@echo off
echo ============================================================
echo   DUT Automation System — Starting...
echo ============================================================
echo.

set SCRIPT_DIR=%~dp0
set PYTHON_DIR=%SCRIPT_DIR%python
set PYTHON=%PYTHON_DIR%\python.exe

if not exist "%PYTHON%" (
    echo ERROR: Python not found at %PYTHON%
    echo Please ensure the python directory exists in this folder.
    pause
    exit /b 1
)

echo [OK] Python found: %PYTHON%
echo.

echo Starting FastAPI server on http://localhost:8000
echo   Dashboard:  http://localhost:8000
echo   API Docs:   http://localhost:8000/docs
echo   Health:     http://localhost:8000/health
echo.
echo Press Ctrl+C to stop the server.
echo ============================================================
echo.

cd /d "%SCRIPT_DIR%"
"%PYTHON%" -m uvicorn main:app --host 0.0.0.0 --port 8000 --log-level info

pause

