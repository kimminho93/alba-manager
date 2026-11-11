@echo off
chcp 65001 >nul
cd /d "%~dp0"

if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs"

where node >nul 2>nul
if %errorlevel%==0 (
    echo [서버 모드] Node.js가 감지되어 로컬 서버(http://localhost:8000)를 시작합니다...
    start "" "http://localhost:8000"
    node server/app.js --port 8000
) else (
    echo [웹 단독 모드] Node.js가 설치되어 있지 않아 서버 없이 브라우저에서 바로 실행합니다!
    start "" "%~dp0web\index.html"
)
