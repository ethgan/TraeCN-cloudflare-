/**
 * trae-work-checkin — Cloudflare Worker 版
 * =================================================================
 *
 * 【功能】
 *   1. 调用签到接口领取「每日签到 150 Work 专属积分」。
 *   2. 查询账户积分余额（解析权益包列表，含已用/剩余）。
 *   3. 幂等：以服务端 checked_in 为准，当天已签则跳过（force 强制重签）。
 *   4. 多账号：TRAE_TOKEN 每行一个账号，TOKEN#x-device-id#备注。
 *   5. 内置账号管理网页（GET /admin）：JWT 约 14 天过期后，直接在网页上
 *      更新 TOKEN / x-device-id，保存即生效，无需改代码重新部署。
 *
 * 【账号配置读取优先级】
 *   网页保存的配置（KV） → 置顶配置区 ACCOUNTS_CONFIG → 环境变量/Secret TRAE_TOKEN
 *
 * 【部署】
 *   1. 本文件作为 Worker 上传（esm 格式）。
 *   2. 网页管理需要绑定 KV 命名空间为 TRAE_ACCOUNTS_KV（见 wrangler.toml）。
 *   3. （推荐）设置管理密码：ADMIN_PASSWORD，保护 /admin 网页。
 *   4. 配置 Cron Trigger（如 0 1 * * *，UTC，每天 1 次；付费计划可更频繁）。
 *   5. 通知：WxPusher（可选），设置 WXPUSHER_APP_TOKEN / WXPUSHER_UID。
 *
 * 【手动触发 / 管理页】
 *   GET  /                -> 服务说明；若绑定了 KV 并跑过，则返回上次运行摘要
 *   GET  /dry-run         -> 只解析并展示账号（令牌脱敏），不调用任何接口
 *   GET  /run             -> 立即签到一轮（也可 POST 任意路径触发）
 *   ?balance-only / ?force / ?no-notify  -> 与 Python 版 CLI 参数等价
 *   GET  /admin           -> 账号管理网页（查看/更新 TOKEN、x-device-id、备注）
 *                           设置了 ADMIN_PASSWORD 时，浏览器先弹出密码框（HTTP
 *                           Basic Auth），输对才进入；未设置则开放（页面有警告）
 *   GET  /admin/data      -> 读取当前配置（JSON，需 Basic Auth）
 *   POST /admin/save      -> 保存配置到 KV，立即生效（body: {config}，需 Basic Auth）
 *   POST /admin/clear     -> 清除网页配置，回退到置顶区/环境变量（需 Basic Auth）
 * =================================================================
 */

/* ------------------------------------------------------------------
 * 🔧 账号配置（置顶，直接改这里即可，保存后重新部署生效）
 * ------------------------------------------------------------------
 * 每行一个账号，格式：TOKEN#x-device-id#备注
 *   - TOKEN       = Cloud-IDE-JWT 后面的 JWT，可带 "Cloud-IDE-JWT " 前缀（自动剥离），约 14 天有效
 *   - x-device-id = 设备指纹（非账号），建议每号各填各的，避免风控；可省略（留空）
 *   - 备注        = 日志/推送里的账号标识，可省略（自动补 账号1 / 账号2 ...）
 *
 * 示例（2 个账号）：
 *   "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MDAwMDAwMDB9.abc#1694785705300000#主号"
 *   "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE4MDAwMDAwMDB9.abc##小号A"
 *
 * 更推荐：不在这里硬编码，改用内置管理网页 GET /admin 保存到 KV（见文件头），
 * 令牌过期时直接在网页上更新即可，无需重新部署。
 * ⚠️ 安全提醒：JWT 等同密码，硬编码进代码后请勿把本文件传到公网/仓库。
 */
const ACCOUNTS_CONFIG = [
  // "TOKEN#x-device-id#备注",
];

const API = "https://api.trae.cn";
const ENDPOINTS = {
  claim: "/trae/api/v2/ug/checkin_credits/claim",
  status: "/trae/api/v2/ug/checkin_credits/status",
  usage: "/trae/api/v2/pay/ide_user_ent_usage",
};
const DEFAULT_DEVICE_ID = "1694785705300000";
const RETRY_TIMES = 2;        // 失败重试次数（与 Python 版一致）
const RETRY_DELAY_MS = 5000;  // 重试间隔
const WXPUSHER_API = "https://wxpusher.zjiecode.com/api/send/message";
const KV_ACCOUNTS_KEY = "TRAE_TOKEN";
const KV_LAST_RUN_KEY = "last_run";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* 账号解析（与 Python 版 parse_accounts 行为一致）                      */
/* ------------------------------------------------------------------ */
function normalizeToken(raw) {
  if (!raw) return raw;
  raw = raw.trim();
  const prefix = "cloud-ide-jwt"; // 大小写不敏感
  if (raw.toLowerCase().startsWith(prefix)) {
    raw = raw.slice(prefix.length).trimStart();
  }
  return raw;
}

