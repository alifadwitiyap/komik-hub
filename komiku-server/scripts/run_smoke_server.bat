@echo off
REM Jalankan server komiku-server (PORT=8788) via Task Scheduler, tulis PID,
REM lalu tunggu sampai proses keluar (server jalan sampai di-taskkill).
REM Log: D:\project\komiku-server\target\smoke_server.log
setlocal
set "TMP=C:\rusttmp"
set "TEMP=C:\rusttmp"
if not exist "C:\rusttmp" mkdir "C:\rusttmp"
cd /d D:\project\komiku-server
set PORT=8788
start /B "" target\debug\komiku-server.exe > target\smoke_server.log 2>&1
for /f "tokens=2" %%i in ('tasklist /fi "imagename eq komiku-server.exe" /nh ^| findstr /r "[0-9]"') do echo %%i > target\smoke_server.pid 2>nul
echo SERVER STARTED > target\smoke_server.started
:wait
timeout /t 1 /nobreak >nul
tasklist /fi "imagename eq komiku-server.exe" /nh | findstr /r "[0-9]" >nul
if not errorlevel 1 goto wait
echo SERVER EXITED > target\smoke_server.ended
