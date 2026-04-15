import { useSidecar } from '../hooks/useSidecar';
import type { ServerState } from '../lib/types';

const LABEL: Record<ServerState, string> = {
  idle: '○ Stopped',
  starting: '◐ Starting…',
  running: '● Running',
  stopping: '◐ Stopping…',
  crashed: '✕ Crashed',
  port_in_use: '✕ Port in use',
  error: '✕ Error',
};

const COLOR_CLASS: Record<ServerState, string> = {
  idle: 'status-idle',
  starting: 'status-starting',
  running: 'status-running',
  stopping: 'status-starting',
  crashed: 'status-error',
  port_in_use: 'status-error',
  error: 'status-error',
};

export function StatusBadge() {
  const { status, startServer } = useSidecar();
  const label = LABEL[status.state];
  const suffix =
    status.state === 'running'
      ? ` :${status.port}`
      : status.errorMessage
        ? `: ${status.errorMessage}`
        : '';
  const cls = COLOR_CLASS[status.state];
  const clickable =
    status.state === 'crashed' ||
    status.state === 'port_in_use' ||
    status.state === 'error';
  return (
    <button
      type="button"
      className={`status-badge ${cls}${clickable ? ' status-clickable' : ''}`}
      onClick={clickable ? () => void startServer() : undefined}
      title={clickable ? 'Click to retry' : status.errorMessage ?? label}
      disabled={!clickable}
    >
      {label}
      {suffix}
    </button>
  );
}
