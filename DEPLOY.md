# 部署指南 —— 让所有人都能玩

三种方式，按推荐顺序排列。

---

## 方式一：GitHub Pages（推荐，免费、全球可访问、自动更新）

### 效果

部署完成后你会得到一个网址，比如：

```
https://yourname.github.io/maze-escape/
```

任何人点开就能玩，手机、电脑都行。修改代码后推送一次，网站自动更新。

### 步骤（网页操作，不需要命令行）

**1. 注册 / 登录 GitHub**

打开 https://github.com ，没账号就注册一个（免费）。

**2. 新建仓库**

- 右上角 `+` → `New repository`
- Repository name 填：`maze-escape`（名字随意，但建议用英文）
- 选 **Public**（公开仓库才能免费用 Pages）
- **不要**勾选 Add a README / .gitignore / license（我们要上传自己的）
- 点 `Create repository`

**3. 上传文件**

在新建的仓库页面点 `uploading an existing file`（或 `Add file` → `Upload files`），
把 `maze-game` 文件夹里的**这些内容全部拖进去**：

```
index.html
css/           ← 整个文件夹
js/            ← 整个文件夹
tests/         ← 可选，但建议传（体现工程质量）
README.md
DEPLOY.md
LICENSE
.gitignore
```

> ⚠️ 关键：`index.html` 必须在仓库**根目录**，不能是 `maze-game/index.html` 这种套一层。
> 拖拽时如果文件夹不支持，用 GitHub Desktop 或下面的命令行方式。

然后点底部 `Commit changes`。

**4. 开启 Pages**

- 仓库页 → `Settings` → 左侧 `Pages`
- `Source` 选 **Deploy from a branch**
- `Branch` 选 **main**（或 master），目录选 **/ (root)**
- 点 `Save`

**5. 等待 1~2 分钟**

刷新 Pages 页面，顶部会出现：

```
Your site is live at https://yourname.github.io/maze-escape/
```

点开就是你的游戏，把这个链接发给任何人都能玩。

### 可选：用命令行推送（更专业，也更快）

```bash
cd maze-game
git init
git add .
git commit -m "feat: 迷宫逃生游戏 - 迭代DFS/BFS寻路/迷雾视野"
git branch -M main
git remote add origin https://github.com/<你的用户名>/maze-escape.git
git push -u origin main
```

推送后按上面第 4 步开 Pages 即可。

如果配了 SSH key 或 GitHub CLI，也可以：

```bash
gh repo create maze-escape --public --source=. --push
```

---

## 方式二：Gitee Pages（国内访问更快）

国内访问 GitHub Pages 有时较慢。如果主要给国内同学玩，可以用 Gitee。

1. 注册 https://gitee.com （需**实名认证**才能用 Pages）
2. 新建公开仓库，上传同样的一堆文件
3. 仓库 → `服务` → `Gitee Pages` → 部署分支选 `master`、目录 `/` → `启动`
4. 得到 `https://<用户名>.gitee.io/<仓库名>`

> 免费版的坑：每次改代码后要手动进 Pages 页面点一次「更新」才生效。

---

## 方式三：局域网临时演示（不联网也能给人看）

适合答辩/课堂现场，手机和电脑连同一个 Wi-Fi：

```bash
cd maze-game
python3 -m http.server 8080      # macOS/Linux
# 或
python -m http.server 8080        # Windows

# 查本机内网 IP
ipconfig                          # Windows
ifconfig | grep "inet "           # macOS/Linux
```

手机浏览器访问 `http://192.168.x.x:8080` 即可。

---

## 常见问题

### Q1：打开网站是白屏 / 没有样式？

- 检查 `index.html` 是否在仓库根目录（不是子文件夹里）
- 打开浏览器 F12 → Console，看是否有 404（说明路径不对）
- GitHub Pages 部署后需要等 1~2 分钟，刚 push 完立刻访问可能还是 404

### Q2：改了代码但网站没变？

- 等 1~2 分钟（Pages 有构建延迟）
- 强制刷新：`Ctrl+Shift+R`（Windows）/ `Cmd+Shift+R`（Mac）
- 手机浏览器可能缓存更狠，试试无痕模式

### Q3：想要一个能保存全网成绩的排行榜？

现在默认是**本机排行榜**。要变成全网共享：

1. 注册 https://www.bmob.cn （国内免费 BaaS）
2. 创建应用 → 新建数据表 `rank`，字段：
   | 字段名 | 类型 |
   |--------|------|
   | username | String |
   | time | Number |
   | size | String |
3. 在 Bmob 控制台「设置 → 应用密钥」拿到 `Application ID` 和 `REST API Key`
4. 打开 `js/bmob.js`，填进顶部 `CONFIG`

```js
const CONFIG = {
  APPLICATION_ID: '你的 Application ID',
  REST_API_KEY: '你的 REST API Key',
  ...
};
```

5. 重新推送代码。之后成绩会存云端，**断网时仍会自动降级到本机榜**。

### Q4：想换个仓库名 / 绑定自己的域名？

- 改名：Settings → Repository name 改完，Pages 地址会跟着变
- 自定义域名：Settings → Pages → Custom domain，填你的域名，并在域名商处加 CNAME 记录

---

## 检查清单

上线前对照一遍：

- [ ] `index.html` 在仓库根目录
- [ ] `css/` 和 `js/` 文件夹完整上传（不是只有 html）
- [ ] 仓库是 Public
- [ ] Pages 的 Branch 选的是主分支、目录是 `/`
- [ ] 手机打开测试过（滑动、方向键、开始游戏）
- [ ] 如果配了 Bmob，测过成绩提交
