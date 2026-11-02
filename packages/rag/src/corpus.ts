import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 人工编写文章时查阅的来源、访问日期与说明，供审阅者核对来源。 */
export interface ArticleSource {
  readonly url: string;
  readonly accessed: string;
  readonly note: string;
}

/** 自有的稳定知识文章；知识库不收高德数据或抓取网页原文（D-059/D-060）。 */
export interface Article {
  readonly id: string;
  readonly title: string;
  readonly topic: string;
  /** V2.10：文章讲的是哪个城市（地级市一级的行政区编码）；检索只查卡片城市的文章。 */
  readonly city: string;
  /** 只有 reviewed 状态进入产品知识库，是否允许草稿由评测入口显式决定。 */
  readonly status: "draft" | "reviewed";
  readonly sources: readonly ArticleSource[];
  /** 头部元数据之后的 Markdown 正文。 */
  readonly body: string;
}

/**
 * 解析项目自用的精简文章头部：key: value 和 sources 下的“地址 | 日期 | 说明”。
 * 只支持这套受控格式，不按完整 YAML 猜测或容错解析，结构错误直接指出文件。
 */
export function parseArticle(text: string, file: string): Article {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!match) throw new Error(`${file}: missing front matter`);
  const fields = new Map<string, string>();
  const sources: ArticleSource[] = [];
  let inSources = false;
  for (const line of match[1].split("\n")) {
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item && inSources) {
      const [url, accessed, note] = item[1].split("|").map((part) => part.trim());
      if (!url || !URL.canParse(url) || !/^\d{4}-\d{2}-\d{2}$/.test(accessed ?? "") || !note) {
        throw new Error(`${file}: a source needs "url | YYYY-MM-DD | note"`);
      }
      sources.push({ url, accessed, note });
      continue;
    }
    const pair = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!pair) throw new Error(`${file}: cannot read "${line}"`);
    inSources = pair[1] === "sources";
    if (!inSources) fields.set(pair[1], pair[2].trim());
  }
  const id = fields.get("id") ?? "";
  const title = fields.get("title") ?? "";
  const topic = fields.get("topic") ?? "";
  const status = fields.get("status");
  const city = fields.get("city") ?? "";
  if (!/^[a-z0-9-]{1,80}$/.test(id)) throw new Error(`${file}: id must be lowercase letters, digits and dashes`);
  if (!title || !topic) throw new Error(`${file}: title and topic are required`);
  if (status !== "draft" && status !== "reviewed") throw new Error(`${file}: status must be draft or reviewed`);
  if (!/^\d{6}$/.test(city)) throw new Error(`${file}: city must be a 6-digit city code`);
  if (sources.length === 0) throw new Error(`${file}: at least one source is required`);
  return { id, title, topic, city, status, sources, body: match[2].trim() };
}

export async function loadCorpus(directory: string): Promise<Article[]> {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
  const articles = await Promise.all(
    files.map(async (name) => parseArticle(await readFile(join(directory, name), "utf8"), name)),
  );
  // 文章 ID 同时决定入库覆盖和段落引用身份，重复 ID 不能按文件顺序静默覆盖。
  const ids = new Set<string>();
  for (const article of articles) {
    if (ids.has(article.id)) throw new Error(`duplicate article id ${article.id}`);
    ids.add(article.id);
  }
  return articles;
}
