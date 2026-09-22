export default function Home() {
  return (
    <main style={{ padding: 32, fontFamily: "system-ui, sans-serif", maxWidth: 720 }}>
      <h1>WhopClip server</h1>
      <p>Content Rewards clipping automation — control plane.</p>
      <h2>API</h2>
      <ul>
        <li><code>POST /api/sessions</code> — phone uploads Whop/Instagram login sessions (encrypted)</li>
        <li><code>GET /api/campaigns?device_id=…</code> — campaign state for a device</li>
        <li><code>GET /api/jobs/next?device_id=…</code> — phone claims next job (204 = empty)</li>
        <li><code>POST /api/jobs/enqueue</code> — orchestrator enqueues a job</li>
        <li><code>POST /api/jobs/:id</code> — phone reports done/failed + result</li>
        <li><code>GET /api/jobs?device_id=…</code> — list jobs (monitor)</li>
      </ul>
      <p style={{ color: "#666" }}>
        v1 skeleton. Sessions are AES-256-GCM encrypted with <code>SESSION_MASTER_KEY</code>.
        The in-memory store is scaffolding — use Vercel KV/Postgres before production.
      </p>
    </main>
  );
}
