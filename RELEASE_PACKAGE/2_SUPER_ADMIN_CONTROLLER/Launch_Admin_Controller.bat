@echo off
title FLINK Time - Super Admin Controller
echo Opening FLINK Time Super Admin Controller...
echo.

if not exist "%~dp0admin_ui.html" (
    echo ERROR: admin_ui.html not found in %~dp0
    pause
    exit /b 1
)

start "" "%~dp0admin_ui.html"
if errorlevel 1 (
    echo ERROR: Failed to open admin_ui.html in default browser.
    pause
    exit /b %errorlevel%
)
