import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const workflowUrl = new URL('../../.github/workflows/scheduled-jobs.yml', import.meta.url);

describe('production scheduled-job workflow', () => {
  it('runs each bounded idempotent job on its documented schedule or manually', async () => {
    const workflow = await readFile(workflowUrl, 'utf8');

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain("cron: '15 */6 * * *'");
    expect(workflow).toContain("cron: '15 2 * * 0'");
    expect(workflow).toContain("cron: '0 4 * * *'");
    expect(workflow).toContain('pnpm jobs:acartia');
    expect(workflow).toContain('pnpm jobs:gbif');
    expect(workflow).toContain('pnpm jobs:predictions');
    expect(workflow).toContain('pnpm warm:public acartia');
    expect(workflow).toContain('pnpm warm:public gbif');
    expect(workflow).toContain('pnpm warm:public predictions');
    expect(workflow.match(/pnpm verify:production-data/gu)).toHaveLength(3);
    expect(workflow).toContain('PUBLIC_READ_ORIGIN: https://fluke-pnw.vercel.app');
    expect(workflow).toContain('timeout-minutes: 5');
    expect(workflow).toContain('timeout-minutes: 20');
    expect(workflow).toContain('timeout-minutes: 15');
  });

  it('uses least privilege and repository secrets for the production database', async () => {
    const workflow = await readFile(workflowUrl, 'utf8');

    expect(workflow).toMatch(/permissions:\n\s+contents: read/);
    expect(workflow).toContain('DATABASE_URL: ${{ secrets.PRODUCTION_DATABASE_URL }}');
    expect(workflow).toContain('DIRECT_URL: ${{ secrets.PRODUCTION_DIRECT_URL }}');
    expect(workflow).toContain('JWT_SECRET: ${{ secrets.SCHEDULED_JOB_JWT_SECRET }}');
    expect(workflow).toContain('ENABLE_ACCOUNTS: "false"');
    expect(workflow).toContain('IDENTIFIER_MODE: "disabled"');
    expect(workflow).not.toContain('ENABLE_IDENTIFY:');
    expect(workflow).toContain('ENABLE_SUBMISSIONS: "false"');
    expect(workflow).not.toContain('pull_request:');
    expect(workflow.toLowerCase()).not.toMatch(/keepalive|keep-alive/);
  });
});
