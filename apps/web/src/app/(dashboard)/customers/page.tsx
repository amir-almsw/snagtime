import { CustomersView } from "@/components/customers-view";
export const metadata = { title: "Customers" };
// The view is chosen on the server so a link straight to the blacklist renders it without a flash.
export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
  const { view } = await searchParams;
  return <CustomersView initialView={view === "blacklist" ? "blacklist" : "clients"} />;
}
