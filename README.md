# Trae Work Check-in · Cloudflare Worker

> 自动完成 [部署视频](https://youtu.be/pOymJvhhxWI) 每日签到，领取「每日签到 150 Work 专属积分」。
> 免费部署在 Cloudflare Workers，无需服务器，多账号、内置网页管理面板。

---

## ✨ 功能特性

- **每日自动签到**：调用签到接口领取 150 Work 积分，幂等（以服务端 `checked_in` 为准，当天已签自动跳过）
- **多账号支持**：一行一个账号，配置、运行结果、推送分别按账号展示
- **内置管理面板**：访问 `/admin` 即可查看/更新 TOKEN、设备指纹、备注，保存即生效，**14 天换 token 不用改代码、不用重新部署**
- **积分余额可视化**：每个账号实时展示权益包「已用 / 剩余 / 到期日」与合计剩余积分
- **一键手动签到 / 试运行**：按钮触发，结果输出到终端式日志面板，带时间戳、可清空
- **管理密码保护**：浏览器 Basic Auth 弹窗输入密码（不设用户名，只认密码）
- **可选通知**：WxPusher 推送签到结果到微信
- **免费**：Cloudflare Workers 免费额度每天 10 万次请求，这个项目每天跑一次，完全用不完

---

## 📦 部署方式

### 方式一：Wrangler CLI（推荐）

```bash
# 1. 克隆项目并进入目录
git clone https://github.com/你的用户名/trae-work-checkin.git
cd trae-work-checkin

# 2. 登录 Cloudflare
npx wrangler login

# 3. 创建 KV 命名空间（管理网页保存账号配置必需）
npx wrangler kv namespace create TRAE_ACCOUNTS_KV
# 把返回的 id 填到 wrangler.toml 的 [[kv_namespaces]] 部分

# 4. 设置管理密码（保护 /admin 网页）
npx wrangler secret put ADMIN_PASSWORD

# 5.（可选）设置 WxPusher 通知
npx wrangler secret put WXPUSHER_APP_TOKEN
npx wrangler secret put WXPUSHER_UID

# 6. 部署并应用 Cron 触发器
npx wrangler deploy
npx wrangler deploy --triggers
```

### 方式二：Cloudflare Dashboard 手动部署

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages** → **Create** → **Create Worker**
2. 点 **Edit code**，把 `trae-work-checkin-worker.js` 全部内容粘贴进去，点 **Deploy**
3. 回到 Worker 详情页 → **Settings** → **Bindings** → **Add** → **KV Namespace**：
   - Variable name 填 `TRAE_ACCOUNTS_KV`
   - 新建或选一个已有的 KV 命名空间
4. 同页 **Variables and Secrets** 里添加：
   - `ADMIN_PASSWORD`（Secret 类型）：管理网页密码
   - `TRAE_TOKEN`（Secret 类型，可选）：备选账号来源
   - `WXPUSHER_APP_TOKEN` / `WXPUSHER_UID`（Secret 类型，可选）
5. 进入 **Triggers** → **Cron Triggers** → **Add Cron Trigger**：
   - 输入 `0 0 * * *`（UTC 00:00 = 北京时间 08:00）
6. 部署完成，访问 `https://你的worker名.你的子域.workers.dev/admin`

---

## 🔑 获取 TOKEN

每个 Trae 账号需要两个值，格式为 `TOKEN#x-device-id#备注`：

| 字段 | 说明 |
|---|---|
| `TOKEN` | 请求头 `Cloud-IDE-JWT` 的值（可带 `Cloud-IDE-JWT ` 前缀，会自动剥离），约 14 天有效 |
| `x-device-id` | 设备指纹，建议每个账号各用各的避免风控；可留空 |
| `备注` | 日志/推送里的账号名，可省略 |

**获取步骤**：

1. 打开 Trae 客户端并登录
2. 安装Reqable，按转根证书，启动抓包
3. 过滤找到status，找到https://api.trae.cn/trae/api/v2/ug/checkin_credits/status 双击进去原始面板
   - `Cloud-IDE-JWT: eyJhbGciOi...` → 复制冒号后面整段作为 TOKEN
   - `x-device-id: 1694785705300000` → 复制作为设备指纹
4. 把多行配置填到管理网页 `textarea`，格式：

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xxx#1694785705300000#主号
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.yyy##小号A
```

> ⚠️ JWT 等同于账号密码，不要截图、不要提交到公开仓库。

---

## 🖥️ 管理网页

部署后访问 `/admin`，第一次会弹出密码框（用户名随意填，密码就是你设的 `ADMIN_PASSWORD`）。

页面功能：

- **账号配置**：textarea 直接编辑，点「保存并生效」立即写入 KV，无需重新部署
- **手动签到**：立刻跑一轮签到，结果追加到下方「操作结果」面板
- **试运行（不签到）**：只解析当前账号并脱敏展示，不调用签到接口
- **重新加载 / 清除网页配置**：从 KV 重读 / 清除后回退到置顶配置区或环境变量
- **操作结果面板**：所有按钮操作的输出集中在这里，带时间戳、历史追加、可清空
- **积分余额**：每个账号实时显示权益包已用/剩余/到期日

---

## ⏰ 定时任务（Cron）

Cloudflare Cron 用 **UTC**，北京时间 = UTC + 8。

| 北京时间 | UTC | Cron 表达式 |
|---|---|---|
| 每天 08:00 | 00:00 | `0 0 * * *` |
| 每天 09:00 | 01:00 | `0 1 * * *` |
| 每天 10:00 | 02:00 | `0 2 * * *` |

修改后需重新应用触发器：

```bash
npx wrangler deploy --triggers
```

> 免费计划 Cron 最小间隔为每天一次；付费计划可配置多个 cron（一天多次签到没意义，但可以加个下午的余额查询）。

---

## 🔧 配置项

### 读取优先级

```
网页保存的配置（KV）  →  脚本顶部 ACCOUNTS_CONFIG  →  环境变量 / Secret TRAE_TOKEN
```

优先级最高的会覆盖低优先级的。推荐用管理网页保存，过期直接在网页改。

### Secret / 环境变量

| 变量名 | 必填 | 说明 |
|---|---|---|
| `ADMIN_PASSWORD` | 推荐 | 管理网页密码（Basic Auth，只比对密码） |
| `TRAE_TOKEN` | 二选一* | 备选账号来源，多行 `TOKEN#x-device-id#备注` |
| `TRAE_ACCOUNTS_KV` | 推荐 | KV 绑定名，用于网页保存配置 |
| `WXPUSHER_APP_TOKEN` | 可选 | WxPusher 应用 token，用于推送通知 |
| `WXPUSHER_UID` | 可选 | WxPusher 接收人 UID |

\* 账号来源三选一即可：管理网页 / 置顶 `ACCOUNTS_CONFIG` / Secret `TRAE_TOKEN`。

---

## 📡 路由一览

| 路径 | 方法 | 说明 |
|---|---|---|
| `/` | GET | 服务说明 + 上次运行摘要 |
| `/admin` | GET | 管理网页（Basic Auth） |
| `/admin/data` | GET | 当前配置 JSON（Basic Auth） |
| `/admin/save` | POST | 保存配置到 KV（Basic Auth） |
| `/admin/clear` | POST | 清除网页配置（Basic Auth） |
| `/dry-run` | GET | 只解析账号（脱敏），不调接口 |
| `/run` | GET/POST | 立即签到一轮 |
| `/run?balance-only=1` | GET | 只查余额不签到 |
| `/run?force=1` | GET | 强制签到（忽略已签状态） |
| `/run?no-notify=1` | GET | 本次不发推送 |

---

## 📁 项目结构

```
.
├── trae-work-checkin-worker.js   # Worker 主脚本（部署这个）
├── wrangler.toml                  # Wrangler 部署配置
├── trae-worker-local-test.mjs     # 本地测试（40 项断言）
├── preview-server.mjs            # 本地预览管理网页（开发用）
└── README.md
```

本地开发：

```bash
node trae-worker-local-test.mjs          # 跑测试
PREVIEW_AUTO_AUTH=1 node preview-server.mjs  # 本地预览管理页
```

---

## ❓ 常见问题

**Q: TOKEN 多久过期？**
A: 约 14 天（336 小时）。过期后重新抓包，在 `/admin` 网页替换对应行的 TOKEN，点「保存并生效」即可，不用改代码也不用重新部署。

**Q: 显示「已过期 X 天，请更新令牌」怎么办？**
A: 按上面的「获取 TOKEN」步骤重新抓包替换即可。

**Q: 多账号会被风控吗？**
A: 每个账号填独立的 `x-device-id`，不要多个账号共用同一个设备指纹。脚本每天只跑一次，频率很低。

**Q: 一定要绑 KV 吗？**
A: 不绑 KV 也能跑（账号写在置顶 `ACCOUNTS_CONFIG` 或 `TRAE_TOKEN` Secret 里），但 `/admin` 网页只能看不能保存，每次换 token 都得改代码重新部署。

**Q: 签到接口返回错误？**
A: 打开 `/admin` 点「试运行」看具体报错；常见原因是 TOKEN 过期或 x-device-id 缺失。

---

## ⚠️ 免责声明

- 本项目仅供学习交流，自动签到可能违反 Trae 用户协议，使用风险自负
- 所有 TOKEN / 密码 / 配置均存储在你自己的 Cloudflare 账号下，作者无法访问
- 请勿将含真实 TOKEN 的文件提交到公开仓库

## License

MIT
#（注：内容由AI生成）
