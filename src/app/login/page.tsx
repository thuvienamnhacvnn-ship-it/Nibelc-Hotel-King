import { redirect } from "next/navigation";
import { currentActor } from "@/lib/session";
import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Đăng nhập" };

export default async function LoginPage() {
  const actor = await currentActor();
  if (actor) redirect(actor.role === "cleaner" ? "/m" : "/");
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 16, background: "var(--navy-900)" }}>
      <div className="card" style={{ width: "min(400px, 100%)" }}>
        <div className="card-pad stack">
          <div>
            <img src="/logo-vietduc.png" alt="Việt Đức Group" width={170} height={161} style={{ display: "block", margin: "0 auto 12px", maxWidth: "100%", height: "auto" }} />
            <h1 style={{ textAlign: "center" }}>Vietduc Hotel</h1>
            <p className="muted" style={{ margin: "4px 0 0", textAlign: "center" }}>
              Vận hành căn hộ cho thuê — Budapest
            </p>
          </div>
          <LoginForm />
        </div>
      </div>
    </div>
  );
}
