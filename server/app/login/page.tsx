import { redirect } from "next/navigation";
import { isAuthed, ownerPasswordSet } from "@/lib/auth";

async function doLogin(formData: FormData) {
  "use server";
  const { checkPassword, makeAuthCookieValue, AUTH_COOKIE } = await import("@/lib/auth");
  const { cookies } = await import("next/headers");
  const pw = String(formData.get("password") ?? "");
  if (!checkPassword(pw)) {
    redirect("/login?error=1");
  }
  cookies().set(AUTH_COOKIE, makeAuthCookieValue(), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 3600,
    secure: true,
  });
  redirect("/connect");
}

export default function LoginPage({ searchParams }: { searchParams: { error?: string } }) {
  if (isAuthed()) redirect("/dashboard");

  if (!ownerPasswordSet()) {
    return (
      <div className="wrap" style={{ maxWidth: 640 }}>
        <div className="card" style={{ marginTop: 40 }}>
          <h2>⚙️ Pehle setup karo</h2>
          <p className="muted">
            Login ke liye server pe <code>OWNER_PASSWORD</code> environment variable set karna
            hoga. Vercel dashboard me:
          </p>
          <ol className="muted" style={{ lineHeight: 2 }}>
            <li>Project <b>whopclip</b> → Settings → Environment Variables</li>
            <li>Naya variable: <code>OWNER_PASSWORD</code> = apna strong password</li>
            <li>Save → Redeploy</li>
          </ol>
          <p className="muted">Uske baad ye page login form dikhayega.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap" style={{ maxWidth: 440 }}>
      <div className="card" style={{ marginTop: 40 }}>
        <h2>Owner login</h2>
        <p className="muted">Dashboard aur app pairing ke liye login karo.</p>
        {searchParams.error && (
          <div className="alert err">Galat password. Dobara try karo.</div>
        )}
        <form action={doLogin}>
          <label>Password</label>
          <input type="password" name="password" autoFocus autoComplete="current-password" />
          <div style={{ marginTop: 16 }}>
            <button className="btn" type="submit" style={{ width: "100%" }}>Login</button>
          </div>
        </form>
      </div>
    </div>
  );
}
