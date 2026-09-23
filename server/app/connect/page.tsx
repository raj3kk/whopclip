import { redirect } from "next/navigation";
import { isAuthed } from "@/lib/auth";
import PairBox from "./pair-box";

export default function ConnectPage() {
  if (!isAuthed()) redirect("/login");
  const apkUrl = "/whopclip-v18.apk";
  return (
    <div className="wrap" style={{ maxWidth: 720 }}>
      <h1 style={{ marginTop: 28 }}>📱 App connect karo</h1>
      <p className="muted">3 step me tumhara phone WhopClip se jud jayega.</p>

      <div className="card">
        <h3>Step 1 — App install karo</h3>
        <p className="muted">
          Apne Android phone pe APK download karke install karo. Install ke time
          "unknown sources" allow karna padega — ye tumhari khud ki signed app hai.
        </p>
        <a href={apkUrl} className="btn">⬇ Download WhopClip APK</a>
      </div>

      <div className="card">
        <h3>Step 2 — Server URL dalo</h3>
        <p className="muted">App kholo → Settings/Server me ye URL dalo:</p>
        <div className="code" style={{ fontSize: 18, letterSpacing: 1 }}>
          https://whopclip.vercel.app
        </div>
      </div>

      <div className="card">
        <h3>Step 3 — Pairing code</h3>
        <p className="muted">
          Neeche code generate karo, phir app me <b>Pairing Code</b> field me dalo.
          Code 10 minute me expire hota hai.
        </p>
        <PairBox />
      </div>

      <div className="card">
        <h3>Step 4 — Whop + Instagram login</h3>
        <p className="muted">
          App me <b>Login</b> tab kholo → pehle Whop, phir Instagram me login karo.
          Session encrypted server pe save hogi — dobara login nahi karna padega
          jab tak session expire na ho.
        </p>
        <a href="/dashboard" className="btn green">Dashboard kholo →</a>
      </div>
    </div>
  );
}
