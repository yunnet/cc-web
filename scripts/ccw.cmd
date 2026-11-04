@echo off
rem Double-click or run from cmd: ccw.cmd [start|stop|restart|status|logs|token] [stable|dev|all|<port>] [-Open]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ccw.ps1" %*
