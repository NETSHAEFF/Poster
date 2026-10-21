@echo off
title NameVids AutoPoster
echo Starting NameVids AutoPoster...
node server.js
if %errorlevel% neq 0 pause
