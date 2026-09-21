import Link from "next/link";
import { Badge, Card, DemoBadge, EmptyState, Notice, PageHeader, Pagination, HelpNote } from "@/components/ui";
import { pageParams } from "@/lib/http";
import { requireActor } from "@/lib/session";
import { formatInstant } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { CHANNEL_LABELS } from "@/modules/booking/types";
import { DISPOSITION_LABELS } from "@/modules/imports/excel/issues";
import { importAccountOptions, importCatalogOverview, listImportBatches } from "@/modules/imports/queries";
import { AliasFromNamesButton } from "./_components/small-actions";
import { UploadPanel } from "./_components/upload-panel";
import { BATCH_STATUS_LABELS, batchTone } from "./labels";

export const dynamic = "force-dynamic";
export const metadata = { title: "Nhập Excel" };

export default async function ImportPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await requireActor("import.preview");
  const sp = await searchParams;
  const page = pageParams(new URL(`http://local/?page=${typeof sp.page === "string" ? sp.page : "1"}&pageSize=20`));
  const [batches, overview, accounts] = await Promise.all([listImportBatches(actor, page), importCatalogOverview(actor), importAccountOptions(actor)]);
  const accountChoices = accounts.items.map((a) => ({ id: a.id, text: `${CHANNEL_LABELS[a.channel] ?? a.channel} — ${a.label}` }));

  return (
    <div className="stack">
      <PageHeader
        title={
          <>
            Nhập Excel lịch đặt phòng <DemoBadge show={overview.orgIsDemo} />
          </>
        }
        description="Tải file → xem trước từng dòng → áp dụng các dòng hợp lệ."
      />

      {overview.units === 0 ? (
        <Notice tone="warn" title="Tổ chức chưa có sản phẩm nào">
          Chưa có căn/phòng để tra tên trong cột CĂN HỘ — mọi dòng sẽ vào hàng kiểm tra. Nhập danh mục trước.
        </Notice>
      ) : null}

      <div className="grid grid-2">
        <Card title="1. Tải file và xem trước">
          <UploadPanel accounts={accountChoices} accountRequired={accounts.required} />
        </Card>
        <Card title="Tra tên căn/phòng">
          <div className="stack">
            <p className="small">
              Cột CĂN HỘ được tra theo <strong>mã sản phẩm</strong> và <strong>alias</strong> đã chuẩn hoá (bỏ dấu, "Jozsef krt50" = "J50", "Room"/"at" bị bỏ, "Flat" = "Apartment"). Hiện có{" "}
              <strong>{overview.units}</strong> sản phẩm và <strong>{overview.aliases}</strong> alias. Tên không khớp sẽ vào hàng kiểm tra với lý do &quot;Tên căn/phòng chưa có alias&quot;.
            </p>
            {can(actor, "catalog.edit") ? (
              <AliasFromNamesButton />
            ) : (
              <p className="hint">Cần quyền sửa danh mục để tạo alias từ tên sản phẩm.</p>
            )}
          </div>
        </Card>
      </div>

      <Card title="Các lô đã nhập" pad={false}>
        {batches.items.length === 0 ? (
          <EmptyState title="Chưa có lô nào">Tải một file ở trên để tạo lô xem trước.</EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Tài khoản nguồn</th>
                  <th>Trạng thái</th>
                  <th>Tổng dòng</th>
                  <th>Hợp lệ</th>
                  <th>Cần kiểm tra</th>
                  <th>Mã lặp</th>
                  <th>Đã áp dụng</th>
                  <th>Lỗi</th>
                  <th>Tạo lúc</th>
                </tr>
              </thead>
              <tbody>
                {batches.items.map((b) => {
                  const d = ((b.stats as { byDisposition?: Record<string, number> }).byDisposition ?? {}) as Record<string, number>;
                  const total = (b.stats as { total?: number }).total ?? 0;
                  return (
                    <tr key={b.id}>
                      <td className="strong">
                        <Link href={`/nhap-excel/${b.id}`}>{b.file_name}</Link>
                        <div className="small faint">Sheet {String(b.options.sourceSheet ?? "TH")}</div>
                      </td>
                      <td className="small">{typeof b.options.sourceAccount === "string" && b.options.sourceAccount ? b.options.sourceAccount : <span className="faint">Không ghi</span>}</td>
                      <td>
                        <Badge tone={batchTone(b.status)}>{BATCH_STATUS_LABELS[b.status]}</Badge>
                      </td>
                      <td>{total}</td>
                      <td title={DISPOSITION_LABELS.ready}>{d.ready ?? 0}</td>
                      <td>{d.needs_review ?? 0}</td>
                      <td>{d.duplicate_in_file ?? 0}</td>
                      <td>{d.applied ?? 0}</td>
                      <td>{d.error ?? 0}</td>
                      <td className="small">
                        {formatInstant(b.created_at, actor.timezone)}
                        {b.created_by_name ? <div className="faint">{b.created_by_name}</div> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-pad">
          <Pagination page={batches.page} pageSize={batches.pageSize} total={batches.total} hrefFor={(p) => `/nhap-excel?page=${p}`} />
        </div>
      </Card>
    </div>
  );
}
