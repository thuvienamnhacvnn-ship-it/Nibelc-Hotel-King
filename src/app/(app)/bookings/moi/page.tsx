import Link from "next/link";
import { Card, EmptyState, PageHeader } from "@/components/ui";
import { requireActor } from "@/lib/session";
import { todayOps } from "@/lib/time";
import { can } from "@/modules/auth/actor";
import { unitOptions } from "@/modules/booking/queries";
import { NewBookingForm } from "./new-booking-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tạo booking" };

export default async function NewBookingPage() {
  const actor = await requireActor("booking.create");
  const units = await unitOptions(actor);

  return (
    <div className="stack">
      <PageHeader
        title="Tạo booking thủ công"
        description="Dùng cho booking trực tiếp hoặc booking kênh chưa đồng bộ. Hệ thống kiểm chỗ trống và giữ tồn ngay khi lưu; trùng phòng thì không lưu và hiện chi tiết."
        actions={
          <Link className="btn" href="/bookings">
            ← Danh sách
          </Link>
        }
      />
      {units.length === 0 ? (
        <Card>
          <EmptyState title="Chưa có căn/phòng nào">Khai báo nhà và căn/phòng trong danh mục trước khi tạo booking.</EmptyState>
        </Card>
      ) : (
        <NewBookingForm
          today={todayOps(actor.timezone)}
          showMoney={can(actor, "revenue.view")}
          units={units.map((u) => ({
            id: u.id,
            code: u.code,
            name: u.name,
            kind: u.kind,
            capacity: u.capacity,
            active: u.active,
            propertyId: u.property_id,
            propertyCode: u.property_code,
            propertyName: u.property_name,
          }))}
        />
      )}
    </div>
  );
}
