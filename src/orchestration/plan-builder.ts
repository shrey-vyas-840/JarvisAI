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
  argumentSources?: Record<string, { stepId: string; resultPath: string[] }>;
  preconditions?: string[];
  requiresVerifiedReceipt?: boolean;
  verificationMethod?: string;
  failurePolicy?: string;
  verification?:
    | {
        tool: string;
        args: Record<string, unknown>;
        expected: unknown;
      }
    | undefined;
}

export class PlanBuilder {
  private readonly steps: StepBuilder[] = [];
  private stepIdMap = new Map<string, string>();

  public addStep(
    step: Omit<
      StepBuilder,
      | 'id'
      | 'backend'
      | 'dependsOn'
      | 'argumentSources'
      | 'preconditions'
      | 'requiresVerifiedReceipt'
      | 'verificationMethod'
      | 'failurePolicy'
    > & {
      backend?: BackendName;
      dependsOn?: string[];
      argumentSources?: Record<string, { stepDescription: string; resultPath: string[] }>;
      preconditions?: string[];
      requiresVerifiedReceipt?: boolean;
      verificationMethod?: string;
      failurePolicy?: string;
    },
  ): this {
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
      ...(step.preconditions === undefined ? {} : { preconditions: step.preconditions }),
      ...(step.verification === undefined ? {} : { verification: step.verification }),
      ...(step.argumentSources === undefined
        ? {}
        : {
            argumentSources: Object.fromEntries(
              Object.entries(step.argumentSources).map(([name, source]) => [
                name,
                {
                  stepId: this.stepIdMap.get(source.stepDescription) ?? source.stepDescription,
                  resultPath: source.resultPath,
                },
              ]),
            ),
          }),
      ...(step.requiresVerifiedReceipt === undefined
        ? {}
        : { requiresVerifiedReceipt: step.requiresVerifiedReceipt }),
      ...(step.verificationMethod === undefined
        ? {}
        : { verificationMethod: step.verificationMethod }),
      ...(step.failurePolicy === undefined ? {} : { failurePolicy: step.failurePolicy }),
    });
    return this;
  }

  public addBrowserUrlWorkflow(url: string): this {
    const connect = 'Connect existing Chrome profile';
    const create = 'Create a JARVIS-owned browser tab';
    const navigate = `Navigate JARVIS tab to ${url}`;
    const readUrl = 'Read back browser URL';
    const readTitle = 'Read back browser title';
    const readText = 'Read back visible browser text';
    const requireVerifiedReceipt = true;

    this.addStep({
      description: connect,
      tool: 'browser_connect_profile',
      args: {},
      expectedOutcome: 'Connected profile is ready',
      requiresVerifiedReceipt: requireVerifiedReceipt,
    });
    this.addStep({
      description: create,
      tool: 'browser_new_tab',
      args: { url: 'about:blank' },
      dependsOn: [connect],
      expectedOutcome: 'A current JARVIS-owned tab with a stable ID is created',
      requiresVerifiedReceipt: requireVerifiedReceipt,
    });
    this.addStep({
      description: navigate,
      tool: 'browser_navigate',
      args: { url },
      dependsOn: [create],
      argumentSources: {
        tabId: { stepDescription: create, resultPath: ['tab', 'id'] },
      },
      expectedOutcome: 'The requested URL is loaded in the created tab',
      requiresVerifiedReceipt: requireVerifiedReceipt,
    });
    this.addStep({
      description: readUrl,
      tool: 'browser_get_page_url',
      args: { expectedUrl: url },
      dependsOn: [navigate],
      argumentSources: {
        tabId: { stepDescription: create, resultPath: ['tab', 'id'] },
      },
      expectedOutcome: 'The current URL matches the requested URL',
      requiresVerifiedReceipt: requireVerifiedReceipt,
    });
    this.addStep({
      description: readTitle,
      tool: 'browser_get_page_title',
      args: {},
      dependsOn: [readUrl],
      argumentSources: {
        tabId: { stepDescription: create, resultPath: ['tab', 'id'] },
      },
      expectedOutcome: 'A non-empty page title is read from the created tab',
      requiresVerifiedReceipt: requireVerifiedReceipt,
    });
    this.addStep({
      description: readText,
      tool: 'browser_get_page_text',
      args: { maxLength: 20_000 },
      dependsOn: [readTitle],
      argumentSources: {
        tabId: { stepDescription: create, resultPath: ['tab', 'id'] },
      },
      expectedOutcome: 'Visible page text is read from the created tab',
      requiresVerifiedReceipt: requireVerifiedReceipt,
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

  public addDesktopWait(
    ref: string,
    predicate: string,
    description = `Wait for ${predicate} on ${ref}`,
  ): this {
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

  public addWait(ms: number, description = `Wait ${String(ms)}ms`): this {
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
          ...(s.preconditions === undefined ? {} : { preconditions: s.preconditions }),
          ...(s.argumentSources === undefined ? {} : { argumentSources: s.argumentSources }),
          ...(s.requiresVerifiedReceipt === undefined
            ? {}
            : { requiresVerifiedReceipt: s.requiresVerifiedReceipt }),
          ...(s.verificationMethod === undefined
            ? {}
            : { verificationMethod: s.verificationMethod }),
          ...(s.failurePolicy === undefined ? {} : { failurePolicy: s.failurePolicy }),
          ...(s.verification === undefined ? {} : { verification: s.verification }),
        };
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
        backend: getBackendForStep(s),
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
