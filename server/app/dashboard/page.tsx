import { redirect } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import Dashboard from "./dash-client";

export default function DashboardPage() {
  if (!isAuthed()) redirect("/login");
  return <Dashboard />;
}
