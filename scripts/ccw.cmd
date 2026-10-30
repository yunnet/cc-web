@echo off
rem Double-click or run from cmd: ccw.cmd [start|stop|restart|status|logs|token] [-Port N] [-Open]
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ccw.ps1" %*
