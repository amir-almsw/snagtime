import { ClientGateForm } from "@/components/client-gate-form";
export const metadata = { title: "Client access — SnagTime" };
// Only a same-origin relative path may pass through, or the gate becomes an open redirect.
function safeNext(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && /^\/(?!\/)/.test(candidate) && !candidate.includes("\\") ? candidate : "/";
}
export default async function GatePage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <ClientGateForm next={safeNext(next)} />;
}
