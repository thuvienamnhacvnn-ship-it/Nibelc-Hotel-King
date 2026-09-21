"use client";

import { useState } from "react";
import { Dialog, ErrorText, useAction } from "@/components/client";

type RoleOption = { value: string; label: string };

/**
 * Thao tác trên một người dùng: đặt lại mật khẩu, đổi vai trò, khoá/mở.
 * Mật khẩu tạm chỉ nằm trong state của hộp thoại này và biến mất khi đóng — không lưu ở đâu khác.
 */
export function UserActions({
  id,
  name,
  email,
  role,
  active,
  isSelf,
  roles,
}: {
  id: string;
  name: string;
  email: string;
  role: string;
  active: boolean;
  isSelf: boolean;
  roles: RoleOption[];
}) {
  const [open, setOpen] = useState<null | "reset" | "role" | "active">(null);
  const [password, setPassword] = useState<string | null>(null);
  const [nextRole, setNextRole] = useState(role);
  const [copied, setCopied] = useState(false);
  const { run, busy, error, setError } = useAction();

  const close = () => {
    setOpen(null);
    setError(null);
    setPassword(null);
    setCopied(false);
    setNextRole(role);
  };

  return (
    <div className="row">
      <button type="button" className="btn btn-sm" disabled={isSelf} title={isSelf ? "Mật khẩu của bạn đổi ở “Tài khoản của tôi”" : undefined} onClick={() => setOpen("reset")}>
        Đặt lại mật khẩu
      </button>
      <button type="button" className="btn btn-sm" disabled={isSelf} title={isSelf ? "Không tự đổi vai trò của chính mình" : undefined} onClick={() => setOpen("role")}>
        Đổi vai trò
      </button>
      <button
        type="button"
        className={`btn btn-sm ${active ? "btn-danger" : ""}`}
        disabled={isSelf && active}
        title={isSelf && active ? "Không tự khoá tài khoản của chính mình" : undefined}
        onClick={() => setOpen("active")}
      >
        {active ? "Khoá" : "Mở lại"}
      </button>

      <Dialog
        open={open === "reset"}
        onClose={close}
        title={`Đặt lại mật khẩu — ${name}`}
        footer={
          password ? (
            <button type="button" className="btn btn-primary" onClick={close}>
              Tôi đã gửi cho họ — đóng
            </button>
          ) : (
            <>
              <button type="button" className="btn" onClick={close} disabled={busy}>
                Huỷ
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  const res = await run<{ password: string }>(`/api/v1/users/${id}/reset-password`, { body: {} });
                  if (res.data?.password) setPassword(res.data.password);
                }}
              >
                {busy ? "Đang đặt…" : "Sinh mật khẩu tạm"}
              </button>
            </>
          )
        }
      >
        <div className="stack">
          {password ? (
            <>
              <div className="notice notice-warn">
                Mật khẩu chỉ hiện <strong>một lần</strong>. Đóng hộp thoại là không xem lại được — muốn lại thì phải đặt lại lần nữa.
              </div>
              <div className="field">
                <label htmlFor={`pw-${id}`}>Mật khẩu tạm của {email}</label>
                <div className="row">
                  <input id={`pw-${id}`} className="input mono" readOnly value={password} onFocus={(e) => e.currentTarget.select()} style={{ fontSize: 18 }} />
                  <button
                    type="button"
                    className="btn"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(password);
                        setCopied(true);
                      } catch {
                        setCopied(false);
                      }
                    }}
                  >
                    {copied ? "Đã chép" : "Sao chép"}
                  </button>
                </div>
              </div>
              <div className="small muted">
                Gửi RIÊNG cho đúng {name} (tin nhắn riêng hoặc đọc trực tiếp), không dán vào nhóm chat. Bảo họ đổi lại ở mục “Tài khoản của tôi” ngay sau khi đăng nhập. Mọi phiên đang mở của họ đã bị huỷ.
              </div>
            </>
          ) : (
            <div>
              Sinh mật khẩu tạm cho <strong>{name}</strong> ({email}). Mật khẩu cũ mất tác dụng ngay và mọi phiên đang mở của họ bị huỷ. Chỉ làm khi bạn chắc chắn người yêu cầu đúng là họ.
            </div>
          )}
          <ErrorText error={error} />
        </div>
      </Dialog>

      <Dialog
        open={open === "role"}
        onClose={close}
        title={`Đổi vai trò — ${name}`}
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Huỷ
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || nextRole === role}
              onClick={async () => {
                const res = await run(`/api/v1/users/${id}`, { method: "PATCH", body: { role: nextRole } });
                if (!res.error) close();
              }}
            >
              {busy ? "Đang lưu…" : "Lưu vai trò"}
            </button>
          </>
        }
      >
        <div className="stack">
          <div className="field">
            <label htmlFor={`role-${id}`}>Vai trò</label>
            <select id={`role-${id}`} className="select" value={nextRole} onChange={(e) => setNextRole(e.target.value)}>
              {roles.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>
          <div className="small muted">Quyền đổi theo vai trò và có hiệu lực ngay ở lần tải trang kế tiếp của người đó. Thao tác được ghi Nhật ký.</div>
          <ErrorText error={error} />
        </div>
      </Dialog>

      <Dialog
        open={open === "active"}
        onClose={close}
        title={`${active ? "Khoá" : "Mở lại"} tài khoản — ${name}`}
        footer={
          <>
            <button type="button" className="btn" onClick={close} disabled={busy}>
              Huỷ
            </button>
            <button
              type="button"
              className={`btn ${active ? "btn-danger" : "btn-primary"}`}
              disabled={busy}
              onClick={async () => {
                const res = await run(`/api/v1/users/${id}`, { method: "PATCH", body: { active: !active } });
                if (!res.error) close();
              }}
            >
              {busy ? "Đang lưu…" : active ? "Khoá tài khoản" : "Mở lại"}
            </button>
          </>
        }
      >
        <div className="stack">
          <div>
            {active
              ? "Người này sẽ không đăng nhập được nữa và mọi phiên đang mở bị huỷ ngay. Tài khoản KHÔNG bị xoá — nhật ký và việc đã giao vẫn giữ nguyên tên họ."
              : "Mở lại quyền đăng nhập. Mật khẩu cũ của họ vẫn dùng được; chưa có mật khẩu thì đặt lại một mật khẩu tạm."}
          </div>
          <ErrorText error={error} />
        </div>
      </Dialog>
    </div>
  );
}
