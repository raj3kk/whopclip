/**
 * Minimal in-memory store for v1 skeleton.
 * PRODUCTION NOTE: replace with a real DB (Vercel KV / Postgres) —
 * serverless instances do not share memory, so jobs/sessions would be
 * lost between invocations on Vercel. This is scaffolding only.
 */

export type ServiceName = "whop" | "instagram";

export interface DeviceSession {
  device_id: string;
  service: ServiceName;
  /** AES-256-GCM encrypted JSON of cookies */
  encrypted: string;
  user_agent: string;
  device_model: string;
  created_at: string;
  updated_at: string;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface Job {
  id: string;
  device_id: string;
  type: "ig_post" | "whop_submit" | "custom";
  status: JobStatus;
  steps: unknown[];
  result: unknown | null;
  created_at: string;
  updated_at: string;
}

declare global {
  // eslint-disable-next-line no-var
  var __whopclip_store:
    | { sessions: Map<string, DeviceSession>; jobs: Map<string, Job> }
    | undefined;
}

function store() {
  if (!global.__whopclip_store) {
    global.__whopclip_store = { sessions: new Map(), jobs: new Map() };
  }
  return global.__whopclip_store;
}

export function saveSession(s: DeviceSession) {
  store().sessions.set(`${s.device_id}:${s.service}`, s);
}

export function getSession(device_id: string, service: ServiceName) {
  return store().sessions.get(`${device_id}:${service}`) ?? null;
}

export function enqueueJob(job: Job) {
  store().jobs.set(job.id, job);
}

export function claimJob(device_id: string): Job | null {
  for (const job of store().jobs.values()) {
    if (job.device_id === device_id && job.status === "queued") {
      job.status = "running";
      job.updated_at = new Date().toISOString();
      return job;
    }
  }
  return null;
}

export function finishJob(id: string, status: JobStatus, result: unknown) {
  const job = store().jobs.get(id);
  if (!job) return null;
  job.status = status;
  job.result = result;
  job.updated_at = new Date().toISOString();
  return job;
}

export function listJobs(device_id: string): Job[] {
  return [...store().jobs.values()].filter((j) => j.device_id === device_id);
}
