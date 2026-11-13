import { randomUUID } from 'node:crypto';
import type { Step, BackendName } from './types.js';
import { inferBackendFromTool, getBackendForStep } from './backend-router.js';

export interface StepBuilder {
  id: string;
  description: string;
  tool: string;
  args: Record<string, unknown>;
  backend: BackendName;
  dependsOn: string[];
  expectedOutcome: string;
  verification: {
    tool: string;
    args: Record<string, unknown>;
    expected: unknown;
  } | undefined;
}

export class PlanBuilder {
  private readonly steps: StepBuilder[] = [];
  private stepIdMap = new Map<string, string>();

  public constructor() {
  }

  public addStep(step: Omit<StepBuilder, 'id' | 'backend' | 'dependsOn'> & { backend?: BackendName; dependsOn?: string[] }): this {
    const id = randomUUID();
    this.stepIdMap.set(step.description, id);
    this.steps.push({
      id,
      description: step.description,
      tool: step.tool,
      args: step.args,
      backend: step.backend ?? inferBackendFromTool(step.tool),
      dependsOn: step.dependsOn?.map((d) => this.stepIdMap.get(d) ?? d) ?? [],
      expectedOutcome: step.expectedOutcome,
      verification: step.verification,
    });
    return this;
  }

  public addBrowserNavigate(url: string, description = `Navigate to ${url}`): this {
    return this.addStep({
      description,
      tool: 'browser_navigate',
      args: { url },
      expectedOutcome: 'Page loaded successfully',
      verification: {
        tool: 'browser_get_page_snapshot',
        args: {},
        expected: { url: { contains: url } },
      },
    });
  }

  public addBrowserClick(selector: string, description = `Click ${selector}`): this {
    return this.addStep({
      description,
      tool: 'browser_click',
      args: { selector },
      expectedOutcome: 'Element clicked',
      verification: {
        tool: 'browser_get_page_snapshot',
        args: {},
        expected: {},
      },
    });
  }

  public addBrowserFill(selector: string, value: string, description = `Fill ${selector}`): this {
    return this.addStep({
      description,
      tool: 'browser_fill_field',
      args: { selector, value },
      expectedOutcome: 'Field filled',
      verification: {
        tool: 'browser_get_page_snapshot',
        args: {},
        expected: {},
      },
    });
  }

  public addDesktopSnapshot(app: string, description = `Snapshot ${app}`): this {
    return this.addStep({
      description,
      tool: 'desktop_ax_snapshot',
      args: { app },
      expectedOutcome: 'Accessibility tree captured',
      backend: 'agent-desktop',
      verification: undefined,
    });
  }

  public addDesktopFind(app: string, role: string, description = `Find ${role} in ${app}`): this {
    return this.addStep({
      description,
      tool: 'desktop_ax_find',
      args: { app, role },
      expectedOutcome: 'Element found',
      backend: 'agent-desktop',
      verification: undefined,
    });
  }

  public addDesktopAction(action: string, ref: string, description = `${action} on ${ref}`): this {
    return this.addStep({
      description,
      tool: 'desktop_ax_action',
      args: { action, ref },
      expectedOutcome: `Action ${action} completed`,
      backend: 'agent-desktop',
      verification: undefined,
    });
  }

  public addDesktopWait(ref: string, predicate: string, description = `Wait for ${predicate} on ${ref}`): this {
    return this.addStep({
      description,
      tool: 'desktop_ax_wait',
      args: { mode: 'element', ref, predicate },
      expectedOutcome: `Condition ${predicate} met`,
      backend: 'agent-desktop',
      verification: undefined,
    });
  }

  public addVisionLocate(imagePath: string, description = `Locate image ${imagePath}`): this {
    return this.addStep({
      description,
      tool: 'desktop_vision_locate',
      args: { imagePath },
      expectedOutcome: 'Image located on screen',
      backend: 'vision',
      verification: undefined,
    });
  }

  public addWait(ms: number, description = `Wait ${ms}ms`): this {
    return this.addStep({
      description,
      tool: 'desktop_ax_wait',
      args: { mode: 'delay', ms },
      expectedOutcome: 'Delay completed',
      backend: 'agent-desktop',
      verification: undefined,
    });
  }

  public dependsOn(currentDescription: string, dependencyDescription: string): this {
    const currentStep = this.steps.find((s) => s.description === currentDescription);
    const depId = this.stepIdMap.get(dependencyDescription);
    if (currentStep && depId) {
      currentStep.dependsOn.push(depId);
    }
    return this;
  }

  public build(goal: string): { goal: string; steps: Omit<Step, 'state' | 'retryCount'>[] } {
    return {
      goal,
      steps: this.steps.map((s) => {
        const step: Omit<Step, 'state' | 'retryCount'> = {
          id: s.id,
          description: s.description,
          tool: s.tool,
          args: s.args,
          backend: s.backend,
          dependsOn: s.dependsOn,
          expectedOutcome: s.expectedOutcome,
        };
        if (s.verification !== undefined) {
          step.verification = s.verification;
        }
        return step;
      }),
    };
  }
}

export function createPlan(
  goal: string,
  steps: Omit<Step, 'id' | 'state' | 'retryCount'>[],
): { goal: string; steps: Omit<Step, 'id' | 'state' | 'retryCount'>[] } {
  return {
    goal,
    steps: steps.map((s) => {
      const step: Omit<Step, 'id' | 'state' | 'retryCount'> = {
        description: s.description,
        tool: s.tool,
        args: s.args,
        backend: s.backend ?? getBackendForStep(s),
        dependsOn: s.dependsOn ?? [],
        expectedOutcome: s.expectedOutcome,
      };
      if (s.verification !== undefined) {
        step.verification = s.verification;
      }
      return step;
    }),
  };
}