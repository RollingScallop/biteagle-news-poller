#!/usr/bin/env node

const API_BASE = "https://flash.biteagle.xyz/api";
const BWE_RSS_URL = "https://rss-public.bwe-ws.com/";
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BACKFILL = 30;
const REQUEST_TIMEOUT_MS = 10_000;
const DATA_DIR = new URL("./data/", import.meta.url);
const STATE_FILE = new URL("./data/state.json", import.meta.url);
const JSONL_FILE = new URL("./data/news.jsonl", import.meta.url);
const DEFAULT_BOT_FILE = "./bot.txt";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ensureDataDir() {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(DATA_DIR, { recursive: true });
}

async function readState() {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf8"));
  } catch {
    return { lastSeenId: 0, seenIds: [], seenBweLinks: [] };
  }
}

async function writeState(state) {
  const { writeFile } = await import("node:fs/promises");
  const compact = {
    lastSeenId: state.lastSeenId || 0,
    seenIds: [...new Set(state.seenIds || [])].slice(-5000),
    seenBweLinks: [...new Set(state.seenBweLinks || [])].slice(-5000),
    bweRssInitialized: Boolean(state.bweRssInitialized),
    updatedAt: new Date().toISOString(),
  };
  await writeFile(STATE_FILE, JSON.stringify(compact, null, 2));
}

async function appendNews(item) {
  const { appendFile } = await import("node:fs/promises");
  await appendFile(JSONL_FILE, `${JSON.stringify(item)}\n`);
}

function parseArgs() {
  const args = new Map();
  for (let i = 2; i < process.argv.length; i += 1) {
    const arg = process.argv[i];
    if (!arg.startsWith("--")) continue;
    const [key, inlineValue] = arg.slice(2).split("=");
    const value = inlineValue ?? (process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i]);
    args.set(key, value);
  }
  return {
    mode: args.get("mode") || "poll",
    intervalMs: Number(args.get("interval-ms") || DEFAULT_INTERVAL_MS),
    backfill: Number(args.get("backfill") || DEFAULT_BACKFILL),
    comments: args.has("comments"),
    telegram: args.has("telegram"),
    telegramBotFile: args.get("telegram-bot-file") || process.env.TELEGRAM_BOT_FILE || DEFAULT_BOT_FILE,
    telegramChatId: args.get("telegram-chat-id") || process.env.TELEGRAM_CHAT_ID || null,
    telegramProxy: args.get("telegram-proxy") || process.env.TELEGRAM_PROXY || "http://127.0.0.1:7890",
    telegramThreadId: args.get("telegram-thread-id") || process.env.TELEGRAM_MESSAGE_THREAD_ID || null,
    bweRss: !args.has("no-bwe-rss"),
    bweRssUrl: args.get("bwe-rss-url") || process.env.BWE_RSS_URL || BWE_RSS_URL,
  };
}

