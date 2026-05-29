import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} = require("docx");

const API_BASE = "https://flash.biteagle.xyz/api";
const OUT_DIR = new URL("./exports/", import.meta.url);
const JSON_OUT = new URL("./exports/biteagle-recent-50.json", import.meta.url);
const DOCX_OUT = new URL("./exports/biteagle-recent-50.docx", import.meta.url);
const LOCAL_JSONL = new URL("./data/news.jsonl", import.meta.url);

async function requestJson(id) {
  const url = new URL(`${API_BASE}/news`);
  url.searchParams.set("id", id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json, text/plain, */*" },
    });
    const body = await res.json();
    if (body.status !== 200) throw new Error(`${body.status} ${body.message}`);
    return body.data;
  } finally {
    clearTimeout(timeout);
  }
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

async function readLocalNews() {
  try {
    const text = await readFile(LOCAL_JSONL, "utf8");
    return text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function normalize(news) {
  return {
    id: news.id,
    title: news.title || "",
    created_at: Array.isArray(news.created_at) ? news.created_at[0] : news.created_at || "",
    news_type: news.news_type || "",
    source: news.source || "",
    source_host: news.source ? new URL(news.source).hostname : news.source_host || "",
    content_text: stripHtml(news.content),
  };
}

async function collectRecent50() {
  const latest = await requestJson("latest");
  const latestId = latest.id;
  const byId = new Map((await readLocalNews()).map((item) => [item.id, item.raw || item]));

  for (let id = latestId; id > latestId - 80 && byId.size < 80; id -= 1) {
    if (byId.has(id)) continue;
    try {
      byId.set(id, await requestJson(id));
    } catch {
      // Some ids may be missing or temporarily unavailable.
    }
  }

  return [...byId.values()]
    .map(normalize)
    .filter((item) => item.id)
    .sort((a, b) => b.id - a.id)
    .slice(0, 50);
}

function paragraph(text, options = {}) {
  return new Paragraph({
    spacing: { after: options.after ?? 120, before: options.before ?? 0 },
    alignment: options.alignment,
    heading: options.heading,
    children: [new TextRun({ text, bold: options.bold, size: options.size })],
  });
}

function buildDoc(items) {
  const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 240 },
      children: [new TextRun({ text: "BitEagle 最近 50 条新闻记录", bold: true, size: 36 })],
    }),
    paragraph(`生成时间：${generatedAt}`, { alignment: AlignmentType.CENTER, after: 80 }),
    paragraph(`记录范围：#${items.at(-1)?.id || ""} - #${items[0]?.id || ""}`, {
      alignment: AlignmentType.CENTER,
      after: 360,
    }),
  ];

  for (const [index, item] of items.entries()) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: index === 0 ? 120 : 360, after: 120 },
        children: [new TextRun({ text: `${index + 1}. #${item.id} ${item.title}`, bold: true, size: 28 })],
      }),
      paragraph(`时间：${item.created_at || "-"}    类型：${item.news_type || "-"}`, { after: 80 }),
      paragraph(`信源：${item.source_host || "-"}`, { after: 80 }),
      new Paragraph({
        spacing: { after: 120 },
        children: [
          new TextRun({ text: "链接：" }),
          item.source
            ? new ExternalHyperlink({
                link: item.source,
                children: [new TextRun({ text: item.source, style: "Hyperlink" })],
              })
            : new TextRun({ text: "-" }),
        ],
      }),
      paragraph(item.content_text || "-", { after: 160 })
    );
  }

  return new Document({
    styles: {
      default: {
        document: { run: { font: "Arial", size: 22 } },
      },
      paragraphStyles: [
        {
          id: "Title",
          name: "Title",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: "Arial", size: 36, bold: true },
          paragraph: { spacing: { after: 240 } },
        },
        {
          id: "Heading1",
          name: "Heading 1",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: "Arial", size: 28, bold: true },
          paragraph: { spacing: { before: 240, after: 120 }, outlineLevel: 0 },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: 12240, height: 15840 },
            margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
          },
        },
        children,
      },
    ],
  });
}

await mkdir(OUT_DIR, { recursive: true });
const items = await collectRecent50();
await writeFile(JSON_OUT, JSON.stringify(items, null, 2));
await writeFile(DOCX_OUT, await Packer.toBuffer(buildDoc(items)));
console.log(JSON.stringify({ count: items.length, docx: DOCX_OUT.pathname, json: JSON_OUT.pathname }, null, 2));
