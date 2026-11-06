import type { ActionId, JobSummary, PlayerErrorShape } from "@wasm-player/contracts";

export interface JobRecord {
  jobId: string;
  action: ActionId;
  status: "accepted" | "running" | "applied" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  progress?: { completed: number; total: number };
  result?: unknown;
  error?: PlayerErrorShape;
}

export interface JobLimits {
  /** Finished jobs kept in memory. */
  maxEntries: number;
  /** Total bytes of results kept in memory. */
  maxBytes: number;
  /** How long a finished job stays queryable. */
  ttlMs: number;
}

export function isFinishedJob(job: JobRecord): boolean {
  return job.status === "applied" || job.status === "failed" || job.status === "cancelled";
}

export function jobSummary(job: JobRecord): JobSummary {
  const summary: JobSummary = {
    jobId: job.jobId,
    action: job.action,
    status: job.status,
    updatedAt: job.updatedAt
  };
  if (job.progress) summary.progress = { ...job.progress };
  return summary;
}

/**
 * Captures and storyboards are the only unbounded results the controller keeps:
 * drop expired jobs, then evict the oldest finished ones while over the entry or
 * byte budget. Running jobs are never evicted mid-flight.
 */
export function pruneJobs(
  jobs: Map<string, JobRecord>,
  blobs: Map<string, Blob>,
  limits: JobLimits,
  now: number
): void {
  for (const [jobId, job] of jobs) {
    if (!isFinishedJob(job)) continue;
    if (now - job.updatedAt > limits.ttlMs) {
      jobs.delete(jobId);
      blobs.delete(jobId);
    }
  }
  let bytes = 0;
  for (const blob of blobs.values()) bytes += blob.size;
  const finished = [...jobs.values()]
    .filter(isFinishedJob)
    .sort((left, right) => left.updatedAt - right.updatedAt);
  for (const job of finished) {
    const overEntries = jobs.size > limits.maxEntries;
    const overBytes = bytes > limits.maxBytes;
    if (!overEntries && !overBytes) break;
    const blob = blobs.get(job.jobId);
    if (blob) {
      bytes -= blob.size;
      blobs.delete(job.jobId);
    }
    jobs.delete(job.jobId);
  }
}
