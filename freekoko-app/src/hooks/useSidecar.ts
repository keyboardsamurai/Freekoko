import { useCallback, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useLogsStore } from '../store/useLogsStore';
import {
  onLogLine,
  onServerStatus,
  recentLogs,
  restartServer,
  serverStatus,
  startServer,
  stopServer,
} from '../lib/ipc';
import type { ServerStatus } from '../lib/types';

export function useSidecar() {
  const status = useAppStore((s) => s.status);
  const setStatus = useAppStore((s) => s.setStatus);
  const appendLog = useLogsStore((s) => s.append);
  const replaceLogs = useLogsStore((s) => s.replace);

  useEffect(() => {
    let alive = true;

    // Initial hydrate: pull current status + recent logs.
    serverStatus()
      .then((s: ServerStatus) => {
        if (alive) setStatus(s);
      })
      .catch(() => {
        /* ignore — will catch up on first on:server-status event */
      });

    recentLogs(500)
      .then((entries) => {
        if (alive) replaceLogs(entries);
      })
      .catch(() => {
        /* ignore */
      });

    const offStatus = onServerStatus((s) => {
      if (alive) setStatus(s);
    });
    const offLog = onLogLine((entry) => {
      if (alive) appendLog(entry);
    });

    return () => {
      alive = false;
      offStatus();
      offLog();
    };
  }, [setStatus, appendLog, replaceLogs]);

  const start = useCallback(async () => {
    const s = await startServer();
    setStatus(s);
  }, [setStatus]);
  const stop = useCallback(async () => {
    const s = await stopServer();
    setStatus(s);
  }, [setStatus]);
  const restart = useCallback(async () => {
    const s = await restartServer();
    setStatus(s);
  }, [setStatus]);

  return { status, startServer: start, stopServer: stop, restartServer: restart };
}
