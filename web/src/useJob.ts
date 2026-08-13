/**
 * Job state, shared by every view.
 *
 * The job id is kept in localStorage so a page reload does not lose the run — the
 * workbook is expensive to regenerate, and losing it to an accidental refresh is the
 * kind of thing that makes a tool annoying to use.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type Health, type JobSummary } from './api.js';
import { useToast } from './ui.jsx';

const STORAGE_KEY = 'propco.jobId';

export interface JobState {
  job: JobSummary | null;
  health: Health | null;
  busy: string | null;
  /** Runs `fn` with a busy flag and toast-on-error. Returns undefined on failure. */
  guard: <T>(label: string, fn: () => Promise<T>, successTitle?: string) => Promise<T | undefined>;
  setJob: (job: JobSummary | null) => void;
  reload: () => Promise<void>;
  reset: () => void;
}

export function useJob(): JobState {
  const toast = useToast();
  const [job, setJobState] = useState<JobSummary | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const setJob = useCallback((next: JobSummary | null) => {
    setJobState(next);
    if (next) localStorage.setItem(STORAGE_KEY, next.id);
    else localStorage.removeItem(STORAGE_KEY);
  }, []);

  // Restore the last job on load, and read the server's capabilities.
  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    api
      .job(saved)
      .then(setJobState)
      .catch(() => localStorage.removeItem(STORAGE_KEY));
  }, []);

  const guard = useCallback(
    async <T,>(label: string, fn: () => Promise<T>, successTitle?: string) => {
      setBusy(label);
      try {
        const result = await fn();
        if (successTitle) toast({ kind: 'ok', title: successTitle });
        return result;
      } catch (error) {
        toast({
          kind: 'err',
          title: `${label} failed`,
          message: error instanceof Error ? error.message : String(error),
        });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [toast],
  );

  const reload = useCallback(async () => {
    if (!job) return;
    const fresh = await api.job(job.id).catch(() => null);
    if (fresh) setJobState(fresh);
  }, [job]);

  const reset = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    setJobState(null);
  }, []);

  return { job, health, busy, guard, setJob, reload, reset };
}