async function requestJson(path, params) {
  const url = new URL(`${API_BASE}${path}`);
  Object.entries(params || {}).forEach(([key, value]) => url.searchParams.set(key, value));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/json;charset=UTF-8",
        referer: "https://flash.biteagle.xyz/",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    const body = await res.json();
    if (body.status !== 200) throw new Error(`${body.status} ${body.message || "request failed"} ${url}`);
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchNews(id) {
  return requestJson("/news", { id });
}

async function fetchComments(newsId) {
  return requestJson("/news/comment", { news_id: newsId });
}

async function requestText(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/rss+xml, application/xml, text/xml, */*" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.text();
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeNews(news, comments) {
  return {
    id: news.id,
    title: news.title,
    content: news.content,
    created_at: news.created_at?.[0] || null,
    created_at_label: news.created_at?.[1] || null,
    news_type: news.news_type || null,
    source: news.source || null,
    source_host: news.source ? new URL(news.source).hostname : null,
    is_free: news.is_free,
    sort_id: news.sort_id,
    logo: news.logo || null,
    token: news.token || [],
    label: news.label || [],
    quote: news.quote || "",
    author: news.author || [],
    media: news.media || [],
    recommend_news: news.recommend_news || [],
    comments: comments?.list || undefined,
    raw: news,
    fetched_at: new Date().toISOString(),
  };
}

async function readTelegramConfig(file) {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(file, "utf8").catch(() => "");
  const token =
    process.env.TELEGRAM_BOT_TOKEN ||
    text.match(/bot\s*token\s*=\s*(\S+)/i)?.[1] ||
    text.match(/TG_BOT_TOKEN\s*=\s*(\S+)/)?.[1] ||
    text.match(/TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/)?.[1];
  const chatId =
    process.env.TELEGRAM_CHAT_ID ||
    text.match(/TELEGRAM_CHAT_ID\s*=\s*(-?\d+)/)?.[1] ||
    text.match(/TG_CHAT_ID\s*=\s*(-?\d+)/)?.[1];
  const messageThreadId =
    process.env.TELEGRAM_MESSAGE_THREAD_ID ||
    text.match(/TELEGRAM_MESSAGE_THREAD_ID\s*=\s*(\d+)/)?.[1] ||
    text.match(/TG_MESSAGE_THREAD_ID\s*=\s*(\d+)/)?.[1];
  if (!token || !chatId) {
    throw new Error(`Missing Telegram token or chat id. Set env vars or provide ${file}`);
  }
  return { token, chatId, messageThreadId };
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;br\s*\/&gt;/gi, "\n")
    .replace(/&lt;br&gt;/gi, "\n")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

function cleanNewsContent(text) {
  return String(text || "")
    .replace(/^(Odaily星球日报讯|星球日报讯|BlockBeats 消息|BlockBeats消息|金十数据APP讯|PANews\s*讯|据\s*)[，,：:\s]*/i, "")
    .trim();
}

function escapeTelegramHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function extractXmlTag(xml, tag) {
  return decodeXml(xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1] || "");
}

