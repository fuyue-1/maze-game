#!/usr/bin/env bash
# ============================================================
# 迷宫逃生 —— 一键推送到 GitHub（macOS / Linux）
# 用法：bash push-to-github.sh
# ============================================================
set -e

echo ""
echo "=========================================="
echo "   迷宫逃生 · 推送到 GitHub"
echo "=========================================="
echo ""

# 检查 git
if ! command -v git >/dev/null 2>&1; then
  echo "✗ 没检测到 git。请先安装：https://git-scm.com/downloads"
  exit 1
fi

# 输入用户名
read -r -p "你的 GitHub 用户名: " GH_USER
if [ -z "$GH_USER" ]; then echo "✗ 用户名不能为空"; exit 1; fi

read -r -p "仓库名 [默认 maze-escape]: " REPO
REPO=${REPO:-maze-escape}

echo ""
echo "→ 将推送到 https://github.com/$GH_USER/$REPO"
read -r -p "确认继续？(y/n) " OK
if [ "$OK" != "y" ] && [ "$OK" != "Y" ]; then echo "已取消"; exit 0; fi

# 初始化
if [ ! -d .git ]; then
  git init -q
  git branch -M main
fi

git add -A
if git diff --cached --quiet 2>/dev/null; then
  echo "→ 没有新改动，跳过 commit"
else
  git commit -q -m "feat: 迷宫逃生 - 迭代DFS/BFS寻路/迷雾视野/角色个性化"
  echo "✓ 已提交"
fi

# 设置远端
if git remote | grep -q origin; then
  git remote set-url origin "https://github.com/$GH_USER/$REPO.git"
else
  git remote add origin "https://github.com/$GH_USER/$REPO.git"
fi

echo "→ 开始推送（首次会要求输入 GitHub 用户名和 Personal Access Token）"
echo ""
echo "  如果提示密码错误：GitHub 已不支持密码，需要用 Token"
echo "  获取方式：GitHub → Settings → Developer settings"
echo "           → Personal access tokens → Tokens (classic)"
echo "           → Generate new token，勾选 repo 权限"
echo ""

git push -u origin main

echo ""
echo "=========================================="
echo " ✓ 推送成功！"
echo "=========================================="
echo ""
echo "最后一步（只需做一次）："
echo "  1. 打开 https://github.com/$GH_USER/$REPO/settings/pages"
echo "  2. Source 选 'GitHub Actions'"
echo "  3. 等 1~2 分钟，访问："
echo ""
echo "     https://$GH_USER.github.io/$REPO/"
echo ""
