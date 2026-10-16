@echo off
REM Build komiku-server dengan TMP/TEMP absolut (wrapper Hermes menyuntik TMP relatif
REM yang membuat link.exe gagal LNK1104).
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "TMP=C:\rusttmp"
set "TEMP=C:\rusttmp"
if not exist "C:\rusttmp" mkdir "C:\rusttmp"
cd /d "%~dp0"
cargo build -j 2 %* 
exit /b %ERRORLEVEL%
