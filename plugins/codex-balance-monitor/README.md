# Codex Balance Monitor

在 Cursor / VSCode 状态栏里直接查看 `codex-for.me` 余量，并支持一键刷新。

## 功能

- 状态栏实时显示余额（`card_balance`）
- 支持命令面板手动刷新
- 支持自动刷新（默认 60 秒）
- 支持详情面板查看注册时间、到期时间、每日预算、今日已用、今日请求数、今日 Token、套餐信息
- 支持紧凑模式（更适合小屏幕，突出核心字段）
- Token 优先存入安全存储（`SecretStorage`）

## 安装与运行

1. 安装依赖

```bash
npm install
```

2. 编译扩展

```bash
npm run compile
```

3. 在 VSCode/Cursor 中调试

- 打开本项目
- 按 `F5` 启动 Extension Development Host
- 在新窗口命令面板执行：
  - `Codex 余额: 设置 Token`
  - `Codex 余额: 立即刷新`
  - `Codex 余额: 切换紧凑模式`

## Token 获取方式

1. 打开 [codex-for.me dashboard](https://codex-for.me/dashboard.html) 并保持登录
2. 打开浏览器开发者工具
3. 在 `Application` / `本地存储` 中找到 `authToken`
4. 复制后在命令面板运行 `Codex 余额: 设置 Token`

> 你也可以把 Token 写到设置 `codexBalance.authToken`，但不如安全存储方式安全。

## 可配置项

- `codexBalance.apiBaseUrl`：默认 `https://codex-for.me/web/api/v1`
- `codexBalance.dashboardUrl`：默认 `https://codex-for.me/dashboard.html`
- `codexBalance.autoRefreshSeconds`：默认 `60`，设 `0` 可关闭自动刷新
- `codexBalance.requestTimeoutMs`：默认 `10000`
- `codexBalance.authToken`：可选，明文 Token（不推荐）
- `codexBalance.compactMode`：默认 `false`，开启后使用紧凑面板布局

## 打包 VSIX

```bash
npm run package
```

会在项目根目录生成 `.vsix` 文件，可在 Cursor / VSCode 中手动安装。
