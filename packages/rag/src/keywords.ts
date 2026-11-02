/**
 * PostgreSQL 的 simple 配置不能切分中文，因此中文串转为重叠双字词，如“苏堤春晓”→“苏堤 堤春 春晓”。
 * 英文字母与数字串保持完整，文档和问句共用同一分词规则。
 */
const RUNS = /[\p{Script=Han}]+|[a-z0-9]+/gu;

export function bigrams(text: string): string[] {
  const terms: string[] = [];
  for (const run of text.toLowerCase().match(RUNS) ?? []) {
    if (!/\p{Script=Han}/u.test(run)) {
      terms.push(run);
      continue;
    }
    const chars = [...run];
    if (chars.length === 1) {
      terms.push(run);
      continue;
    }
    for (let at = 0; at + 1 < chars.length; at += 1) terms.push(chars[at] + chars[at + 1]);
  }
  return terms;
}

/**
 * 疑问词缺少主题信息，保留“是谁”等片段会匹配大量无关文章。
 * 用空格替换而不是直接删除，防止空缺两侧的字意外组成新的双字词。
 */
const QUESTION_WORDS = /为什么|怎么样|怎么|什么|哪里|哪些|哪个|哪儿|是谁|有没有|请问|介绍一下|介绍|讲讲|说说|一下|我想知道|吗|呢|吧|啊|是|的|了/g;

export function questionTerms(question: string): string[] {
  return [...new Set(bigrams(question.replace(QUESTION_WORDS, " ")))];
}

/** 把受控词元拼成 simple 配置的 OR 查询；词元仅由汉字或小写字母、数字组成。 */
export function tsQuery(terms: readonly string[]): string | null {
  return terms.length > 0 ? terms.join(" | ") : null;
}
