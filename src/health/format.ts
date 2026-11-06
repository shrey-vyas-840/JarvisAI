import type { HealthReport } from './types.js';

export function formatHealthReport(report: HealthReport): string {
  const lines = [
    `JARVIS health (${report.version}) at ${report.timestamp}`,
    `Overall: ${report.status}`,
    '',
  ];

  for (const check of report.checks) {
    lines.push(`[${check.status}] ${check.label}: ${check.message}`);

    if (check.details !== undefined) {
      lines.push(`  ${JSON.stringify(check.details)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}
