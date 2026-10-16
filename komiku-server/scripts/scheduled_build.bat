@echo off
REM Dijalankan Task Scheduler (di luar sesi terminal Hermes) supaya TMP/TEMP
REM tidak disuntik injector wrapper (LNK1104 kalau relatif).
REM Arg1 = label lane (penanda marker), arg2.. = perintah cargo (check/build/run).
REM Marker: target\sched_<label>.exit (exit code) + target\sched_<label>.log
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "TMP=C:\rusttmp"
set "TEMP=C:\rusttmp"
if not exist "C:\rusttmp" mkdir "C:\rusttmp"
cd /d D:\project\komiku-server
if not exist "target" mkdir "target"
set "LABEL=%~1"
if "%LABEL%"=="" set "LABEL=default"
shift
cargo %1 %2 %3 %4 %5 %6 %7 %8 %9 > "D:\project\komiku-server\target\sched_%LABEL%.log" 2>&1
echo %ERRORLEVEL% > "D:\project\komiku-server\target\sched_%LABEL%.exit"
