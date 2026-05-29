#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";

const API_BASE = "https://flash.biteagle.xyz/api";
const OUT_DIR = new URL("./data/source-discovery/", import.meta.url);
const STATE_FILE = new URL("./data/source-discovery/state.json", import.meta.url);
const HOSTS_FILE = new URL("./data/source-discovery/source-hosts.json", import.meta.url);
const NON_ODAILY_JSONL = new URL("./data/source-discovery/non-odaily-news.jsonl", import.meta.url);
const ALL_SOURCES_JSONL = new URL("./data/source-discovery/all-sources.jsonl", import.meta.url);

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
    from: args.has("from") ? Number(args.get("from")) : null,
    to: Number(args.get("to") || 1),
    limit: args.has("limit") ? Number(args.get("limit")) : null,
    concurrency: Number(args.get("concurrency") || 6),
    timeoutMs: Number(args.get("timeout-ms") || 5000),
    resume: !args.has("no-resume"),
  };
}

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, "utf8"));
  } catch {
    return fallback;
  }
}

async function latestId() {
  const body = await requestNews("latest", 10000);
  return body.id;
}

async function requestNews(id, timeoutMs) {
  const url = new URL(`${API_BASE}/news`);
  url.searchParams.set("id", id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    const body = await res.json();
    if (body.status !== 200 || !body.data?.id) return null;
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
}

function hostOf(source) {
  if (!source) return "";
  try {
    return new URL(source).hostname.replace(/^www\./, "");
  } catch {
    return "(invalid)";
  }
}

function sourceRecord(news) {
  const source = news.source || "";
  return {
    id: news.id,
    created_at: Array.isArray(news.created_at) ? news.created_at[0] : news.created_at || "",
    title: news.title || "",
    source,
    source_host: hostOf(source),
    news_type: news.news_type || "",
  };
}

async function appendRecord(file, item) {
  await appendFile(file, `${JSON.stringify(item)}\n`);
}

async function worker(queue, options, hosts, seenIds, state) {
  for (;;) {
    const id = queue.pop();
    if (id == null) return;
    if (seenIds.has(id)) continue;
    try {
      const news = await requestNews(id, options.timeoutMs);
      seenIds.add(id);
      state.scanned += 1;
      state.nextId = Math.min(state.nextId, id - 1);
      if (!news?.source) continue;

      const item = sourceRecord(news);
      const host = item.source_host || "(empty)";
      hosts[host] ||= { count: 0, examples: [] };
      hosts[host].count += 1;
      if (hosts[host].examples.length < 5) hosts[host].examples.push(item);

      await appendRecord(ALL_SOURCES_JSONL, item);
      if (host !== "odaily.news") await appendRecord(NON_ODAILY_JSONL, item);

      if (state.scanned % 100 === 0) {
        await writeFile(HOSTS_FILE, JSON.stringify(hosts, null, 2));
        await writeFile(STATE_FILE, JSON.stringify(state, null, 2));
        console.log(`scanned=${state.scanned} next=${state.nextId} hosts=${Object.keys(hosts).length}`);
      }
    } catch (error) {
      state.errors += 1;
    }
  }
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const options = parseArgs();
  const latest = options.from ?? (await latestId());
  const previousState = options.resume ? await readJson(STATE_FILE, null) : null;
  const from = previousState?.nextId && previousState.from === latest && previousState.to === options.to
    ? previousState.nextId
    : latest;
  const limitTo = options.limit ? Math.max(options.to, from - options.limit + 1) : options.to;

  const hosts = await readJson(HOSTS_FILE, {});
  const seenIds = new Set();
  const state = previousState?.from === latest && previousState.to === options.to
    ? previousState
    : { from: latest, to: options.to, nextId: from, scanned: 0, errors: 0, startedAt: new Date().toISOString() };

  const queue = [];
  for (let id = from; id >= limitTo; id -= 1) queue.push(id);

  console.log(`scan from #${from} down to #${limitTo}, concurrency=${options.concurrency}`);
  await Promise.all(Array.from({ length: options.concurrency }, () => worker(queue, options, hosts, seenIds, state)));

  state.nextId = limitTo - 1;
  state.updatedAt = new Date().toISOString();
  await writeFile(HOSTS_FILE, JSON.stringify(hosts, null, 2));
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2));

  const summary = Object.entries(hosts)
    .map(([host, info]) => ({ host, count: info.count }))
    .sort((a, b) => b.count - a.count);
  console.log(JSON.stringify({ state, summary }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