function parseAccounts(raw) {
  raw = (raw || "").trim();
  if (!raw) return [];
  const accounts = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    line = line.trim();
    if (!line) return;
    const parts = line.split("#");
    const token = normalizeToken(parts[0] || "");
    if (!token) return;
    const deviceId = (parts[1] || "").trim();
    const remark = parts.slice(2).join("#").trim() || `账号${i + 1}`;
    accounts.push({ token, device_id: deviceId, remark });
  });
  return accounts;
}

/** 解析当前生效的账号配置及其来源。优先级：网页配置(KV) → 置顶配置区 → 环境变量。 */
async function resolveAccounts(env) {
  // 1) 网页保存的配置（KV）—— 管理网页是更新令牌的入口，最高优先
  if (env.TRAE_ACCOUNTS_KV) {
    const kvVal = await env.TRAE_ACCOUNTS_KV.get(KV_ACCOUNTS_KEY);
    if (kvVal && kvVal.trim()) {
      return { source: "网页配置(KV)", raw: kvVal, accounts: parseAccounts(kvVal) };
    }
  }
  // 2) 置顶配置区 ACCOUNTS_CONFIG
  const cfgRaw = ACCOUNTS_CONFIG.join("\n");
  const cfgAccounts = parseAccounts(cfgRaw);
  if (cfgAccounts.length) {
    return { source: "置顶配置区", raw: cfgRaw, accounts: cfgAccounts };
  }
  // 3) 环境变量 / Secret TRAE_TOKEN
  const envRaw = (env.TRAE_TOKEN || "").trim();
  return { source: "环境变量", raw: envRaw, accounts: parseAccounts(envRaw) };
}

async function getAccounts(env) {
  return (await resolveAccounts(env)).accounts;
}

function mask(token) {
  if (!token) return "?";
  return token.length > 12 ? `${token.slice(0, 12)}…` : token;
}

function fmtCredits(v) {
  if (typeof v === "number") return String(parseFloat(v.toFixed(6)));
  return String(v);
}

/* ------------------------------------------------------------------ */
/* 请求                                                               */
/* ------------------------------------------------------------------ */
function buildHeaders(cfg) {
  return {
    authorization: "Cloud-IDE-JWT " + cfg.token,
    "content-type": "application/json",
    "user-agent": "VSCode 1.107.1 (TRAE SOLO CN)",
    "x-user-region": "CN",
    "package-type": "stable_cn",
    "x-lscbd-aid": "787976",
    "x-lscbd-platform": "windows",
    "app-version": "0.1.51",
    accept: "*/*",
    "x-request-id": crypto.randomUUID(),
    "x-device-brand": "To be filled by O.E.M.",
    "x-device-id": cfg.device_id || DEFAULT_DEVICE_ID,
    "x-device-type": "windows",
    "x-lgw-req-sdk-type": "3",
  };
}

/** 与 Python 版 post_json 同构：HTTP>=400 与网络异常均按 RETRY_TIMES 重试。 */
async function postJson(cfg, path, body) {
  let last = null;
  for (let i = 0; i <= RETRY_TIMES; i++) {
    try {
      const r = await fetch(API + path, {
        method: "POST",
        headers: buildHeaders(cfg),
        body: JSON.stringify(body),
      });
      if (r.status >= 400) {
        const text = (await r.text()).slice(0, 300);
        last = `HTTP ${r.status}: ${text}`;
        if (i < RETRY_TIMES) { await sleep(RETRY_DELAY_MS); continue; }
        break;
      }
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("application/json")) {
        return { data: await r.json(), err: null };
      }
      const raw = await r.text();
      return { data: { raw: raw.slice(0, 2000) }, err: null };
    } catch (e) {
      last = e && e.message ? e.message : String(e);
      if (i < RETRY_TIMES) { await sleep(RETRY_DELAY_MS); continue; }
    }
  }
  return { data: null, err: last };
}

