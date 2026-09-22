"use client";

import { useEffect, useRef, useState } from "react";

export default function PairBox() {
  const [code, setCode] = useState<string | null>(null);
  const [expires, setExpires] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  async function generate() {
    setLoading(true);
    setClaimed(null);
    try {
      const res = await fetch("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "generate" }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "failed");
      setCode(j.code);
      setExpires(j.expires_at);
      stop();
      timer.current = setInterval(async () => {
        const s = await fetch(`/api/pair?code=${encodeURIComponent(j.code)}`);
        const sj = await s.json();
        if (sj.claimed) {
          setClaimed(sj.device_id);
          stop();
        }
      }, 3000);
    } catch (e) {
      alert(e instanceof Error ? e.message : "failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {!code && (
        <button className="btn" onClick={generate} disabled={loading}>
          {loading ? "Generating…" : "🔑 Generate pairing code"}
        </button>
      )}
      {code && !claimed && (
        <>
          <div className="code">{code}</div>
          <p className="muted" style={{ fontSize: 13 }}>
            App me ye code dalo… waiting for phone (expires{" "}
            {expires ? new Date(expires).toLocaleTimeString() : ""})
          </p>
          <button className="btn ghost small" onClick={generate}>Regenerate</button>
        </>
      )}
      {claimed && (
        <div className="alert ok">
          ✅ Phone linked! Device: <code>{claimed}</code>
          <div style={{ marginTop: 10 }}>
            <a href="/dashboard" className="btn green small">Dashboard →</a>
          </div>
        </div>
      )}
    </div>
  );
}
