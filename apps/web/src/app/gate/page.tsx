import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ClientGateForm } from "@/components/client-gate-form";
import { gateCookieName, readGateToken } from "@/server/auth/client-gate";
export const metadata = { title: "Client access" };
// Only a same-origin relative path may pass through, or the gate becomes an open redirect.
function safeNext(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^\/(?!\/)/.test(candidate) && !candidate.includes("\\") ? candidate : "/book";
}
export default async function GatePage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  const target = safeNext(next);
  // Convenience only; the authoritative gate check lives in every /api/public handler.
  if (readGateToken((await cookies()).get(gateCookieName())?.value)) redirect(target);
  return <ClientGateForm next={target} />;
}
