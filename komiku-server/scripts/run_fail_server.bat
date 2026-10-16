@echo off
REM Smoke partial-failure: 2 sumber dimatikan lewat env ke host mati.
REM Server di port 8789 (instance terpisah dari smoke 8788).
setlocal
set "TMP=C:\rusttmp"
set "TEMP=C:\rusttmp"
if not exist "C:\rusttmp" mkdir "C:\rusttmp"
cd /d D:\project\komiku-server
set PORT=8789
set KIRYUU_BASE=http://127.0.0.1:1
set MANGAKU_BASE=http://127.0.0.1:1
start /B "" target\debug\komiku-server.exe > target\fail_server.log 2>&1
for /f "tokens=2" %%i in ('tasklist /fi "imagename eq komiku-server.exe" /nh ^| findstr /r "[0-9]"') do echo %%i > target\fail_server.pid 2>nul
echo SERVER STARTED > target\fail_server.started
:wait
timeout /t 1 /nobreak >nul
tasklist /fi "imagename eq komiku-server.exe" /nh | findstr /r "[0-9]" >nul
if not errorlevel 1 goto wait
echo SERVER EXITED > target\fail_server.ended
