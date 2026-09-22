export default function Home() {
  return (
    <div className="wrap">
      <section className="hero">
        <h1>
          Whop Content Rewards, <span>fully automatic</span>
        </h1>
        <p>
          Login once on your phone — Whop + Instagram. Phir automation khud
          campaign join karega, video edit karke Reel post karega, aur Whop pe
          submit karke earnings track karega.
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
          <a href="/login" className="btn">Get Started</a>
          <a href="/whopclip-v3.apk" className="btn ghost">Download App (APK)</a>
        </div>
      </section>

      <div className="grid cols3">
        <div className="card">
          <h3>📱 1. Connect</h3>
          <p className="muted">App install karo, ek pairing code se phone link karo, Whop + Instagram me ek baar login karo.</p>
        </div>
        <div className="card">
          <h3>🎯 2. Automate</h3>
          <p className="muted">Campaign select karo ya schedule set karo — phone khud join karega, 9:16 video banayega, Reel post karega.</p>
        </div>
        <div className="card">
          <h3>💰 3. Earn</h3>
          <p className="muted">Har submission Whop pe verify hoke submit hoti hai. Earnings dashboard me live track hoti hain.</p>
        </div>
      </div>

      <div className="card">
        <h2>Kaise kaam karta hai</h2>
        <div className="steps grid" style={{ marginTop: 16 }}>
          <div className="step"><div className="stepnum" /><div><b>Campaign scan</b><p className="muted">Active Content Rewards campaigns me se budget, payout rate aur eligibility check karke best campaign chunta hai. Duplicate submission kabhi nahi.</p></div></div>
          <div className="step"><div className="stepnum" /><div><b>Join + requirements</b><p className="muted">Campaign join karta hai, requirements padhta hai — duration, captions, hashtags, mentions sab parse hote hain.</p></div></div>
          <div className="step"><div className="stepnum" /><div><b>Edit 9:16</b><p className="muted">Source video download karke vertical 1080×1920 me edit hota hai — burned captions, hooks, safe-zone compliant.</p></div></div>
          <div className="step"><div className="stepnum" /><div><b>Post + verify</b><p className="muted">Instagram pe Reel post hota hai, live URL verify hota hai — tabhi Whop pe submit hota hai. Fail hua to fail-closed, retry safe.</p></div></div>
        </div>
      </div>

      <div className="card">
        <h2>Safety, by design</h2>
        <ul className="muted" style={{ lineHeight: 1.9 }}>
          <li>Sessions AES-256-GCM encrypted — server kabhi plain cookies nahi dekhta</li>
          <li>Har step verify hota hai — join confirm, Reel live check, submit confirm</li>
          <li>Duplicate submissions blocked — ek campaign, ek entry</li>
          <li>Session expire hua to phone pe dobara login ka prompt aata hai</li>
        </ul>
      </div>

      <section className="hero" style={{ paddingTop: 20 }}>
        <a href="/login" className="btn">Get Started →</a>
      </section>
    </div>
  );
}
