import { ManageLookupForm } from "@/components/manage-lookup-form";
export const metadata = { title: "Manage my appointment" };
// Deliberately not behind the client gate: this is the page for someone who has lost their link, and a
// lapsed gate cookie is exactly the situation it has to survive. It reveals nothing on its own -- the
// lookup behind it answers identically whether or not anything matched.
export default function ManageLookupPage() {
  return <ManageLookupForm />;
}
