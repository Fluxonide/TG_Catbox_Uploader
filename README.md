# <p align="center">🐱 TG_Catbox_Uploader</p>

<p align="center"> 简体中文 <a href="https://github.com/AnotiaWang/TG_Catbox_Uploader/blob/main/README_en.md">English</a></p>

<p align="center">简单的 Node.js bot，可将 Telegram 的文件上传到 <a href="https://catbox.moe">Catbox.moe</a> 或 <a href="https://litterbox.catbox.moe">Litterbox</a></p>

<p align="center">A simple Node.js bot for uploading Telegram files to <a href="https://catbox.moe">Catbox</a> or <a href="https://litterbox.catbox.moe">Litterbox</a>.</p>

---

## 特性

- [x] 支持音频、视频、文件、贴纸

- [x] 支持通过 URL 下载并上传文件

- [x] 支持 Catbox（单文件限制 200 MB）和 Litterbox（单文件限制 1 GB）

- [x] 多语言支持，可添加翻译文件，自动识别

- [x] 可自定义默认语言、默认服务、Litterbox 文件过期时限、说明文字、同时上传文件的数量

- [x] 支持私聊中使用

- [ ] 支持群组中调用

## 部署

### 一键部署

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/new)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

详细部署指南请查看 [DEPLOY.md](DEPLOY.md)

### 本地部署

- 点个 Star 😘

- Clone 此仓库到本地 / 服务器

- 配置 .env 文件（参照下方说明）

- 运行以下命令（需有 Node.js 环境）：

```Bash
# 需要先安装 pnpm
pnpm install && pnpm start
```

## 环境变量

- `BOT_TOKEN`: 从 BotFather 获得的 Bot token。

- `API_ID`: 从 my.telegram.org 获得的 API ID。

- `API_HASH`: 从 my.telegram.org 获得的 API hash。

- `ADMIN_ID`: 机器人拥有者（你本人）的 ID。可从 [GetIDs Bot](https://t.me/getidsbot) 获取。

- `LOG_CHANNEL_ID`: 用于存放记录的频道 ID。_可留空，仅用于回溯确认文件是否违反 ToS_。

- `DEFAULT_LANG`: [ `zh_CN` / `en_US` ] 用户的默认语言。

- `CATBOX_TOKEN`: [ Optional ] Catbox.moe 账号令牌。如果留空，则为匿名上传文件。填写后可以在 Catbox 账号中管理文件。

- `DEFAULT_SERVICE`: [ `Catbox` / `Litterbox` ] 用户的默认存储服务。

- `DEFAULT_EXPR`: [ `1h` / `12h` / `24h` / `72h` ] 用户的默认 Litterbox 文件过期时间。

- `MAX_DOWNLOADING`: 允许用户同时上传文件的数量（建议 `1`）。

- `WEBHOOK_URL`: [ 可选 ] Webhook 的 URL，若留空则默认使用 Polling。Express.js 监听端口可在代码中修改，需设置反代。

- `DONWLOAD_DC_ID`: [ 可选 ] 下载文件时使用的 [Telegram 数据中心](https://docs.pyrogram.org/faq/what-are-the-ip-addresses-of-telegram-data-centers)。代码中默认为 5，修改为您机器人所在的 DC 可提高下载速度。

- `DOWNLOAD_WORKERS`: [ 可选 ] 同时下载文件的分块数。代码中默认为 5，提高此项可提高下载速度，但可能会带来未知问题。

## Demo

👉👉 [Catbox Uploader Bot](https://t.me/CatboxUploaderBot) 👈👈

## 贡献翻译

1. Fork 此仓库

2. 在 `/src/i18n` 文件夹下新建文件，以 `[语言代码].json` 命名（如有短杠 `-`，改为下划线 `_`）。示例：`zh_CN.json`。语言代码可参考 [这里](http://www.lingoes.net/zh/translator/langcode.htm) 。

3. 按照 `zh_CN.json` 文件进行翻译。所有属性必须翻译。

4. 翻译完善后，提交到你的仓库，然后新建一个 Pull Request 。

> 您也可以在 Web IDE 中编辑文件，然后直接新建 PR。

## 开源许可

MIT License
