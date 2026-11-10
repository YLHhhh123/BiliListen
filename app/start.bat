@echo off
rem ============================================================
rem  BiliListen 启动器
rem  坑：本机全局设置了 ELECTRON_RUN_AS_NODE=1，会让 electron.exe
rem      以纯 Node 模式运行（app 模块不可用），必须先清掉。
rem ============================================================
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
"%~dp0node_modules\electron\dist\electron.exe" "%~dp0" %*
endlocal
