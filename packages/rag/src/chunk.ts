import type { Article } from "./corpus";

export interface Chunk {
  readonly seq: number;
  /** “文章标题 > 章节标题”同时进入向量文本和引用展示，为短段落补齐主题语境。 */
  readonly headingPath: string;
  readonly body: string;
}

export type ChunkStrategy = "heading" | "fixed";

/** 分块规则变化时递增版本，使入库哈希失效并重新向量化，而不是误用旧段落。 */
export const CHUNKER_VERSION = "chunk.v1";
export const MAX_CHUNK = 400;
export const FIXED_CHUNK = 300;
export const OVERLAP = 40;

interface Section {
  readonly heading: string | null;
  readonly text: string;
}

/** 按二级标题划分主题区，首个二级标题之前的正文作为引言；一级标题由文章元数据提供。 */
function sections(article: Article): Section[] {
  const result: Section[] = [];
  let heading: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    const text = lines.join("\n").trim();
    if (text) result.push({ heading, text });
    lines = [];
  };
  for (const line of article.body.split("\n")) {
    if (/^#\s/.test(line)) continue;
    const next = /^##\s+(.+)$/.exec(line);
    if (next) {
      flush();
      heading = next[1].trim();
      continue;
    }
    lines.push(line);
  }
  flush();
  return result;
}

const pathOf = (article: Article, heading: string | null) =>
  heading ? `${article.title} > ${heading}` : article.title;

/** 句末标点保留；换行也视为边界，避免列表项无标点时被合并成长句。 */
function sentences(text: string): string[] {
  return text.match(/[^。！？；\n]+[。！？；]?|\n/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
}

/**
 * 先按句装入不超过 max 个字符的块，后续块带上前一块末尾 overlap 个字符。
 * 超长单句先按长度拆开，确保重叠部分也计入长度上限。
 */
export function packSentences(text: string, max = MAX_CHUNK, overlap = OVERLAP): string[] {
  if ([...text].length <= max) return [text];
  // 以 Unicode 字符而非 UTF-16 长度计数；预留 overlap 容量后，长句碎片再装箱也不会撑破上限。
  const step = max - overlap;
  const parts = sentences(text).flatMap((sentence) => {
    const chars = [...sentence];
    if (chars.length <= step) return [sentence];
    const cut: string[] = [];
    for (let start = 0; start < chars.length; start += step) cut.push(chars.slice(start, start + step).join(""));
    return cut;
  });
  const pieces: string[] = [];
  let current = "";
  // 区分新正文与上块带来的重叠尾巴，防止末尾只剩重复内容时又输出一个空增量块。
  let fresh = false;
  for (const part of parts) {
    if (fresh && [...current].length + [...part].length > max) {
      pieces.push(current.trim());
      current = [...current].slice(-overlap).join("");
      fresh = false;
    }
    current += part;
    fresh = true;
  }
  if (fresh) pieces.push(current.trim());
  return pieces;
}

/** 默认按章节分块，长章节再按句拆分，使一个块尽量只围绕一个主题。 */
export function chunkByHeading(article: Article): Chunk[] {
  const chunks: Chunk[] = [];
  // 在章节内按句装箱，避免跨标题混合主题；标题路径也会参与向量化和关键词索引，
  // 让“是谁修的”这类省略主体的段落仍带着景点语境，并能展示到具体段落的出处。
  for (const section of sections(article)) {
    for (const body of packSentences(section.text)) {
      chunks.push({ seq: chunks.length, headingPath: pathOf(article, section.heading), body });
    }
  }
  return chunks;
}

/** 评测对照方案：整篇正文按固定窗口切分，允许跨章节，用于衡量标题边界的价值。 */
export function chunkFixed(article: Article, size = FIXED_CHUNK, overlap = OVERLAP): Chunk[] {
  const marks: { at: number; heading: string | null }[] = [];
  let text = "";
  for (const section of sections(article)) {
    marks.push({ at: [...text].length, heading: section.heading });
    text += `${section.text}\n`;
  }
  const chars = [...text.trim()];
  const chunks: Chunk[] = [];
  for (let start = 0; start < chars.length; start += size - overlap) {
    const heading = marks.filter((mark) => mark.at <= start).at(-1)?.heading ?? null;
    chunks.push({ seq: chunks.length, headingPath: pathOf(article, heading), body: chars.slice(start, start + size).join("").trim() });
    if (start + size >= chars.length) break;
  }
  return chunks;
}

export function chunkArticle(article: Article, strategy: ChunkStrategy): Chunk[] {
  return strategy === "heading" ? chunkByHeading(article) : chunkFixed(article);
}

/** 向量与关键词索引使用相同文本：先标题路径，后段落正文。 */
export const chunkText = (chunk: Chunk) => `${chunk.headingPath}\n${chunk.body}`;
