@echo off
REM Vite dev server for the Admin Panel.
REM
REM Launched through this shim rather than directly, because the project folder
REM name contains a space (D:\Work\Admin Panal). The preview launcher builds an
REM unquoted command line, so a runtimeExecutable that resolves under
REM "C:\Program Files\..." gets split at the space and fails. This file lives on
REM a space-free path and does its own quoting.
cd /d "D:\Work\Admin Panal"
call npm run dev
