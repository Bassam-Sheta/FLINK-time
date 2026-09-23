@echo off
title FLINK Time - Employee Portable Tracker
echo Starting FLINK Time Portable Tracker...
echo.

if not exist "%~dp0UltraAccount.exe" (
    echo ERROR: UltraAccount.exe not found in %~dp0
    echo Please ensure the executable is in the same directory as this launcher.
    pause
    exit /b 1
)

start "" "%~dp0UltraAccount.exe"
if errorlevel 1 (
    echo ERROR: Failed to start UltraAccount.exe (error code: %errorlevel%)
    pause
    exit /b %errorlevel%
)
