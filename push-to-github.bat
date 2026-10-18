@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title 迷宫逃生 - 推送到 GitHub

echo.
echo ==========================================
echo    迷宫逃生 - 推送到 GitHub
echo ==========================================
echo.

where git >nul 2>nul
if errorlevel 1 (
  echo [X] 没有检测到 git
  echo     请先安装: https://git-scm.com/downloads
  pause
  exit /b 1
)

set /p GH_USER=你的 GitHub 用户名: 
if "!GH_USER!"=="" (
  echo [X] 用户名不能为空
  pause
  exit /b 1
)

set /p REPO=仓库名 [默认 maze-escape]: 
if "!REPO!"=="" set REPO=maze-escape

echo.
echo -^> 将推送到 https://github.com/!GH_USER!/!REPO!
set /p OK=确认继续？(y/n) 
if /i not "!OK!"=="y" (
  echo 已取消
  pause
  exit /b 0
)

if not exist .git (
  git init -q
  git branch -M main
)

git add -A
git commit -q -m "feat: 迷宫逃生 - 迭代DFS/BFS寻路/迷雾视野/角色个性化" 2>nul
if errorlevel 1 (
  echo -^> 没有新改动，跳过 commit
) else (
  echo [OK] 已提交
)

git remote remove origin 2>nul
git remote add origin https://github.com/!GH_USER!/!REPO!.git

echo.
echo -^> 开始推送
echo.
echo   首次会要求输入 GitHub 用户名和 Personal Access Token
echo   注意: GitHub 已不支持密码, 必须用 Token
echo   获取: GitHub -^> Settings -^> Developer settings
echo         -^> Personal access tokens -^> Tokens (classic)
echo         -^> Generate new token, 勾选 repo 权限
echo.

git push -u origin main
if errorlevel 1 (
  echo.
  echo [X] 推送失败, 请检查上面的错误信息
  echo     常见原因: 仓库还没在 GitHub 上创建
  pause
  exit /b 1
)

echo.
echo ==========================================
echo  [OK] 推送成功
echo ==========================================
echo.
echo 最后一步(只需做一次):
echo   1. 打开 https://github.com/!GH_USER!/!REPO!/settings/pages
echo   2. Source 选 "GitHub Actions"
echo   3. 等 1~2 分钟, 访问:
echo.
echo      https://!GH_USER!.github.io/!REPO!/
echo.
pause
