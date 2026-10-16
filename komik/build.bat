@echo off
REM Build/test workspace komik dengan TMP/TEMP absolut.
REM Kenapa: wrapper terminal Hermes menyuntik TMP/TEMP MSYS-style tiap proses
REM (mis. /d/project/.../.hermes-tmp.XXXX) yang di-resolve link.exe jadi
REM C:\d\project\... dan tidak pernah ada -> LNK1104 untuk semua build script.
REM Skrip bash scripts/build.sh TIDAK cukup karena injector menempel per-spawn;
REM jalur cmd-native ini yang bekerja (pola sama seperti komiku-server/build.bat).
setlocal
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
set "TMP=C:\rusttmp"
set "TEMP=C:\rusttmp"
if not exist "C:\rusttmp" mkdir "C:\rusttmp"
cd /d "%~dp0"
cargo %*
exit /b %ERRORLEVEL%