function parseBweTitle(rawTitle) {
  const text = decodeXml(rawTitle)
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const source = text.match(/source:\s*(\S+)/i)?.[1] || "";
  const withoutSource = text.replace(/\n?source:\s*\S+\s*$/i, "").trim();
  const [bodyPart = withoutSource, timePart = ""] = withoutSource.split(/\n*————————————\n*/);
  const embeddedTime = timePart.trim().split(/\n/)[0]?.trim() || "";
  const lines = bodyPart.split("\n").map((line) => line.trim()).filter(Boolean);
  const chineseIndex = lines.findIndex((line) => /[\u4e00-\u9fff]/.test(line));
  const titleIndex = chineseIndex >= 0 ? chineseIndex : 0;
  const title = (lines[titleIndex] || "BWEnews")
    .replace(/^AI自动发布\(速度优先可能有误[:：]?\s*/i, "AI自动发布：")
    .trim();
  const body = lines
    .filter((line, index) => index !== titleIndex && index !== 0)
    .filter((line) => !/^AggrNews:/i.test(line))
    .join("\n")
    .trim();

  return { title, body, source, embeddedTime };
}

function parseBweRss(xml) {
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((match) => {
    const itemXml = match[1];
    const link = extractXmlTag(itemXml, "link");
    const pubDate = extractXmlTag(itemXml, "pubDate");
    const parsed = parseBweTitle(itemXml.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || "");
    const createdAt = parsed.embeddedTime || new Date(pubDate).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
    const source = parsed.source || link;
    let sourceHost = null;
    try {
      sourceHost = source ? new URL(source).hostname : null;
    } catch {
      sourceHost = null;
    }
    return {
      feed: "bwe-rss",
      id: link || `${parsed.title}:${pubDate}`,
      title: parsed.title,
      content: parsed.body,
      created_at: createdAt,
      source,
      source_host: sourceHost,
      raw_link: link,
      raw_pub_date: pubDate,
      fetched_at: new Date().toISOString(),
    };
  });
}

async function sendTelegram(item, options) {
  const { spawn } = await import("node:child_process");
  const { token, chatId, messageThreadId } = await readTelegramConfig(options.telegramBotFile);
  const targetChatId = options.telegramChatId || chatId;
  const content = cleanNewsContent(stripHtml(item.content));
  const title = escapeTelegramHtml(item.title);
  const body = escapeTelegramHtml(content.slice(0, 1200));
  const time = item.created_at ? `时间：${escapeTelegramHtml(item.created_at)}` : null;
  const detail = item.source
    ? `<a href="${escapeTelegramHtml(item.source)}">查看详情</a>`
    : null;
  const message = [
    `<b>${title}</b>`,
    time,
    body ? `\n${body}` : null,
    detail ? `\n${detail}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const payload = JSON.stringify({
    chat_id: targetChatId,
    ...(options.telegramThreadId || messageThreadId
      ? { message_thread_id: Number(options.telegramThreadId || messageThreadId) }
      : {}),
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
  const curlConfig = [
    options.telegramProxy ? `proxy = "${options.telegramProxy}"` : null,
    `url = "https://api.telegram.org/bot${token}/sendMessage"`,
    `request = "POST"`,
    `header = "content-type: application/json"`,
    `data = ${JSON.stringify(payload)}`,
    `silent`,
    `show-error`,
    `max-time = 20`,
  ]
    .filter(Boolean)
    .join("\n");

  await new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/curl", ["-K", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.on("error", (error) => {
      reject(error);
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`Telegram curl failed: ${stderr.trim()}`));
      try {
        const body = JSON.parse(stdout);
        if (!body.ok) return reject(new Error(`Telegram API failed: ${body.description}`));
        console.log(`  telegram: sent message_id=${body.result.message_id}`);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(curlConfig);
  });
}

async function processBweRss(options, state) {
  state.seenBweLinks ||= [];
  const items = parseBweRss(await requestText(options.bweRssUrl));

  if (!state.bweRssInitialized) {
    state.seenBweLinks = [...new Set([...state.seenBweLinks, ...items.map((item) => item.id)])];
    state.bweRssInitialized = true;
    await writeState(state);
    console.log(`BWE RSS initialized with ${items.length} current item(s)`);
    return;
  }

  for (const item of items) {
    if (state.seenBweLinks.includes(item.id)) continue;
    await appendNews(item);
    console.log(`[${item.created_at}] BWE RSS ${item.title}`);
    if (item.source) console.log(`  source: ${item.source}`);
    if (options.telegram) {
      try {
        await sendTelegram(item, options);
      } catch (error) {
        console.warn(`  telegram error: ${error.message}`);
      }
    }
    state.seenBweLinks.push(item.id);
    await writeState(state);
  }
}

async function captureOne(id, options, state) {
  const news = await fetchNews(id);
  if (!news?.id) return null;
  if (state.seenIds.includes(news.id)) return null;

  const comments = options.comments ? await fetchComments(news.id) : null;
  const item = normalizeNews(news, comments);
  await appendNews(item);

  console.log(`[${item.created_at}] #${item.id} ${item.title}`);
  if (item.source) console.log(`  source: ${item.source}`);
  if (options.telegram) {
    try {
      await sendTelegram(item, options);
    } catch (error) {
      console.warn(`  telegram error: ${error.message}`);
    }
  }

  state.lastSeenId = Math.max(state.lastSeenId || 0, news.id);
  state.seenIds.push(news.id);
  await writeState(state);
  return item;
}

async function backfillFrom(latestId, count, options, state) {
  for (let id = latestId - count + 1; id <= latestId; id += 1) {
    try {
      await captureOne(id, options, state);
    } catch (error) {
      console.warn(`skip #${id}: ${error.message}`);
    }
    await sleep(250);
  }
}

async function poll(options) {
  await ensureDataDir();
  const state = await readState();

  const latest = await fetchNews("latest");
  if (!state.lastSeenId) {
    await backfillFrom(latest.id, options.backfill, options, state);
  }
  if (options.bweRss) {
    try {
      await processBweRss(options, state);
    } catch (error) {
      console.warn(`BWE RSS init error: ${error.message}`);
    }
  }

  if (options.mode === "once") return;

  console.log(`polling every ${options.intervalMs}ms from #${state.lastSeenId || latest.id}`);
  for (;;) {
    try {
      const current = await fetchNews("latest");
      const start = Math.max((state.lastSeenId || current.id) + 1, current.id - options.backfill + 1);
      for (let id = start; id <= current.id; id += 1) {
        await captureOne(id, options, state);
      }
      if (options.bweRss) await processBweRss(options, state);
    } catch (error) {
      console.warn(`poll error: ${error.message}`);
    }
    await sleep(options.intervalMs);
  }
}

poll(parseArgs()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
