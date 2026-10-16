@echo off
REM Wrapper linker: wrapper terminal Hermes menyuntik TMP berbentuk relatif
REM ("C:\d\...\.hermes-tmp.XXXX") yang tidak pernah ada di disk, sehingga
REM link.exe gagal LNK1104. Di sini TMP dipaksa absolut sebelum link asli jalan.
setlocal EnableExtensions
if not exist "C:\rusttmp" mkdir "C:\rusttmp" >nul 2>&1
set "TMP=C:\rusttmp"
set "TEMP=C:\rusttmp"
"%~dp0link-real.bat" %*
exit /b %ERRORLEVEL%
