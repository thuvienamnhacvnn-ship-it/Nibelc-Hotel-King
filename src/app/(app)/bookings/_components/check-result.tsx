import { Badge } from "@/components/ui";
import { formatInstant } from "@/lib/time";

/** Kết quả kiểm tra lần cuối của một yêu cầu thay đổi (lưu trong change_requests.check_result). */
export function CheckResult({ check, timezone }: { check: { ok: boolean; issues: { message: string }[]; checkedAt: string } | null; timezone: string }) {
  if (!check) return <span className="faint">Chưa kiểm</span>;
  return (
    <div>
      <Badge tone={check.ok ? "ok" : "danger"}>{check.ok ? "Đạt" : "Không đạt"}</Badge>
      {check.issues.length ? (
        <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
          {check.issues.map((i, n) => (
            <li key={n}>{i.message}</li>
          ))}
        </ul>
      ) : null}
      {check.checkedAt ? <div className="faint">{formatInstant(check.checkedAt, timezone)}</div> : null}
    </div>
  );
}
