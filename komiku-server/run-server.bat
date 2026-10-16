cd /d D:\project\komiku-server
set TMP=C:usttmp
set PORT=8788
start /B "" target\debug\komiku-server.exe > server.log 2>&1
