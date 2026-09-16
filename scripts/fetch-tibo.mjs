// GitHub Actions 定时抓取 Tibo 时间线 → data/tibo-timeline.json
// 依次尝试多个公开数据源，逐个记录响应详情，便于远程诊断
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const USERS = (process.env.TIBO_USERS || 'thsottiaux').split(',').map(s => s.trim()).filter(Boolean);
const EXTRA_RSS = (process.env.RSS_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
const OUT = 'data/tibo-timeline.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const SOURCES = u => [
  ['syndication', 'syndication', `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${u}&dnt=true&with_replies=false&lang=en`],
  ['syndication-alt', 'syndication', `https://cdn.syndication.twimg.com/timeline/profile?screen_name=${u}&dnt=false`],
  ['syndication-srv', 'syndication', `https://syndication.twitter.com/srv/timeline-profile/screen-name/${u}`],
  ['fxtwitter', 'check', `https://api.fxtwitter.com/${u}`],
  ['nitter-net', 'rss', `https://nitter.net/${u}/rss`],
  ['nitter-poast', 'rss', `https://nitter.poast.org/${u}/rss`],
  ['rsshub', 'rss', `https://rsshub.app/twitter/user/${u}`],
  ['rsshub-rssforever', 'rss', `https://rsshub.rssforever.com/twitter/user/${u}`]
];

async function get(url, ms = 20000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json, text/html, application/rss+xml, */*', 'Cache-Control': 'no-cache' },
      redirect: 'follow', signal: c.signal
    });
    return { status: r.status, ct: (r.headers.get('content-type') || '').slice(0, 50), text: await r.text() };
  } finally { clearTimeout(t); }
}

const brief = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 260);

function tweets(payload) {
  const arr = [];
  const add = v => { if (Array.isArray(v)) arr.push(...v); else if (v && typeof v === 'object') arr.push(...Object.values(v)); };
  add(payload.tweets); add(payload.timeline);
  add(payload?.props?.pageProps?.timeline?.entries);
  add(payload?.props?.pageProps?.tweets);
  add(payload?.globalObjects?.tweets);
  const seen = new Set(), out = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw.content || raw;
    const text = c.full_text || c.text || raw.full_text || raw.text;
    const id = String(c.id_str || c.id || raw.id_str || raw.id || '');
    if (!text || !id || seen.has(id)) continue;
    seen.add(id);
    const u = c.user?.screen_name || raw.user?.screen_name || '';
    out.push({ id, text, screen_name: u, created_at: c.created_at || raw.created_at || '', url: u ? `https://x.com/${u}/status/${id}` : '' });
  }
  return out.sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 40);
}

function parseSynd(text) {
  let d = null;
  try { d = JSON.parse(text); } catch {
    const m = text.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) { try { d = JSON.parse(m[1]); } catch { d = null; } }
  }
  if (!d) throw new Error('响应不是 JSON，也找不到 __NEXT_DATA__');
  const t = tweets(d);
  if (!t.length) throw new Error('拿到 JSON 但没有推文字段');
  return t;
}

function parseRss(xml, user) {
  const strip = s => String(s || '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const chunk of (xml.match(/<item[\s\S]*?<\/item>|<entry[\s\S]*?<\/entry>/g) || []).slice(0, 40)) {
    const t = chunk.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const l = chunk.match(/<link[^>]*>([\s\S]*?)<\/link>|<link[^>]*href="([^"]+)"/);
    const d = chunk.match(/<(pubDate|updated|published)[^>]*>([\s\S]*?)<\/\1>/);
    const b = chunk.match(/<(description|content|summary)[^>]*>([\s\S]*?)<\/\1>/);
    const link = strip(l ? l[1] || l[2] : ''), title = strip(t ? t[1] : '');
    const idm = link.match(/status\/(\d{2,25})/);
    out.push({
      id: idm ? idm[1] : link || title,
      text: strip(b ? b[2] : '') || title,
      screen_name: (link.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\//) || [])[1] || user,
      created_at: d && d[2] ? new Date(d[2]).toISOString() : new Date().toISOString(),
      url: link
    });
  }
  return out;
}

async function attempt(name, kind, url, user) {
  const p = { name, url, ok: false };
  try {
    const r = await get(url);
    p.status = r.status; p.ct = r.ct; p.bytes = r.text.length; p.preview = brief(r.text);
    if (r.status >= 400) throw new Error('HTTP ' + r.status);
    if (kind === 'syndication') {
      const t = parseSynd(r.text);
      p.ok = true; p.count = t.length;
      return { p, list: t };
    }
    if (kind === 'rss') {
      const t = parseRss(r.text, user);
      if (!t.length) throw new Error('RSS 无条目');
      p.ok = true; p.count = t.length;
      return { p, list: t };
    }
    if (kind === 'check') {
      const j = JSON.parse(r.text);
      p.ok = !!j.user;
      p.note = p.ok ? `${j.user.name} / 粉丝 ${j.user.followers}` : '无 user 字段';
      return { p, list: [] };
    }
    return { p, list: [] };
  } catch (e) {
    p.error = String(e.message || e);
    return { p, list: [] };
  }
}

async function main() {
  const probes = [], users = {};
  for (const user of USERS) {
    users[user] = [];
    let chosen = null;
    for (const [name, kind, url] of SOURCES(user)) {
      const { p, list } = await attempt(name, kind, url, user);
      probes.push({ user, ...p });
      console.log(`[${p.ok ? 'ok' : '--'}] ${name.padEnd(20)} status=${p.status ?? '-'} bytes=${p.bytes ?? '-'} ${p.error || p.note || 'count=' + p.count}`);
      if (p.ok && list.length && !chosen) { chosen = name; users[user] = list; }
    }
    console.log(chosen ? `=> ${user} 用 ${chosen}，${users[user].length} 条` : `=> ${user} 无可用源`);
  }
  for (const url of EXTRA_RSS) {
    const user = USERS[0] || 'thsottiaux';
    const { p, list } = await attempt('extra-rss', 'rss', url, user);
    probes.push({ user, ...p });
    if (p.ok && list.length) {
      for (const t of list) if (!users[user].some(x => x.id === t.id)) users[user].push(t);
      users[user].sort((a, b) => Number(b.id) - Number(a.id));
    }
  }
  const anyOk = Object.values(users).some(l => l.length > 0);
  const usable = probes.filter(p => p.ok && p.count).map(p => p.name);
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    runner: 'github-actions',
    users,
    sources: Object.fromEntries(probes.map(p => [p.name, { ok: !!p.ok, status: p.status, bytes: p.bytes, count: p.count, error: p.error }])),
    probes,
    ok: anyOk,
    usableSources: usable,
    hint: anyOk ? undefined : '所有候选源失败，请看 probes 里每个源的 status / ct / preview'
  }, null, 2) + '\n', 'utf8');
  console.log(`\n已写入 ${OUT}\n可用源: ${usable.join(', ') || '(无)'}\n推文总数: ${Object.values(users).reduce((a, b) => a + b.length, 0)}`);
}

main().catch(e => { console.error(e); process.exit(1); });
