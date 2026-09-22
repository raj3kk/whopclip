import "./globals.css";

export const metadata = {
  title: "WhopClip — Whop Content Rewards Automation",
  description:
    "One-time login on your phone, then automatic clipping: join campaigns, edit vertical videos, post Reels, submit to Whop.",
};

function Nav() {
  return (
    <div className="wrap">
      <nav className="nav">
        <a href="/" className="brand" style={{ color: "var(--text)" }}>
          Whop<span>Clip</span>
        </a>
        <div className="navlinks">
          <a href="/connect">Connect App</a>
          <a href="/dashboard">Dashboard</a>
          <a href="/login" className="btn small" style={{ color: "#fff" }}>
            Login
          </a>
        </div>
      </nav>
    </div>
  );
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        {children}
        <div className="wrap">
          <div className="footer">
            WhopClip — your phone does the work, this site is the control plane.
          </div>
        </div>
      </body>
    </html>
  );
}
