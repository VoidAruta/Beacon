export interface PocoHardwareStatus {
  available?: boolean;
  device_model: string;
  battery_percent: number | null;
  raw_status: string;
  power_plugged: boolean | null;
  voltage_mv?: number | null;
  current_ma?: number | null;
  battery_health?: string;
  min_target_pct: number;
  max_target_pct: number;
  alert_below_pct: number;
  battery_low_pct?: number;
  cycle_state: 'cycle_ok' | 'charging_to_target' | 'power_loss' | 'critical_low' | 'unavailable';
  cycle_label: string;
  should_alert: boolean;
  battery_temp_c: number | null;
  cpu_temp_c: number | null;
  battery_warn_temp_c?: number;
  battery_crit_temp_c?: number;
  thermal_auto_stop?: boolean;
  thermal_state?: 'ok' | 'warning' | 'critical';
  thermal_warning: boolean;
  is_real_sysfs: boolean;
  swap_total_mb?: number;
  swap_used_mb?: number;
  swap_percent?: number;
  uptime_sec?: number;
  uptime_human?: string;
}

export interface ProxyReachabilityStatus {
  configured: boolean;
  online: boolean;
  host: string;
  port: number;
  latency_ms: number;
}

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
    wal_size_kb?: number;
  };
  proxy_url: string;
  proxy_status?: ProxyReachabilityStatus;
  hardware?: PocoHardwareStatus;
  env_profile?: {
    env_mode: string;
    env_label: string;
    arch: string;
    kernel: string;
    is_android_chroot: boolean;
    is_container: boolean;
    has_systemd: boolean;
    has_battery: boolean;
    has_uv: boolean;
  };
  run_as_user: string;
}

export interface WebAuthSession {
  project_id: number;
  project_name: string;
  current_url: string;
  domain: string;
  page_title: string;
  http_status: number;
  proxy_mode: string;
  proxy_used: string;
  user_agent: string;
  antibot_passed: boolean;
  logged_in: boolean;
  form_login: string;
  form_password?: string;
  form_2fa: string;
  cookies: Array<{
    domain: string;
    name: string;
    value: string;
    path?: string;
    httpOnly?: boolean;
    secure?: boolean;
  }>;
  local_storage: Record<string, string>;
  profile_dir: string;
  started_at: number;
  last_action: string;
  preview_data_url: string;
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
  type: 'job' | 'service' | 'web';
  runtime: 'python' | 'node' | 'bash' | 'custom';
  cmd: string;
  workdir: string;
  env_json: string;
  secrets_json: string;
  env: Record<string, string>;
  secrets: string[];
  use_proxy: number;
  ram_limit_mb: number;
  port?: number;
  healthcheck_url?: string;
  healthcheck_interval_sec?: number;
  health_status?: string;
  has_venv?: boolean;
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
  group_tag?: string;
  custom_proxy?: string;
  git_repo_url?: string;
  has_browser_profile?: boolean;
  active_web_auth?: boolean;
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
