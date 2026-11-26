@echo off
setlocal
pushd "%~dp0" || exit /b 1
node demo/server.js %*
set "run_exit=%errorlevel%"
popd
exit /b %run_exit%
