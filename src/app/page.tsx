import { redirect } from "next/navigation";

import { currentUser } from "@/lib/session";

/**
 * The front door opens onto whatever this person is here to do.
 *
 * An admin wants the dashboard. A booker has no dashboard - sending them there
 * would bounce them straight back out again, which reads as a broken app.
 */
export default async function Home() {
  const user = await currentUser();
  redirect(user == null ? "/login" : user.role === "admin" ? "/dashboard" : "/my");
}