async function getCheckinStatus(cfg) {
  const { data, err } = await postJson(cfg, ENDPOINTS.status, {});
  if (err) return { data: null, err };
  if (data === null || data === undefined) return { data: null, err: "status 无返回" };
  const code = data.code;
  if (code && code !== 0) {
    return { data: null, err: `status code=${code}: ${data.message || ""}` };
  }
  return { data, err: null };
}

async function doClaim(cfg) {
  const { data, err } = await postJson(cfg, ENDPOINTS.claim, {});
  if (err) return { data: null, err };
  if (data === null || data === undefined) return { data: null, err: "claim 无返回" };
  return { data, err: null };
}

async function getUsage(cfg) {
  const { data, err } = await postJson(cfg, ENDPOINTS.usage, {
    require_usage: true,
    req_source: 2,
  });
  if (err) return { rows: null, err };
  if (data === null || data === undefined) return { rows: null, err: "usage 无返回" };
  const packs = data.user_entitlement_pack_list || [];
  const rows = packs.map((p) => {
    const base = p.entitlement_base_info || {};
    const quota = base.quota || {};
    const limit = quota.credits_limit || 0;
    const usedRaw = (p.usage || {}).credits_amount || 0;
    const used = typeof usedRaw === "number" ? Math.round(usedRaw * 100) / 100 : usedRaw;
    return {
      name: p.display_desc || "",
      group: ((base.product_extra || {}).package_extra || {}).package_name || "",
      limit,
      used,
      expire: base.end_time,
    };
  });
  return { rows, err: null };
}

