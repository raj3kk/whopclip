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
  current_step?: string | null; last_heartbeat?: string | null;
  heartbeat_count?: number; cancel_requested?: boolean;
};
type ActivityEvent = {
  id: string; kind: string; message: string;
  job_id?: string; job_type?: string; created_at: string;
};
type LiveData = {
  live: {
    device_id: string; job_id: string; job_type: string;
    current_step: string; frame_url: string; updated_at: string;
  } | null;
  activity: ActivityEvent[];
  running_job: {
    id: string; type: string; current_step: string | null;
    heartbeat_count: number; last_heartbeat: string | null;
    steps_total: number; updated_at: string;
  } | null;
};
type Submission = {
  id: string; campaign_name: string; ig_post_url: string; status: string;
  payout_per_1k: number; views: number | null; earned_usd: number | null; created_at: string;
};
type ChainInfo = {
  id: string; campaign_id: string; campaign_name: string; stage: string;
  status: string; attempts: number; error: string | null;
  ig_post_url: string | null; updated_at: string; created_at: string;
};
const CHAIN_STAGES = ["check", "join", "render", "post", "verify", "submit", "done"];

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
  const [chains, setChains] = useState<ChainInfo[]>([]);
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
  const [coverUrl, setCoverUrl] = useState<Record<string, string>>({});
  const [live, setLive] = useState<LiveData | null>(null);
  const [autoQuery, setAutoQuery] = useState("instagram");
  const [autoResult, setAutoResult] = useState<{
    query: string; hits_seen: number; started_chain_id: string | null; dry_run: boolean;
    ranked: Array<{ id: string; name: string; score: number; excluded: boolean; excludeReason: string | null; rationale: string[]; rate_per_1k: number; budget_remaining: number; requiresApplication: boolean; joined: boolean; video_assets: number }>;
    picked: { id: string; name: string; score: number; rationale: string[] } | null;
    brief: { campaign_name: string; rate_per_1k: number; budget_remaining: number; caption_rules: string; title_templates: string[]; video_specs: string[]; dos_donts: string[]; assets: Array<{ name: string; url: string }>; creator_requirements: string } | null;
  } | null>(null);

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
    const [c, jb, e, s, ch] = await Promise.all([
      jget(`/api/campaigns?device_id=${encodeURIComponent(sel)}`),
      jget(`/api/jobs?device_id=${encodeURIComponent(sel)}`),
      jget(`/api/earnings?device_id=${encodeURIComponent(sel)}`),
      jget(`/api/sessions/status?device_id=${encodeURIComponent(sel)}`),
      jget(`/api/chains?device_id=${encodeURIComponent(sel)}`),
    ]);
    if (ch.ok) setChains(ch.j.chains ?? []);
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

  // Live tab: poll the phone's live frame + running job every 5s.
  useEffect(() => {
    if (tab !== "live" || !deviceId) return;
    let stop = false;
    const fetchLive = async () => {
      const r = await jget(`/api/live?device_id=${encodeURIComponent(deviceId)}`);
      if (!stop && r.ok) setLive(r.j as LiveData);
    };
    fetchLive();
    const t = setInterval(fetchLive, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [tab, deviceId]);

  async function runNow(c: Campaign) {
    const step = runStep[c.id] || "full";
    const body: Record<string, unknown> = { device_id: deviceId, step, campaign_id: c.id };
    if (step === "post") {
      body.caption = caption[c.id] || c.requirements?.caption_template || "";
      body.video_url = videoUrl[c.id] || "";
      body.cover_url = coverUrl[c.id] || "";
    }
    if (step === "submit") {
      const lastPost = jobs.find((j) => (j.type === "ig_post" || j.type === "server_post") && j.status === "done");
      const r = (lastPost?.result ?? {}) as Record<string, unknown>;
      body.ig_post_url = typeof r.post_url === "string" ? r.post_url : "";
    }
    setBusy(c.id);
    const r = await jpost("/api/run", body);
    setBusy(null);
    if (!r.ok) alert("Run failed: " + (r.j.error || r.status));
    else if ((r.j as { server_side?: boolean }).server_side) {
      const sr = (r.j as { server_result?: { verify_result?: { live?: boolean; checks?: Array<{ name: string; ok: boolean; detail: string }> } } }).server_result;
      const vr = sr?.verify_result;
      if (vr) {
        const lines = (vr.checks ?? []).map((c) => `${c.ok ? "✅" : "❌"} ${c.name}: ${c.detail}`).join("\n");
        alert(`Server verify: reel ${vr.live ? "LIVE hai" : "LIVE NAHI hai"}\n\n${lines}`);
      } else {
        alert("Server pe ho gaya: " + JSON.stringify(sr ?? {}).slice(0, 300));
      }
      load();
    }
    else { setTab("jobs"); load(); }
  }

  async function saveSchedule() {
    const r = await jpost("/api/schedule", { device_id: deviceId, enabled: schedOn, time: schedTime, timezone: "Asia/Calcutta" });
    if (!r.ok) alert("Schedule save failed: " + (r.j.error || r.status));
    else load();
  }

  async function discoverNow() {
    setBusy("discover");
    const r = await jpost("/api/whop/discover", { device_id: deviceId });
    setBusy(null);
    if (!r.ok) alert("Discover failed: " + (r.j.error || r.status));
    else {
      const sr = r.j as { count?: number; added?: number };
      alert(`Server discover: ${sr.count ?? 0} campaigns (${sr.added ?? 0} naye) — store me save ho gaye`);
      load();
    }
  }

  async function serverCheck(c: Campaign) {
    setBusy("check-" + c.id);
    const r = await fetch(`/api/whop/campaigns/${c.id}?device_id=${encodeURIComponent(deviceId)}`);
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) alert("Server check failed: " + (j.error || r.status));
    else {
      const cc = (j as { campaign?: { name?: string; joined?: boolean; budget_remaining?: number } }).campaign ?? {};
      alert(`${cc.name ?? c.name}: joined=${cc.joined ? "haan" : "nahi"}, budget $${cc.budget_remaining ?? "?"}`);
      load();
    }
  }

  async function pumpChains() {
    setBusy("pump");
    const r = await jget(`/api/chains/advance?device_id=${encodeURIComponent(deviceId)}`);
    setBusy(null);
    if (!r.ok) alert("Pump failed: " + (r.j.error || r.status));
    else {
      const list = (r.j.chains ?? []) as ChainInfo[];
      const summ = list.map((c) => `${c.campaign_name}: ${c.stage} (${c.status})`).join("\n") || "koi active chain nahi";
      alert(`⛓️ Chains pumped:\n${summ}`);
      load();
    }
  }

  async function autoDiscover(dryRun: boolean) {
    if (!dryRun && !confirm("Top-scored campaign pe REAL chain start hogi (check → join → render → post → verify → submit). Pakka?")) return;
    setBusy(dryRun ? "auto-dry" : "auto-run");
    const r = await jpost("/api/automation/discover", { device_id: deviceId, query: autoQuery, dry_run: dryRun });
    setBusy(null);
    if (!r.ok) { alert("Auto-discover failed: " + (r.j.error || r.status)); return; }
    setAutoResult(r.j as NonNullable<typeof autoResult>);
    if (!dryRun) {
      const sid = (r.j as { started_chain_id?: string | null }).started_chain_id;
      alert(sid ? `🤖 Chain start ho gayi: ${sid} — Chains tab me dekho` : "Koi eligible campaign nahi mili — ranked table dekho");
      load();
    }
  }

  async function retryJob(id: string) {
    setBusy(id);
    const r = await jpost(`/api/jobs/${id}/retry`, {});
    setBusy(null);
    if (!r.ok) alert("Retry failed: " + (r.j.error || r.status));
    else load();
  }

  async function requeueStuck() {
    setBusy("stuck");
    const r = await jpost("/api/jobs/requeue-stuck", { device_id: deviceId });
    setBusy(null);
    if (!r.ok) alert("Requeue failed: " + (r.j.error || r.status));
    else { alert(`Requeued: ${r.j.requeued?.length ?? 0} job(s)`); load(); }
  }

  async function cancelJob(id: string, status: string) {
    const msg = status === "running"
      ? "Ye job abhi phone pe CHAL raha hai. Cancel bhejun? Phone agle heartbeat pe rokega."
      : "Ye queued job cancel kar dun? Phone ise uthayega nahi.";
    if (!confirm(msg)) return;
    setBusy(id);
    const r = await jpost(`/api/jobs/${id}/cancel`, {});
    setBusy(null);
    if (!r.ok) alert("Cancel failed: " + (r.j.error || r.status));
    else load();
  }

  function statusBadge(s: string) {
    const cls = s === "done" ? "green" : s === "failed" ? "red" : s === "running" ? "blue" : s === "cancelled" ? "grey" : "grey";
    return <span className={`badge ${cls}`}>{s}</span>;
  }

  function jobRow(j: Job) {
    const cancellable = j.status === "queued" || j.status === "running";
    return (
      <details className="job" key={j.id}>
        <summary>
          {statusBadge(j.status)}
          <b>{j.type}</b>
          <span className="muted">{j.steps.length} steps · {timeAgo(j.updated_at)}</span>
          {j.cancel_requested && j.status === "running" && (
            <span className="badge yellow">cancel requested ⏳</span>
          )}
          {j.status === "failed" && (
            <button
              className="btn small green"
              disabled={busy === j.id}
              onClick={(e) => { e.preventDefault(); retryJob(j.id); }}
            >
              {busy === j.id ? "…" : "↻ Retry"}
            </button>
          )}
          {cancellable && !j.cancel_requested && (
            <button
              className="btn small ghost"
              disabled={busy === j.id}
              onClick={(e) => { e.preventDefault(); cancelJob(j.id, j.status); }}
            >
              {busy === j.id ? "…" : "✕ Cancel"}
            </button>
          )}
        </summary>
        <div className="body">
          {j.current_step && <div style={{ fontSize: 13, marginBottom: 6 }}>📍 {j.current_step}</div>}
          <div className="muted" style={{ fontSize: 12 }}>id: <code>{j.id}</code></div>
          <pre className="logs">{JSON.stringify(j.result ?? { steps: j.steps.length, note: "no result yet" }, null, 2)}</pre>
        </div>
      </details>
    );
  }

  const sortedJobs = [...jobs].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));

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
        {(["campaigns", "chains", "live", "jobs", "earnings", "phone"] as const).map((t) => (
          <button key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "campaigns" ? "🎯 Campaigns" : t === "chains" ? `⛓️ Chains (${chains.length})` : t === "live" ? "🔴 Live" : t === "jobs" ? `⚙️ Jobs (${jobs.filter((j) => j.status === "queued" || j.status === "running").length})` : t === "earnings" ? `💰 Earnings ($${earned.toFixed(2)})` : "📱 Phone"}
          </button>
        ))}
      </div>

      {tab === "campaigns" && (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>🔍 Server Discover (USA server se)</h3>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
              <button className="btn small green" disabled={busy === "discover"} onClick={discoverNow}>
                {busy === "discover" ? "…" : "⚡ Server Discover"}
              </button>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              Phone ke WebView ki zaroorat nahi — Vercel (USA) server khud Whop se campaign
              cards nikaal ke yahan save karega. Phone offline ho tab bhi chalega.
            </p>
          </div>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>🤖 Auto pipeline — search → score → select</h3>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "end" }}>
              <div>
                <label>Search keyword</label>
                <input value={autoQuery} onChange={(e) => setAutoQuery(e.target.value)} style={{ width: 180 }} placeholder="instagram" />
              </div>
              <button className="btn small green" disabled={busy === "auto-dry"} onClick={() => autoDiscover(true)}>
                {busy === "auto-dry" ? "…" : "🔎 Discover + score (dry run)"}
              </button>
              <button className="btn small" disabled={busy === "auto-run"} onClick={() => autoDiscover(false)} style={{ background: "#b3541e", color: "#fff" }}>
                {busy === "auto-run" ? "…" : "▶ Auto-run top pick"}
              </button>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>
              App ke search box jaisa: keyword search → pages scroll → har campaign ka score + reason →
              top pick. Dry run me kuch start nahi hota. Auto-run ek chain start karta hai
              (sare fail-closed gates ke saath).
            </p>
          </div>
          {autoResult && (
            <div className="card">
              <h3 style={{ marginTop: 0 }}>
                📊 Auto-discover result <span className="muted" style={{ fontSize: 13 }}>“{autoResult.query}” · {autoResult.hits_seen} campaigns dekhe{autoResult.dry_run ? " · dry run" : ""}</span>
              </h3>
              {autoResult.picked && (
                <div className="alert" style={{ borderLeft: "4px solid #2e7d32", padding: 10, marginBottom: 12 }}>
                  <b>🏆 Pick: {autoResult.picked.name}</b> <span className="badge green">score {autoResult.picked.score.toFixed(3)}</span>
                  {autoResult.started_chain_id && <div className="muted" style={{ fontSize: 12 }}>chain: <code>{autoResult.started_chain_id}</code></div>}
                </div>
              )}
              {!autoResult.picked && <div className="alert warn">Koi eligible campaign nahi — sab excluded (neeche reason dekho).</div>}
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", fontSize: 13, borderCollapse: "collapse" }}>
                  <thead><tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
                    <th>Campaign</th><th>Score</th><th>$/1k</th><th>Budget</th><th>Assets</th><th>Status</th>
                  </tr></thead>
                  <tbody>
                    {autoResult.ranked.map((r) => (
                      <tr key={r.id} style={{ borderBottom: "1px solid #eee", opacity: r.excluded ? 0.65 : 1 }}>
                        <td><b>{r.name}</b>{r.joined && <span className="badge green" style={{ marginLeft: 6 }}>joined</span>}{r.requiresApplication && <span className="badge yellow" style={{ marginLeft: 6 }}>application</span>}</td>
                        <td>{r.excluded ? "—" : r.score.toFixed(3)}</td>
                        <td>${r.rate_per_1k.toFixed(2)}</td>
                        <td>${r.budget_remaining.toFixed(0)}</td>
                        <td>{r.video_assets}🎬</td>
                        <td style={{ fontSize: 12 }}>{r.excluded ? `❌ ${r.excludeReason}` : "✅ eligible"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {autoResult.picked && (
                <details style={{ marginTop: 10 }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>Score rationale — {autoResult.picked.name}</summary>
                  <pre className="logs">{autoResult.picked.rationale.join("\n")}</pre>
                </details>
              )}
              {autoResult.brief && (
                <details style={{ marginTop: 10 }}>
                  <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>📋 Extracted requirements — Content / Creator / Reference</summary>
                  <pre className="logs">{JSON.stringify(autoResult.brief, null, 2)}</pre>
                </details>
              )}
            </div>
          )}
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
          {campaigns?.length === 0 && <div className="card muted">Koi campaign nahi mili. Upar "⚡ Server Discover" dabao — server khud Whop se campaigns laayega.</div>}
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
                <button className="btn small green" disabled={busy === c.id} onClick={() => runNow(c)}>
                  {busy === c.id ? "…" : "▶ Run Now"}
                </button>
                <button className="btn small ghost" disabled={busy === "check-" + c.id} onClick={() => serverCheck(c)}>
                  {busy === "check-" + c.id ? "…" : "⚡ Server check"}
                </button>
                <a className="btn small ghost" href={c.whop_url} target="_blank" rel="noreferrer">Whop ↗</a>
              </div>
              {(runStep[c.id] || "full") === "post" && (
                <div style={{ marginTop: 10 }}>
                  <label>Video URL (server-rendered ya uploaded clip)</label>
                  <input value={videoUrl[c.id] || ""} onChange={(e) => setVideoUrl({ ...videoUrl, [c.id]: e.target.value })} placeholder="https://…" />
                  <label>Cover URL (real frame — required, no placeholder)</label>
                  <input value={coverUrl[c.id] || ""} onChange={(e) => setCoverUrl({ ...coverUrl, [c.id]: e.target.value })} placeholder="https://…/cover.jpg" />
                  <label>Caption (exact)</label>
                  <textarea rows={3} value={caption[c.id] ?? c.requirements?.caption_template ?? ""} onChange={(e) => setCaption({ ...caption, [c.id]: e.target.value })} />
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {tab === "chains" && (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>⛓️ Server-side chains</h3>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn small green" disabled={busy === "pump"} onClick={pumpChains}>
                {busy === "pump" ? "…" : "▶ Pump chains now"}
              </button>
              <span className="muted" style={{ fontSize: 13 }}>
                Sab stages server (USA) pe chalte hain — check → join → render → post → verify → submit.
                Phone ka poll har 15 min me auto-pump karta hai.
              </span>
            </div>
          </div>
          {chains.length === 0 && (
            <div className="card muted">Koi active chain nahi. Campaigns tab se “▶ Run Now” (Full) dabao.</div>
          )}
          {chains.map((ch) => {
            const stageIdx = CHAIN_STAGES.indexOf(ch.stage);
            return (
              <div className="card" key={ch.id}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <b style={{ fontSize: 16, flex: 1 }}>{ch.campaign_name}</b>
                  <span className={`badge ${ch.status === "failed" ? "red" : ch.status === "done" ? "green" : "blue"}`}>{ch.status}</span>
                  {ch.attempts > 0 && <span className="badge yellow">attempt {ch.attempts}/3</span>}
                </div>
                <div style={{ display: "flex", gap: 4, margin: "12px 0", flexWrap: "wrap" }}>
                  {CHAIN_STAGES.map((s, i) => (
                    <span
                      key={s}
                      className={`badge ${i < stageIdx ? "green" : i === stageIdx ? (ch.status === "failed" ? "red" : "blue") : "grey"}`}
                      style={{ fontSize: 11 }}
                    >
                      {i < stageIdx ? "✓ " : ""}{s}
                    </span>
                  ))}
                </div>
                {ch.error && <div className="alert warn" style={{ fontSize: 13 }}>⚠️ {ch.error}</div>}
                {ch.ig_post_url && (
                  <div style={{ fontSize: 13, marginTop: 6 }}>
                    📸 <a href={ch.ig_post_url} target="_blank" rel="noreferrer">{ch.ig_post_url}</a>
                  </div>
                )}
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  updated {timeAgo(ch.updated_at)} · id <code>{ch.id.slice(0, 8)}</code>
                </div>
              </div>
            );
          })}
        </>
      )}

      {tab === "live" && (
        <>
          <div className="card">
            <h3 style={{ marginTop: 0 }}>🔴 Live — phone abhi kya kar raha hai</h3>
            {!live ? (
              <p className="muted">Loading…</p>
            ) : !live.live ? (
              <p className="muted">
                Abhi koi live frame nahi. Phone jab job chalayega to har step pe uski screen
                yahan dikhegi (auto-refresh 5s).
              </p>
            ) : (
              <>
                <img
                  key={live.live.updated_at}
                  src={live.live.frame_url}
                  alt="phone live screen"
                  style={{ width: "100%", maxWidth: 340, borderRadius: 12, border: "1px solid #333" }}
                />
                <div style={{ marginTop: 10, fontSize: 14 }}>
                  <b>{live.live.job_type || live.running_job?.type || "job"}</b>
                  <div style={{ marginTop: 4 }}>📍 {live.live.current_step || live.running_job?.current_step || "…"}</div>
                  <div className="muted" style={{ marginTop: 4 }}>
                    frame: {timeAgo(live.live.updated_at)}
                    {(Date.now() - new Date(live.live.updated_at).getTime() > 120000) && " ⚠️ stale — phone ka heartbeat ruka lagta hai"}
                  </div>
                </div>
              </>
            )}
            {live?.running_job && (
              <div className="muted" style={{ marginTop: 10, fontSize: 13 }}>
                running job: <code>{live.running_job.id.slice(0, 8)}</code> · {live.running_job.steps_total} steps ·
                heartbeat #{live.running_job.heartbeat_count}
                {live.running_job.last_heartbeat ? ` · last ${timeAgo(live.running_job.last_heartbeat)}` : " · heartbeat abhi tak nahi"}
              </div>
            )}
          </div>
          <h3 style={{ marginTop: 18 }}>📜 History</h3>
          {sortedJobs.length === 0 && <div className="card muted">Abhi tak koi job history nahi.</div>}
          {sortedJobs.slice(0, 30).map(jobRow)}
          <h3 style={{ marginTop: 18 }}>⚡ Activity</h3>
          {(!live?.activity || live.activity.length === 0) && (
            <div className="card muted">Abhi tak koi activity nahi — job events yahan dikhenge.</div>
          )}
          {(live?.activity ?? []).map((a) => (
            <div className="card" key={a.id} style={{ padding: "10px 14px", marginBottom: 8 }}>
              <div style={{ fontSize: 14 }}>{a.message}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                {a.job_type ? `${a.job_type} · ` : ""}{timeAgo(a.created_at)}
              </div>
            </div>
          ))}
        </>
      )}

      {tab === "jobs" && (
        <>
          {jobs.length === 0 && <div className="card muted">Koi job nahi — Campaigns tab se "Run Now" dabao.</div>}
          {sortedJobs.map(jobRow)}
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
          <div className="card">
            <h3 style={{ marginTop: 0 }}>🧹 Stuck-job recovery</h3>
            <p className="muted" style={{ fontSize: 13 }}>
              "running" job jiska heartbeat 10 minute se zyada purana hai, use dobara queue me daalo.
            </p>
            <button className="btn small ghost" disabled={busy === "stuck"} onClick={requeueStuck}>
              {busy === "stuck" ? "…" : "🧹 Stuck jobs requeue karo"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
