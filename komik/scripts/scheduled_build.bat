@echo off
REM Dijalankan Task Scheduler (di luar sesi terminal Hermes) supaya TMP/TEMP
REM tidak disuntik injector wrapper. Arg1 = label lane (penanda marker),
REM arg2.. = perintah cargo (check/test/run ...).
REM Marker: target\sched_<label>.exit (exit code) + target\sched_<label>.log
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "TMP=C:\rusttmp"
set "TEMP=C:\rusttmp"
if not exist "C:\rusttmp" mkdir "C:\rusttmp"
cd /d D:\project\komik
if not exist "target" mkdir "target"
set "LABEL=%~1"
if "%LABEL%"=="" set "LABEL=default"
shift
cargo %1 %2 %3 %4 %5 %6 %7 %8 %9 > "D:\project\komik\target\sched_%LABEL%.log" 2>&1
echo %ERRORLEVEL% > "D:\project\komik\target\sched_%LABEL%.exit"
