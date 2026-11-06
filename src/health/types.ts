export type HealthStatus = 'OK' | 'WARNING' | 'FAILED';

export interface HealthCheck {
  id: string;
  label: string;
  status: HealthStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface HealthReport {
  timestamp: string;
  version: string;
  status: HealthStatus;
  checks: HealthCheck[];
}
