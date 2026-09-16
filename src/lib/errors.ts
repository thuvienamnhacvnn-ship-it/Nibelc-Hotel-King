/** Lỗi nghiệp vụ có mã ổn định để API và giao diện hiển thị rõ ràng. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const notFound = (what: string) => new AppError("not_found", `Không tìm thấy ${what}.`, 404);
export const forbidden = (message = "Bạn không có quyền thực hiện thao tác này.") => new AppError("forbidden", message, 403);
export const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, details);
export const invalid = (message: string, details?: unknown) => new AppError("invalid_input", message, 422, details);

/** Mã lỗi Postgres của ràng buộc EXCLUDE chống trùng tài nguyên */
export const PG_EXCLUSION_VIOLATION = "23P01";
export const PG_UNIQUE_VIOLATION = "23505";

export function pgCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : undefined;
}
