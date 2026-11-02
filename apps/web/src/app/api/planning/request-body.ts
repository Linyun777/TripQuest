import "server-only";

export const PLANNING_BODY_LIMIT = 64 * 1024;

/**
 * 用 Origin 与浏览器请求的 Host 比较，保护本地入口免受跨站提交。
 * 这不是账号认证；不用 request.url 的主机名比较，因为 Next 可能重写 localhost / 127.0.0.1。
 */
export function sameOrigin(request: Request): boolean {
  // V2.12：带 Bearer 令牌的请求（以后的客户端）不做同源检查：跨站请求带不上这个头，令牌本身由会话检查。
  if (/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")) return true;
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return false;
  const origin = request.headers.get("origin");
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0].trim() ||
    request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/** 读取过程中累计 UTF-8 字节数，超过上限立即停止，避免先把超大请求完整缓冲到内存。 */
export async function readBody(request: Request, limit = PLANNING_BODY_LIMIT): Promise<string | "too_large" | "invalid"> {
  // Content-Length 只能用于提前拒绝；分块传输可能没有它，仍须按实际读取字节执行上限。
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return "too_large";
  if (!request.body) return "invalid";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return "too_large";
      }
      chunks.push(value);
    }
  } catch {
    return "invalid";
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return "invalid";
  }
}
