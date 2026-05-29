import { redirect } from "next/navigation";

// The dashboard lives at "/"; keep "/dashboard" as a convenience alias.
export default function DashboardAlias() {
  redirect("/");
}
