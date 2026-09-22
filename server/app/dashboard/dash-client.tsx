"use client";

import { useCallback, useEffect, useState } from "react";

type Device = {
  device_id: string; paired_at: string; last_poll_at: string | null;
  online: boolean; app_version: string | null; device_model: string | null;
  schedule: { enabled: boolean; time: string; timezone: string; last_run_date: string | null };
};
type Campaign = {
  id: string; name: string; whop_url: string; active: boolean;
  budget_remaining: number; payout_per_1k: number; joined: boolean;
  requirements: {
    video_max_duration_s: number | null; captions_required: boolean;
    caption_template: string | null; required_mentions: string[];
    required_hashtags: string[]; posting_rules: string[]; payout_per_1k: number;
  } | null;
  updated_at: string;
};
type Job = {
  id: string; type: string; status: string; steps: unknown[];
  result: unknown; created_at: string; updated_at: string;
};
type Submission = {
  id: string; campaign_name: string; ig_post_url: string; status: string;
  payout_per_1k: number; views: number | null; earned_usd: number | null; created_at: string;
};

async function jget(url: string) {
  const r = await fetch(url);
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}
async function jpost(url: string, body: unknown) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function Dashboard() {
  const [devices, setDevices] = useState<Device[]>([]);
  const [deviceId, setDeviceId] = useState<string>("");
  const [tab, setTab] = useState("campaigns");
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [campaignsErr, setCampaignsErr] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [subs, setSubs] = useState<Submission[]>([]);
  const [earned, setEarned] = useState(0);
  const [pending, setPending] = useState(0);
  const [sessions, setSessions] = useState<Record<string, { linked: boolean; stale: boolean }> | null>(null);
  const [schedTime, setSchedTime] = useState("09:00");
  const [schedOn, setSchedOn] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [runStep, setRunStep] = useState<Record<string, string>>({});
  const [caption, setCaption] = useState<Record<string, string>>({});
  const [videoUrl, setVideoUrl] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const d = await jget("/api/devices");
    if (!d.ok) { if (d.status === 401) location.href = "/login"; return; }
    const devs: Device[] = d.j.devices ?? [];
    setDevices(devs);
    let sel = localStorage.getItem("whopclip_device") || "";
    if (!sel || !devs.find((x) => x.device_id === sel)) sel = devs[0]?.device_id ?? "";
    setDeviceId(sel);
    if (sel) localStorage.setItem("whopclip_device", sel);
    const dev = devs.find((x) => x.device_id === sel);
    if (dev) { setSchedTime(dev.schedule.time); setSchedOn(dev.schedule.enabled); }
    if (!sel) return;
    const [c, jb, e, s] = await Promise.all([
      jget(`/api/campaigns?device_id=${encodeURIComponent(sel)}`),
      jget(`/api/jobs?device_id=${encodeURIComponent(sel)}`),
      jget(`/api/earnings?device_id=${encodeURIComponent(sel)}`),
      jget(`/api/sessions/status?device_id=${encodeURIComponent(sel)}`),
    ]);
    if (c.ok) { setCampaigns(c.j.campaigns); setCampaignsErr(null); }
    else { setCampaigns(null); setCampaignsErr(c.j.error || `HTTP ${c.status}`); }
    if (jb.ok) setJobs(jb.j.jobs ?? []);
    if (e.ok) { setSubs(e.j.submissions ?? []); setEarned(e.j.total_earned_usd ?? 0); setPending(e.j.pending_count ?? 0); }
    if (s.ok) setSessions(s.j.services);
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function runNow(c: Campaign) {
    const step = runStep[c.id] || "full";
    const body: Record<string, unknown> = { device_id: deviceId, step, campaign_id: c.id };
    if (step === "post") {
      body.caption = caption[c.id] || c.requirements?.caption_template || "";
      body.video_url = videoUrl[c.id] || "";
    }
    if (step === "submit") {
      const lastPost = jobs.find((j) => j.type === "ig_post" && j.status === "done");
      const r = (lastPost?.result ?? {}) as Record<string, unknown>;
      body.ig_post_url = typeof r.post_url === "string" ? r.post_url : "";
    }
    setBusy(c.id);
    const r = await jpost("/api/run", body);
    setBusy(null);
    if (!r.ok) alert("Run failed: " + (r.j.error || r.status));
    else { setTab("jobs"); load(); }
  }

  async function saveSchedule() {
    const r = await jpost("/api/schedule", { device_id: deviceId, enabled: schedOn, time: schedTime, timezone: "Asia/Calcutta" });
    if (!r.ok) alert("Schedule save failed: " + (r.j.error || r.status));
    else load();
  }

  async function logout() {
    await fetch("/api/auth", { method: "DELETE" });
    location.href = "/login";
  }

  const dev = devices.find((x) => x.device_id === deviceId);

  return (
    <div className="wrap">
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 20, flexWrap: "wrap" }}>
        <h1 style={{ margin: 0, flex: 1 }}>Dashboard</h1>
        <select
          value={deviceId}
          onChange={(e) => { setDeviceId(e.target.value); localStorage.setItem("whopclip_device", e.target.value); }}
          style={{ width: "auto", minWidth: 200 }}
        >
          {devices.map((d) => (
            <option key={d.device_id} value={d.device_id}>
              {d.online ? "🟢 " : "🔴 "}{d.device_id.slice(0, 12)}…
            </option>
          ))}
        </select>
        <button className="btn ghost small" onClick={load}>↻</button>
        <button className="btn ghost small" onClick={logout}>Logout</button>
      </div>

      {devices.length === 0 && (
        <div className="alert warn">
          Koi phone linked nahi hai. <a href="/connect">/connect</a> pe jake app pair karo.
        </div>
      )}

      {dev && (
        <div className="card" style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <span><span className={`dot ${dev.online ? "on" : "off"}`} />{dev.online ? "Phone online" : "Phone offline"}</span>
          <span className="muted">last poll: {timeAgo(dev.last_poll_at)}</span>
          {dev.device_model && <span className="muted">{dev.device_model}</span>}
          {dev.app_version && <span className="muted">v{dev.app_version}</span>}
          {sessions && (
            <span>
              <span className={`badge ${sessions.whop?.linked && !sessions.whop?.stale ? "green" : "red"}`}>Whop {sessions.whop?.linked ? (sessions.whop.stale ? "stale" : "linked") : "not linked"}</span>
              <span className={`badge ${sessions.instagram?.linked && !sessions.instagram?.stale ? "green" : "red"}`}>IG {sessions.instagram?.linked ? (sessions.instagram.stale ? "stale" : "linked") : "not linked"}</span>
            </span>
          )}
        </div>
      )}

      <div className="tabs">
        {(["campaigns", "jobs", "earnings", "phone"] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "campaigns" ? "🎯 Campaigns" : t === "jobs" ? `⚙️ Jobs (${jobs.filter((j) => j.status === "queued" || j.status === "running").length})` : t === "earnings" ? `💰 Earnings ($${earned.toFixed(2)})` : "📱 Phone"}
          </button>
        ))}
      </div>

      {tab === "campaigns" && (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>⏰ Daily schedule</h3>
            <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
              <div>
                <label>Time (IST)</label>
                <input type="time" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} style={{ width: 130 }} />
              </div>
              <label style={{ display: "flex", gap: 8, alignItems: "center", margin: 0 }}>
                <input type="checkbox" checked={schedOn} onChange={(e) => setSchedOn(e.target.checked)} style={{ width: "auto" }} />
                Enabled
              </label>
              <button className="btn small green" onClick={saveSchedule}>Save</button>
              {dev?.schedule.last_run_date && <span className="muted">last run: {dev.schedule.last_run_date}</span>}
            </div>
            <p className="muted" style={{ fontSize: 13 }}>Schedule pe phone khud best campaign ka check run shuru karega (ek baar roz).</p>
          </div>

          {campaignsErr && <div className="alert warn">Campaigns: {campaignsErr} — phone me Whop login karo.</div>}
          {campaigns?.length === 0 && <div className="card muted">Koi campaign nahi mili. Phone se check job chalao — wo Whop se campaigns discover karega.</div>}
          {(campaigns ?? []).map((c) => (
            <div className="card" key={c.id}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <b style={{ fontSize: 17, flex: 1 }}>{c.name}</b>
                <span className={`badge ${c.joined ? "green" : "yellow"}`}>{c.joined ? "Joined" : "Not joined"}</span>
                <span className={`badge ${c.active ? "blue" : "grey"}`}>{c.active ? "Active" : "Inactive"}</span>
              </div>
              <div className="muted" style={{ fontSize: 14, margin: "8px 0" }}>
                💵 ${c.payout_per_1k}/1k views · Budget left: ${c.budget_remaining}
                {c.requirements?.video_max_duration_s ? ` · ≤${c.requirements.video_max_duration_s}s` : ""} · 9:16
                {c.requirements?.required_hashtags?.length ? ` · ${c.requirements.required_hashtags.join(" ")}` : ""}
              </div>
              {c.requirements?.caption_template && (
                <details><summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Caption template</summary><pre className="logs">{c.requirements.caption_template}</pre></details>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
                <select value={runStep[c.id] || "full"} onChange={(e) => setRunStep({ ...runStep, [c.id]: e.target.value })} style={{ width: "auto" }}>
                  <option value="full">Full (check first)</option>
                  <option value="check">Check join</option>
                  <option value="join">Join</option>
                  <option value="post">Post Reel</option>
                  <option value="submit">Submit to Whop</option>
                </select>
                <button className="btn small green" disabled={busy === c.id || !dev?.online} onClick={() => runNow(c)}>
                  {busy === c.id ? "…" : "▶ Run Now"}
                </button>
                <a className="btn small ghost" href={c.whop_url} target="_blank" rel="noreferrer">Whop ↗</a>
              </div>
              {(runStep[c.id] || "full") === "post" && (
                <div style={{ marginTop: 10 }}>
                  <label>Video URL (server-rendered ya uploaded clip)</label>
                  <input value={videoUrl[c.id] || ""} onChange={(e) => setVideoUrl({ ...videoUrl, [c.id]: e.target.value })} placeholder="https://…" />
                  <label>Caption (exact)</label>
                  <textarea rows={3} value={caption[c.id] ?? c.requirements?.caption_template ?? ""} onChange={(e) => setCaption({ ...caption, [c.id]: e.target.value })} />
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {tab === "jobs" && (
        <>
          {jobs.length === 0 && <div className="card muted">Koi job nahi — Campaigns tab se "Run Now" dabao.</div>}
          {jobs.map((j) => (
            <details className="job" key={j.id}>
              <summary>
                <span className={`badge ${j.status === "done" ? "green" : j.status === "failed" ? "red" : j.status === "running" ? "blue" : "grey"}`}>{j.status}</span>
                <b>{j.type}</b>
                <span className="muted">{j.steps.length} steps · {timeAgo(j.updated_at)}</span>
              </summary>
              <div className="body">
                <div className="muted" style={{ fontSize: 12 }}>id: <code>{j.id}</code></div>
                <pre className="logs">{JSON.stringify(j.result ?? { steps: j.steps.length, note: "no result yet" }, null, 2)}</pre>
              </div>
            </details>
          ))}
        </>
      )}

      {tab === "earnings" && (
        <>
          <div className="grid cols3">
            <div className="card"><div className="muted">Total earned</div><div style={{ fontSize: 30, fontWeight: 800, color: "var(--accent2)" }}>${earned.toFixed(2)}</div></div>
            <div className="card"><div className="muted">Pending review</div><div style={{ fontSize: 30, fontWeight: 800 }}>{pending}</div></div>
            <div className="card"><div className="muted">Submissions</div><div style={{ fontSize: 30, fontWeight: 800 }}>{subs.length}</div></div>
          </div>
          <div className="card" style={{ overflowX: "auto" }}>
            <table>
              <thead><tr><th>Campaign</th><th>Reel</th><th>Status</th><th>$/1k</th><th>Views</th><th>Earned</th></tr></thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}>
                    <td>{s.campaign_name}</td>
                    <td>{s.ig_post_url ? <a href={s.ig_post_url} target="_blank" rel="noreferrer">open ↗</a> : "—"}</td>
                    <td><span className={`badge ${s.status === "approved" ? "green" : s.status === "rejected" ? "red" : "yellow"}`}>{s.status}</span></td>
                    <td>${s.payout_per_1k}</td>
                    <td>{s.views ?? "—"}</td>
                    <td>{s.earned_usd != null ? `$${s.earned_usd.toFixed(2)}` : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {subs.length === 0 && <p className="muted">Abhi koi submission nahi.</p>}
          </div>
        </>
      )}

      {tab === "phone" && (
        <>
          {devices.map((d) => (
            <div className="card" key={d.device_id}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span><span className={`dot ${d.online ? "on" : "off"}`} /><code>{d.device_id}</code></span>
                <span className={`badge ${d.online ? "green" : "red"}`}>{d.online ? "online" : "offline"}</span>
              </div>
              <div className="muted" style={{ fontSize: 14, marginTop: 8, lineHeight: 2 }}>
                Paired: {new Date(d.paired_at).toLocaleString()}<br />
                Last poll: {timeAgo(d.last_poll_at)}<br />
                {d.device_model && <>Model: {d.device_model}<br /></>}
                {d.app_version && <>App: v{d.app_version}<br /></>}
                Schedule: {d.schedule.enabled ? `daily ${d.schedule.time} IST` : "off"}
                {d.schedule.last_run_date ? ` (last run ${d.schedule.last_run_date})` : ""}
              </div>
            </div>
          ))}
          {devices.length === 0 && <div className="card muted">Koi device nahi — <a href="/connect">connect karo</a>.</div>}
        </>
      )}
    </div>
  );
}
