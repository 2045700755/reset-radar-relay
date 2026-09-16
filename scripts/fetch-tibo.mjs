/**
 * 在 GitHub Actions 上定时运行：抓取 X 时间线，写入 data/tibo-timeline.json
 *
 * 为什么放这里：你的电脑访问不到 X，但 GitHub 的服务器可以。
 * 本脚本只读公开数据，不做任何转发，产出的是一个数据文件。
 *
 * 环境变量：
 *   TIBO_USERS  要监控的 X 用户名，逗号分隔，默认 thsottiaux
 *   RSS_URLS    可选的第三方 RSS 地址（逗号分隔），作为备用源
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const USERS = (process.env.TIBO_USERS || 'thsottiaux')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const RSS_URLS = (process.env.RSS_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const OUT_FILE = 'data/tibo-timeline.json';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url, headers = {}) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/html, application/rss+xml, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...headers
    },
    redirect: 'follow'
  });
  const text = await res.text();
  return { status: res.status, text, contentType: res.headers.get('content-type') || '' };
}

function extractTweets(payload) {
  const candidates = [];
  const push = (v) => {
    if (Array.isArray(v)) candidates.push(...v);
    else if (v && typeof v === 'object') candidates.push(...Object.values(v));
  };
  push(payload.tweets);
  push(payload.timeline);
  push(payload?.props?.pageProps?.timeline?.entries);
  push(payload?.props?.pageProps?.tweets);
  push(payload?.globalObjects?.tweets);

  const seen = new Set();
  const out = [];
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue;
    const content = raw.content || raw;
    const text = content.full_text || content.text || raw.full_text || raw.text;
    const id = String(content.id_str || content.id || raw.id_str || raw.id || '');
    if (!text || !id || seen.has(id)) continue;
    seen.add(id);
    const user = content.user?.screen_name || raw.user?.screen_name || '';
    out.push({
      id,
      text,
      screen_name: user,
      created_at: content.created_at || raw.created_at || '',
      url: user ? `https://x.com/${user}/status/${id}` : `https://x.com/i/status/${id}`
    });
  }
  return out.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 40);
}

function parseSyndication(text) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    const m = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      try {
        data = JSON.parse(m[1]);
      } catch {
        data = null;
      }
    }
  }
  if (!data) throw new Error('返回内容无法解析为 JSON（可能被拦截或接口已变更）');
  const tweets = extractTweets(data);
  if (!tweets.length) throw new Error('未从返回内容中解析出推文');
  return tweets;
}

function parseRss(xml) {
  const items = [];
  const chunks = xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g) || [];
  const strip = (s) =>
    String(s || '')
      .replace(/<!\[CDATA\[|\]\]>/g, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  for (const chunk of chunks.slice(0, 40)) {
    const t = chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const l = chunk.match(/<link[^>]*>([\s\S]*?)<\/link>|<link[^>]*href="([^"]+)"/);
    const d = chunk.match(/<(pubDate|updated|published)[^>]*>([\s\S]*?)<\/\1>/);
    const body = chunk.match(/<(description|content|summary)[^>]*>([\s\S]*?)<\/\1>/);
    const link = strip(l ? l[1] || l[2] : '');
    const title = strip(t ? t[1] : '');
    const text = strip(body ? body[2] : '') || title;
    const idMatch = link.match(/status\/(\d{2,25})/);
    items.push({
      id: idMatch ? idMatch[1] : link || title,
      text,
      screen_name: (link.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\//) || [])[1] || '',
      created_at: d && d[2] ? new Date(d[2]).toISOString() : new Date().toISOString(),
      url: link
    });
  }
  return items;
}

async function fetchSyndication(user) {
  const url =
    `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${encodeURIComponent(user)}` +
    `&dnt=true&with_replies=false&lang=en`;
  const r = await get(url);
  if (r.status >= 400) throw new Error(`HTTP ${r.status}`);
  return parseSyndication(r.text);
}

async function main() {
  const sources = {};
  const users = {};

  for (const user of USERS) {
    try {
      const tweets = await fetchSyndication(user);
      users[user] = tweets;
      sources[`syndication:${user}`] = { ok: true, count: tweets.length };
      console.log(`[ok] syndication ${user} -> ${tweets.length} 条`);
    } catch (err) {
      users[user] = users[user] || [];
      sources[`syndication:${user}`] = { ok: false, error: String(err.message || err) };
      console.log(`[fail] syndication ${user} -> ${err.message}`);
    }
  }

  for (const url of RSS_URLS) {
    try {
      const r = await get(url);
      const items = parseRss(r.text);
      for (const item of items) {
        const key = item.screen_name || 'rss';
        users[key] = users[key] || [];
        if (!users[key].some((t) => t.id === item.id)) users[key].push(item);
      }
      sources[`rss:${url.slice(0, 40)}`] = { ok: true, count: items.length };
      console.log(`[ok] rss ${url.slice(0, 40)} -> ${items.length} 条`);
    } catch (err) {
      sources[`rss:${url.slice(0, 40)}`] = { ok: false, error: String(err.message || err) };
      console.log(`[fail] rss ${url.slice(0, 40)} -> ${err.message}`);
    }
  }

  for (const key of Object.keys(users)) {
    users[key].sort((a, b) => Number(b.id) - Number(a.id));
  }

  const anyOk = Object.values(sources).some((s) => s.ok);
  const payload = {
    fetchedAt: new Date().toISOString(),
    runner: 'github-actions',
    users,
    sources,
    ok: anyOk,
    hint: anyOk
      ? undefined
      : '所有源都失败了。若是 syndication 接口失效，请改用 RSS_URLS 环境变量喂入第三方 RSS'
  };

  await mkdir(dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`已写入 ${OUT_FILE}`);
  console.log(`总推文数: ${Object.values(users).reduce((a, b) => a + b.length, 0)}`);
}

main().catch((err) => {
  console.error('脚本失败:', err);
  process.exit(1);
});
