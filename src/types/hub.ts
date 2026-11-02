export interface SystemStatus {
  cpu_percent: number;
  ram_total_mb: number;
  ram_used_mb: number;
  ram_available_mb: number;
  ram_percent: number;
  hub_pid: number;
  hub_rss_bytes: number;
  hub_rss_mb: number;
  hub_ram_budget_mb: number;
  disk: {
    free_mb: number;
    total_mb: number;
    used_mb: number;
    percent: number;
    warn_mb: number;
    crit_mb: number;
    state: 'ok' | 'warning' | 'critical';
    can_start_runs: boolean;
  };
  proxy_url: string;
  run_as_user: string;
}

export interface PendingAsk {
  id: string;
  run_id: number;
  project_id: number;
  project_name: string;
  prompt: string;
  status: 'pending' | 'answered' | 'timeout' | 'cancelled';
  created_at: number;
  expires_at: number;
  remaining_sec: number;
  tg_message_id?: number | null;
}

export interface ExpiredCookie {
  name: string;
  type: 'cookie_json' | 'text' | 'file';
  expired_note: string;
  updated_at: number;
}

export interface RunItem {
  id: number;
  project_id: number;
  project_name?: string;
  status: 'running' | 'waiting_input' | 'success' | 'failed' | 'timeout' | 'stopped' | 'killed_oom';
  trigger: 'manual' | 'schedule' | 'webhook' | 'autostart' | 'restart' | 'retry';
  pid: number | null;
  pgid: number | null;
  proc_create_time?: number | null;
  started_at: number;
  finished_at: number | null;
  exit_code: number | null;
  log_path?: string;
  error_summary: string;
  rss_mb?: number;
  cpu_percent?: number;
}

export interface ProjectCookieStatus {
  secret_name: string;
  has_cookies: boolean;
  is_expired: number;
  expired_note: string;
  updated_at: number;
  size_bytes: number;
}

export interface ProjectItem {
  id: number;
  name: string;
  type: 'job' | 'service';
  runtime: 'python' | 'node' | 'bash' | 'custom';
  cmd: string;
  workdir: string;
  env_json: string;
  secrets_json: string;
  env: Record<string, string>;
  secrets: string[];
  use_proxy: number;
  ram_limit_mb: number;
  schedule_type: 'manual' | 'cron' | 'interval';
  schedule_expr: string;
  timeout_sec: number;
  max_retries: number;
  retry_delay_sec: number;
  webhook_token: string;
  autostart: number;
  restart_policy: 'no' | 'on-failure' | 'always';
  backoff_min_sec: number;
  backoff_max_sec: number;
  desired_state: 'running' | 'stopped';
  notify_on_error: number;
  notify_on_success: number;
  notify_on_crash: number;
  created_at: number;
  updated_at: number;
  current_status: RunItem['status'];
  active_run_id: number | null;
  pid: number | null;
  pgid: number | null;
  rss_mb: number;
  cpu_percent: number;
  last_run: RunItem | null;
  code_size_bytes: number;
  logs_size_bytes: number;
  total_size_bytes: number;
  description: string;
  is_test_project: boolean;
  cookie_status: ProjectCookieStatus;
}

export interface UpcomingRun {
  project_id: number;
  project_name: string;
  schedule_type: 'cron' | 'interval';
  schedule_expr: string;
  next_run_at: number;
  in_seconds: number;
}

export interface NotificationEvent {
  timestamp: number;
  channel: string;
  title: string;
  text: string;
  level: string;
  proxy_used: string;
  delivered: boolean;
  detail: string;
}

export interface DashboardData {
  system: SystemStatus;
  pending_asks: PendingAsk[];
  expired_cookies: ExpiredCookie[];
  projects: ProjectItem[];
  upcoming_runs: UpcomingRun[];
  recent_errors: RunItem[];
  recent_notifications: NotificationEvent[];
}

export interface SecretItem {
  name: string;
  type: 'text' | 'file' | 'cookie_json';
  file_path: string;
  is_expired: number;
  expired_note: string;
  updated_at: number;
  masked_value: string;
  size_bytes: number;
  used_by_projects?: string[];
}

export interface FileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  children?: FileTreeNode[];
}

export interface AuditEntry {
  id: number;
  timestamp: number;
  ip: string;
  action: string;
  details: string;
}

export interface AcceptanceCheckItem {
  id: number;
  title: string;
  passed: boolean;
  details: string;
}
