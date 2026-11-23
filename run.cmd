@echo off
setlocal
pushd "%~dp0" || exit /b 1
node market_sim.js 100 15 81000 optimized-v2 result.json
set "run_exit=%errorlevel%"
popd
exit /b %run_exit%