/* ------------------------------------------------------------------ */
/* JWT exp 解析                                                        */
/* ------------------------------------------------------------------ */
function decodeExp(token) {
  try {
    const part = token.split(".")[1];
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const pad = "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(b64 + pad);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder("utf-8").decode(bytes));
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

/** 解析 JWT 剩余有效天数（毫秒精度换算），解析失败返回 null。 */
function analyzeToken(token) {
  const exp = decodeExp(token);
  if (exp === null || exp === undefined) return { exp_days: null };
  return { exp_days: Math.floor((exp * 1000 - Date.now()) / 86400000) };
}

/* ------------------------------------------------------------------ */
/* 通知：WxPusher（Workers 环境没有青龙内置通知，此为唯一通道）          */
/* ------------------------------------------------------------------ */
async function wxpusherSend(env, title, content) {
  const appToken = (env.WXPUSHER_APP_TOKEN || "").trim();
  const uid = (env.WXPUSHER_UID || "").trim();
  if (!appToken || !uid) {
    return { ok: false, note: "WxPusher 未配置(缺 WXPUSHER_APP_TOKEN / WXPUSHER_UID)，跳过推送" };
  }
  try {
    const r = await fetch(WXPUSHER_API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appToken,
        uids: [uid],
        topicIds: [],
        summary: title,
        content: content.replace(/\n/g, "<br>"),
        contentType: 1,
        verifyPay: false,
      }),
    });
    const rj = await r.json().catch(() => ({}));
    if (rj.code === 1000) return { ok: true, note: "WxPusher 通知发送成功" };
    const body = (await r.text().catch(() => "")) || "";
    return { ok: false, note: `WxPusher 返回异常: ${rj.msg || body.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, note: `WxPusher 通知失败: ${e.message || e}` };
  }
}

/* ------------------------------------------------------------------ */
/* 单账号处理（与 Python 版 process_account 对应）                      */
/* ------------------------------------------------------------------ */
async function processAccount(acc, opts) {
  const { balanceOnly, force } = opts;
  const cfg = { token: acc.token, device_id: acc.device_id };
  const res = {
    remark: acc.remark,
    sign_ok: true,
    sign_note: "",
    gained: 0,
    exp_txt: "",
    total_remain: null,
    rows: [],
  };

  // 0) 令牌有效期
  const exp = decodeExp(acc.token);
  if (exp) {
    const remainMs = exp * 1000 - Date.now();
    const days = Math.floor(remainMs / 86400000);
    res.exp_txt = days < 0 ? "令牌已过期，请更新 TRAE_TOKEN" : `令牌剩余约 ${days} 天`;
  }

  // 1) 签到状态
  const st = await getCheckinStatus(cfg);
  if (st.err) {
    res.sign_ok = false;
    res.sign_note = `查询状态失败: ${st.err}`;
    const msg = String(st.err).toLowerCase();
    if (msg.includes("authenticate") || msg.includes("1001")) {
      res.sign_note += "（提示：令牌可能过期，请重新抓包更新 TRAE_TOKEN 对应那行）";
    }
    return res;
  }
  const checkedIn = !!st.data.checked_in;
  const dailyCredits = st.data.credits || 200;

  // 2) 签到
  if (!balanceOnly) {
    if (checkedIn && !force) {
      res.sign_note = "今日已签到，跳过";
      res.gained = 0;
    } else {
      const claim = await doClaim(cfg);
      if (claim.err) {
        res.sign_ok = false;
        res.sign_note = `签到失败: ${claim.err}`;
      } else if (claim.data.code === 0) {
        res.gained = dailyCredits;
        res.sign_note = `签到成功，获得 +${fmtCredits(res.gained)} 积分`;
      } else {
        res.sign_ok = false;
        res.sign_note = `签到返回异常 code=${claim.data.code}`;
      }
    }
  } else {
    res.sign_note = "仅查询余额(未签到)";
    res.gained = 0;
  }

  // 3) 余额
  const usage = await getUsage(cfg);
  if (usage.err) {
    res.rows = [];
  } else {
    res.rows = usage.rows;
    const creditRows = usage.rows.filter((r) => r.limit);
    if (creditRows.length) {
      const totalLimit = creditRows.reduce((s, r) => s + r.limit, 0);
      const totalUsed = creditRows.reduce((s, r) => s + (r.used || 0), 0);
      res.total_remain = totalLimit - totalUsed;
    }
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                             */
/* ------------------------------------------------------------------ */
async function runCheckin(env, opts) {
  const logLines = [];
  const log = (m) => { console.log(m); logLines.push(m); };
  opts = { balanceOnly: false, force: false, noNotify: false, ...opts };

  const accounts = await getAccounts(env);
  if (!accounts.length) {
    const msg = "未检测到有效账号（网页配置/置顶配置区/环境变量均为空），请按 TOKEN#x-device-id#备注 格式填写";
    log(msg);
    if (!opts.noNotify) await wxpusherSend(env, "TraeWork 签到失败", msg);
    return { ok: false, reason: msg, logs: logLines };
  }

  // 顺序逐个处理（与 Python 版一致，避免并发触发风控）
  const results = [];
  for (const acc of accounts) {
    log(`===== 账号[${acc.remark}] (token=${mask(acc.token)}) =====`);
    const r = await processAccount(acc, opts);
    log(`  签到: ${r.sign_ok ? "✅" : "❌"} ${r.sign_note}`);
    if (r.exp_txt) log(`  ${r.exp_txt}`);
    if (r.total_remain !== null) log(`  剩余可用总积分: ${fmtCredits(r.total_remain)}`);
    results.push(r);
  }

  // 汇总推送
  const dateStr = new Date().toISOString().slice(0, 10);
  const okCnt = results.filter((r) => r.sign_ok).length;
  const failCnt = results.length - okCnt;
  let title;
  if (opts.balanceOnly) {
    title = `TraeWork 积分余额查询 (共 ${results.length} 账号)`;
  } else if (failCnt === 0) {
    title = `TraeWork 签到 ${okCnt} 成功`;
  } else {
    title = `TraeWork 签到 ${okCnt}成功 ${failCnt}失败`;
  }

  const lines = [`📅 ${dateStr} TraeWork 每日签到 (共 ${results.length} 个账号)`, "─".repeat(22)];
  for (const r of results) {
    lines.push(`【${r.remark}】`);
    lines.push(`  签到: ${r.sign_ok ? "✅ " : "❌ "}${r.sign_note}`);
    if (!opts.balanceOnly && r.gained) lines.push(`  本次获得积分: +${fmtCredits(r.gained)}`);
    if (r.exp_txt) lines.push(`  ${r.exp_txt}`);
    if (r.total_remain !== null) lines.push(`  剩余可用总积分: ${fmtCredits(r.total_remain)}`);
    for (const row of r.rows) {
      const name = row.name || row.group || "?";
      if (row.limit) {
        lines.push(`  · ${name}: 剩余 ${fmtCredits(row.limit - (row.used || 0))}`);
      } else {
        lines.push(`  · ${name}: (无积分额度)`);
      }
    }
    lines.push("");
  }
  const content = lines.join("\n").trimEnd();

  if (opts.noNotify) {
    log("已指定 no-notify，跳过推送");
  } else {
    const n = await wxpusherSend(env, title, content);
    log(`[通知] ${n.note}`);
  }

  // 可选：把最近一次运行摘要存 KV，GET / 可查
  if (env.TRAE_ACCOUNTS_KV) {
    await env.TRAE_ACCOUNTS_KV.put(
      KV_LAST_RUN_KEY,
      JSON.stringify({
        at: new Date().toISOString(),
        title,
        content,
        ok: !(failCnt > 0 && !opts.balanceOnly),
      })
    );
  }

  const realFail = failCnt > 0 && !opts.balanceOnly;
  return { ok: !realFail, accounts: results.length, results, logs: logLines };
}

/* ------------------------------------------------------------------ */
/* 管理网页（/admin）                                                  */
/* ------------------------------------------------------------------ */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/** UTF-8 安全的 base64 编解码（Basic Auth 需要，支持非 ASCII 密码）。 */
function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin);
}
function b64decodeUtf8(b64) {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * 管理接口鉴权：HTTP Basic Auth。
 * 设置了 ADMIN_PASSWORD 时，浏览器访问 /admin 会先弹出密码框；
 * 用户名随意（通常留空），密码与 ADMIN_PASSWORD 比对，只认密码。未设置密码则开放。
 */
function adminAuthedBasic(request, env) {
  const expect = (env.ADMIN_PASSWORD || "").trim();
  if (!expect) return true; // 未设置密码：开放
  const auth = request.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("basic ")) return false;
  let decoded = "";
  try { decoded = b64decodeUtf8(auth.slice(6).trim()); } catch { return false; }
  const idx = decoded.indexOf(":");
  const pwd = idx >= 0 ? decoded.slice(idx + 1) : decoded;
  return pwd === expect; // 忽略用户名，只校验密码
}

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="TraeWork Admin (password only)", charset="UTF-8"' },
  });
}

async function handleAdminData(request, env, url) {
  if (!adminAuthedBasic(request, env)) return unauthorized();
  const { source, raw, accounts } = await resolveAccounts(env);
  // 逐账号查询积分余额（解析权益包列表：已用/剩余）
  const enriched = [];
  for (const a of accounts) {
    const cfg = { token: a.token, device_id: a.device_id };
    const usage = await getUsage(cfg);
    let total_remain = null;
    if (!usage.err && usage.rows) {
      const creditRows = usage.rows.filter((r) => r.limit);
      if (creditRows.length) {
        total_remain =
          creditRows.reduce((s, r) => s + r.limit, 0) -
          creditRows.reduce((s, r) => s + (r.used || 0), 0);
      }
    }
    enriched.push({
      remark: a.remark,
      device_id: a.device_id,
      token_masked: mask(a.token),
      ...analyzeToken(a.token),
      credits: usage.err ? null : { rows: usage.rows || [], total_remain },
    });
  }
  return json({
    ok: true,
    protected: !!((env.ADMIN_PASSWORD || "").trim()),
    source,
    config_text: raw,
    accounts: enriched,
  });
}

async function handleAdminSave(request, env) {
  if (!adminAuthedBasic(request, env)) return unauthorized();
  let body = {};
  try { body = await request.json(); } catch { /* 忽略非法 JSON */ }
  if (!env.TRAE_ACCOUNTS_KV) {
    return json({ ok: false, error: "未绑定 KV（TRAE_ACCOUNTS_KV），无法保存网页配置" }, 500);
  }
  const config = typeof body.config === "string" ? body.config : "";
  const accounts = parseAccounts(config);
  if (!accounts.length) {
    return json({ ok: false, error: "配置为空或格式无效，每行应为 TOKEN#x-device-id#备注" }, 400);
  }
  await env.TRAE_ACCOUNTS_KV.put(KV_ACCOUNTS_KEY, config.trim());
  return json({
    ok: true,
    accounts: accounts.map((a) => ({
      remark: a.remark,
      device_id: a.device_id,
      token_masked: mask(a.token),
      ...analyzeToken(a.token),
    })),
  });
}

async function handleAdminClear(request, env) {
  if (!adminAuthedBasic(request, env)) return unauthorized();
  let body = {};
  try { body = await request.json(); } catch { /* 忽略非法 JSON */ }
  if (env.TRAE_ACCOUNTS_KV) {
    await env.TRAE_ACCOUNTS_KV.delete(KV_ACCOUNTS_KEY);
  }
  return json({ ok: true });
}

function adminPageHtml(env) {
  const protectedMode = !!((env.ADMIN_PASSWORD || "").trim());
  // 已通过 Basic Auth 才进入本页：把凭据回传页面 JS，供 /admin/* 接口请求使用
  const authValue = protectedMode ? b64encodeUtf8(":" + (env.ADMIN_PASSWORD || "").trim()) : "";
  const warnVisible = protectedMode ? "hidden" : "";
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TraeWork 签到 · 账号管理</title>
<style>
  :root { --blue:#1d5fbf; --green:#147a53; --red:#c0392b; --bg:#f6f8fb; --line:#d8dee8; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:#1f2329; }
  .wrap { max-width:760px; margin:0 auto; padding:20px 16px 60px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:#6b7280; font-size:14px; margin-bottom:16px; line-height:1.6; }
  .card { background:#fff; border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:14px; }
  .badge { display:inline-block; background:#eef3fb; color:var(--blue); border:1px solid #c9d9f2; border-radius:999px; padding:2px 10px; font-size:13px; margin-left:8px; }
  .warn { background:#fff7e6; border:1px solid #f0d9a8; color:#7a5c1a; border-radius:8px; padding:10px 12px; font-size:14px; margin-bottom:14px; line-height:1.6; }
  label { font-weight:600; font-size:14px; display:block; margin:10px 0 6px; }
  textarea { width:100%; border:1px solid var(--line); border-radius:8px; padding:10px; font-size:14px; font-family:ui-monospace,Menlo,Consolas,monospace; }
  textarea { min-height:180px; resize:vertical; }
  .btns { display:flex; gap:10px; flex-wrap:wrap; margin-top:12px; }
  button { border:0; border-radius:8px; padding:10px 18px; font-size:14px; cursor:pointer; }
  .btn-primary { background:var(--blue); color:#fff; }
  .btn-green { background:var(--green); color:#fff; }
  .btn-ghost { background:#fff; color:#555; border:1px solid var(--line); }
  .btn-danger { background:#fff; color:var(--red); border:1px solid #e8c4c0; }
  .expired { color:var(--red); font-weight:600; }
  .muted { color:#6b7280; font-size:13px; line-height:1.7; }
  code { background:#f2f4f7; border-radius:4px; padding:1px 5px; font-size:13px; }
  /* 操作结果面板（终端式，追加历史） */
  .logbox { background:#1f2329; color:#d4d9e0; border-radius:8px; padding:10px 12px;
    font-family:ui-monospace,Menlo,Consolas,monospace; font-size:13px; line-height:1.7;
    max-height:280px; overflow-y:auto; white-space:pre-wrap; word-break:break-all; }
  .logline { border-bottom:1px dashed rgba(255,255,255,.08); padding:1px 0; }
  .logline:last-child { border-bottom:0; }
  .logline .ts { color:#7a828c; margin-right:6px; }
  .logline.ok { color:#b9e6c9; }
  .logline.err { color:#ff9a91; }
  .logline b { color:#fff; }
  .logbar { display:flex; justify-content:space-between; align-items:center; margin:14px 0 6px; }
  .logbar .l { font-weight:600; font-size:14px; }
  .logbar button { padding:4px 10px; font-size:12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>TraeWork 签到 · 账号管理 <span class="badge" id="source">加载中…</span></h1>
  <div class="sub">直接修改下方的 TOKEN / x-device-id / 备注，保存即生效（无需重新部署）。</div>

  <div class="warn" id="warn" ${warnVisible}>⚠️ 未设置管理密码（ADMIN_PASSWORD），任何能访问本页面的人都可以修改配置。建议执行：<code>wrangler secret put ADMIN_PASSWORD</code></div>

  <div class="card">
    <label for="cfg">账号配置（每行一个：TOKEN#x-device-id#备注）</label>
    <textarea id="cfg" placeholder="eyJ...JWT#1694785705300000#主号&#10;eyJ...JWT##小号A"></textarea>

    <div class="btns">
      <button class="btn-primary" onclick="save()">保存并生效</button>
      <button class="btn-green" onclick="load()">重新加载</button>
      <button class="btn-green" onclick="runNow(this)">手动签到</button>
      <button class="btn-ghost" onclick="window.open('/dry-run','_blank')">试运行（不签到）</button>
      <button class="btn-danger" onclick="clearCfg()">清除网页配置</button>
    </div>
  </div>

  <div class="card">
    <div class="logbar">
      <span class="l">操作结果</span>
      <button class="btn-ghost" onclick="clearLog()">清空</button>
    </div>
    <div class="logbox" id="result"></div>
  </div>

  <div class="card muted">
    <b>说明</b><br>
    · 格式：<code>TOKEN#x-device-id#备注</code>；TOKEN 可带 <code>Cloud-IDE-JWT </code> 前缀（自动剥离）；x-device-id 可留空；备注可省略。<br>
    · 读取优先级：<b>网页配置（本页保存）→ 置顶配置区 → 环境变量</b>。<br>
    · JWT 约 14 天过期：过期后重新抓包，在本页替换对应行的 TOKEN，点「保存并生效」即可，无需改代码。<br>
    · 本页会回显完整令牌，请勿截图或分享本页面。
  </div>
</div>
<script>
window.ADMIN_AUTH = "${authValue}";
function el(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){ return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]; }); }
function fmt(n) { return Number(n).toLocaleString("zh-CN", { maximumFractionDigits: 2 }); }
function ts() { return new Date().toLocaleTimeString("zh-CN", { hour12: false }); }
function logLine(html, cls) {
  var r = el("result");
  var div = document.createElement("div");
  div.className = "logline " + (cls || "");
  div.innerHTML = '<span class="ts">[' + ts() + "]</span>" + html;
  r.appendChild(div);
  r.scrollTop = r.scrollHeight;
}
function clearLog() { el("result").innerHTML = ""; }
function authHeaders() {
  var h = { "content-type": "application/json" };
  if (window.ADMIN_AUTH) h["Authorization"] = "Basic " + window.ADMIN_AUTH;
  return h;
}
async function api(path, body) {
  var res = await fetch(path, { method: "POST", headers: authHeaders(), body: JSON.stringify(body || {}) });
  var j = await res.json().catch(function(){ return {}; });
  return { status: res.status, j: j };
}
function printAccounts(list, head) {
  if (!list || !list.length) { logLine("当前无有效账号（将回退到置顶配置区/环境变量）", "muted"); return; }
  logLine("<b>" + (head || "当前账号") + "（" + list.length + " 个）</b>", "ok");
  list.forEach(function (a) {
    var d = a.exp_days;
    var expHtml = d === null || d === undefined
      ? "无法解析剩余天数"
      : (d < 0 ? "已过期 " + (-d) + " 天，请更新令牌" : "剩余约 " + d + " 天");
    logLine("【" + esc(a.remark) + "】设备 " + esc(a.device_id || "(默认)") + " · token " + esc(a.token_masked) + " · " + expHtml, "");
    // 积分余额明细（权益包列表：已用/剩余）
    if (a.credits) {
      var rows = a.credits.rows || [];
      if (!rows.length) {
        logLine("  · 暂无权益包积分数据", "muted");
      } else {
        rows.forEach(function (r) {
          var nm = r.name || r.group || "(未命名权益包)";
          var limit = r.limit || 0;
          var used = r.used || 0;
          var remain = limit - used;
          var exp = "";
          if (r.expire) {
            var t = new Date(Number(r.expire) * 1000);
            if (!isNaN(t.getTime())) exp = " · 到期 " + t.toISOString().slice(0, 10);
          }
          logLine("  · " + esc(nm) + "：已用 " + fmt(used) + " / 剩余 " + fmt(remain) + exp, "");
        });
        if (a.credits.total_remain !== null && a.credits.total_remain !== undefined) {
          logLine("  · 合计剩余 " + fmt(a.credits.total_remain) + " 积分", "ok");
        }
      }
    }
  });
}
async function load() {
  logLine("加载配置…", "muted");
  var res = await fetch("/admin/data", { headers: authHeaders() });
  if (res.status === 401) { logLine("未授权：请刷新页面，在弹出框中输入正确的管理密码", "err"); return; }
  var j = await res.json();
  el("source").textContent = j.source || "";
  el("cfg").value = j.config_text || "";
  printAccounts(j.accounts || [], "当前生效账号");
}
async function runNow(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  var old = btn.textContent;
  btn.textContent = "签到中…";
  try {
    var res = await fetch("/run", { method: "POST", headers: authHeaders(), body: "{}" });
    var j = await res.json().catch(function(){ return {}; });
    if (res.status === 401) { logLine("未授权：请刷新页面，在弹出框中输入正确的管理密码", "err"); return; }
    if (!j.ok) {
      logLine(esc(j.reason || "签到失败"), "err");
      (j.logs || []).forEach(function (l) { logLine("  " + esc(l), "err"); });
      return;
    }
    logLine("<b>手动签到完成（" + j.accounts + " 个账号）</b>", "ok");
    (j.results || []).forEach(function (r) {
      var parts = ["【" + esc(r.remark) + "】" + (r.sign_ok ? "✅ " : "❌ ") + esc(r.sign_note)];
      if (r.gained) parts.push("获得 +" + fmt(r.gained) + " 积分");
      if (r.exp_txt) parts.push(esc(r.exp_txt));
      if (r.total_remain !== null && r.total_remain !== undefined) parts.push("剩余 " + fmt(r.total_remain) + " 积分");
      logLine(parts.join(" · "), r.sign_ok ? "ok" : "err");
    });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}
async function save() {
  var cfg = el("cfg").value;
  if (!cfg.trim()) { logLine("配置为空，请先填写账号", "err"); return; }
  logLine("保存配置…", "muted");
  var r = await api("/admin/save", { config: cfg });
  if (r.status === 401) { logLine("未授权：请刷新页面，在弹出框中输入正确的管理密码", "err"); return; }
  if (r.status !== 200) { logLine("保存失败：" + (r.j.error || r.status), "err"); return; }
  el("source").textContent = "网页配置(KV)";
  printAccounts(r.j.accounts, "已保存并生效");
}
async function clearCfg() {
  if (!confirm("确定清除网页保存的配置吗？将回退到置顶配置区/环境变量。")) return;
  logLine("清除网页配置…", "muted");
  var r = await api("/admin/clear", {});
  if (r.status === 401) { logLine("未授权：请刷新页面，在弹出框中输入正确的管理密码", "err"); return; }
  if (r.status !== 200) { logLine("清除失败：" + (r.j.error || r.status), "err"); return; }
  logLine("已清除网页配置，将回退到置顶配置区/环境变量", "ok");
  load();
}
load();
</script>
</body>
</html>`;
}

/* ------------------------------------------------------------------ */
/* Worker 入口                                                         */
/* ------------------------------------------------------------------ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const q = url.searchParams;

    const opts = {
      balanceOnly: q.has("balance-only"),
      force: q.has("force"),
      noNotify: q.has("no-notify"),
    };

    // 管理网页 / 管理接口（必须在通用 POST 分支之前匹配）
    if (path === "/admin") {
      if (!adminAuthedBasic(request, env)) return unauthorized();
      return new Response(adminPageHtml(env), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (path === "/admin/data") return handleAdminData(request, env, url);
    if (path === "/admin/save") return handleAdminSave(request, env);
    if (path === "/admin/clear") return handleAdminClear(request, env);

    if (path === "/") {
      if (env.TRAE_ACCOUNTS_KV) {
        const last = await env.TRAE_ACCOUNTS_KV.get(KV_LAST_RUN_KEY);
        if (last) {
          return new Response(last, {
            headers: { "content-type": "application/json; charset=utf-8" },
          });
        }
      }
      return new Response(
        "TraeWork Checkin Worker is running.\n" +
          "  GET  /admin      账号管理网页（更新 TOKEN / x-device-id）\n" +
          "  GET  /dry-run    解析账号(脱敏)，不调用接口\n" +
          "  GET  /run        立即签到一轮 (?balance-only / ?force / ?no-notify)\n" +
          "  POST /           同上\n" +
          "定时由 Cron Trigger 触发。\n",
        { headers: { "content-type": "text/plain; charset=utf-8" } }
      );
    }

    if (path === "/dry-run") {
      const { source, accounts } = await resolveAccounts(env);
      if (!accounts.length) {
        return new Response("未配置账号（网页配置/置顶配置区/环境变量均为空）\n", {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      const lines = accounts.map(
        (a) => `备注=${a.remark}  device_id=${a.device_id || "(默认)"}  token=${mask(a.token)}`
      );
      return new Response(`配置来源: ${source}\n共 ${accounts.length} 个账号:\n${lines.join("\n")}\n`, {
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }

    if (path === "/run" || request.method === "POST") {
      const result = await runCheckin(env, opts);
      return json(result);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    // Cron 触发：每天按触发器配置执行一轮签到
    ctx.waitUntil(runCheckin(env, {}));
  },
};
