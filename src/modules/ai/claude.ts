/**
 * Gọi Claude API (Anthropic Messages API) bằng fetch — không thêm thư viện.
 * Khoá chỉ đọc từ biến môi trường ANTHROPIC_API_KEY trên server; không log khoá, không log nội dung tin.
 */

export const DEFAULT_GUEST_MODEL = "claude-haiku-4-5-20251001";

/** Giá USD cho 1 triệu token (vào, ra). Model lạ ⇒ dùng giá cao để trần chi phí luôn an toàn. */
const PRICES: Record<string, [number, number]> = {
  "claude-haiku-4-5-20251001": [1, 5],
  "claude-sonnet-4-5-20250929": [3, 15],
  "claude-sonnet-4-6": [3, 15],
};
const FALLBACK_PRICE: [number, number] = [15, 75];

export function aiConfigured(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

export function guestModel(): string {
  return process.env.AI_GUEST_MODEL?.trim() || DEFAULT_GUEST_MODEL;
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const [pin, pout] = PRICES[model] ?? FALLBACK_PRICE;
  return (inputTokens * pin + outputTokens * pout) / 1_000_000;
}

export interface ToolDef {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

export interface ToolCallResult<T> {
  input: T;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class AiError extends Error {
  constructor(
    public code: "not_configured" | "timeout" | "http_error" | "bad_output",
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

/**
 * Một lượt gọi bắt buộc dùng đúng một công cụ (tool) để nhận kết quả có cấu trúc.
 * Lỗi mạng/HTTP/quá thời gian ⇒ ném AiError — bên gọi tự quay về cách không dùng AI.
 */
export async function callTool<T>(opts: { system: string; user: string; tool: ToolDef; model?: string; maxTokens?: number; timeoutMs?: number }): Promise<ToolCallResult<T>> {
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (!key) throw new AiError("not_configured", "Chưa cấu hình ANTHROPIC_API_KEY");
  const model = opts.model ?? guestModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 25_000);
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model,
        max_tokens: opts.maxTokens ?? 800,
        system: opts.system,
        tools: [opts.tool],
        tool_choice: { type: "tool", name: opts.tool.name },
        messages: [{ role: "user", content: opts.user }],
      }),
    });
  } catch (error) {
    throw new AiError((error as Error)?.name === "AbortError" ? "timeout" : "http_error", "Không gọi được Claude API");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    // Chỉ giữ mã lỗi và loại lỗi — không chép nội dung phản hồi (có thể lặp lại dữ liệu đã gửi).
    let type = "";
    try {
      type = ((await res.json()) as { error?: { type?: string } }).error?.type ?? "";
    } catch {
      /* bỏ qua */
    }
    throw new AiError("http_error", `Claude API trả ${res.status}${type ? ` (${type})` : ""}`, res.status);
  }
  const data = (await res.json()) as {
    model?: string;
    content?: { type: string; name?: string; input?: unknown }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const block = data.content?.find((c) => c.type === "tool_use" && c.name === opts.tool.name);
  if (!block || typeof block.input !== "object" || block.input === null) throw new AiError("bad_output", "Claude không trả kết quả đúng dạng");
  const inputTokens = data.usage?.input_tokens ?? 0;
  const outputTokens = data.usage?.output_tokens ?? 0;
  return { input: block.input as T, model: data.model ?? model, inputTokens, outputTokens, costUsd: costUsd(model, inputTokens, outputTokens) };
}
