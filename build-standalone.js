#!/usr/bin/env node
/**
 * build-standalone.js —— 把 index.html + css + js + vendor 打成单文件 standalone.html
 * 用法：node build-standalone.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

let out = html;

// 内联 CSS
out = out.replace(/<link rel="stylesheet" href="css\/style.css">/, () => {
  const css = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
  return '<style>\n' + css + '\n</style>';
});

// 内联所有 script（保留顺序）
out = out.replace(/<script src="([^"]+)"><\/script>/g, (m, src) => {
  const code = fs.readFileSync(path.join(ROOT, src), 'utf8');
  return '<script>\n' + code + '\n</script>';
});

const dest = path.join(ROOT, 'standalone.html');
fs.writeFileSync(dest, out);
console.log('standalone.html 生成完毕:', (fs.statSync(dest).size / 1024).toFixed(0) + ' KB');

// 同步到工作区的单文件版
const copy = '/workspace/小龙迷宫逃生-单文件版.html';
try {
  if (fs.existsSync('/workspace/迷宫逃生-单文件版.html')) {
    fs.unlinkSync('/workspace/迷宫逃生-单文件版.html');   // 清理旧名，避免两份混淆
  }
  fs.copyFileSync(dest, copy);
  console.log('已同步到:', copy);
} catch (e) {
  console.log('同步失败（可忽略）:', e.message);
}
