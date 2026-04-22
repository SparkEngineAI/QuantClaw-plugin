import type {
  Checkpoint,
  DetectionContext,
  PipelineConfig,
  QuantRouter,
  RouteDecision,
  RouterRegistration,
} from "./types.js";

export class RouterPipeline {
  private routers = new Map<string, QuantRouter>();
  private pipelineConfig: PipelineConfig = {};
  private routerConfigs = new Map<string, RouterRegistration>();
  private logger: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };

  constructor(logger?: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void }) {
    this.logger = logger ?? console;
  }

  register(router: QuantRouter, registration?: RouterRegistration): void {
    this.routers.set(router.id, router);
    if (registration) this.routerConfigs.set(router.id, registration);
  }

  configure(config: { routers?: Record<string, RouterRegistration | undefined>; pipeline?: PipelineConfig }): void {
    if (config.routers) {
      for (const [id, reg] of Object.entries(config.routers)) {
        if (reg) this.routerConfigs.set(id, reg);
      }
    }
    if (config.pipeline) {
      this.pipelineConfig = config.pipeline;
    }
  }

  getRoutersForCheckpoint(checkpoint: Checkpoint): string[] {
    return this.pipelineConfig[checkpoint] ?? [...this.routers.keys()];
  }

  listRouters(): string[] {
    return [...this.routers.keys()];
  }

  hasRouter(id: string): boolean {
    return this.routers.has(id);
  }

  async run(
    checkpoint: Checkpoint,
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouteDecision> {
    const routerIds = this.getRoutersForCheckpoint(checkpoint);
    let winning: RouteDecision = { action: "passthrough", reason: "No route selected" };

    for (const id of routerIds) {
      const reg = this.routerConfigs.get(id);
      if (reg?.enabled === false) continue;
      const router = this.routers.get(id);
      if (!router) continue;
      try {
        const decision = await router.detect(context, pluginConfig);
        decision.routerId = id;
        if ((decision.action ?? "passthrough") !== "passthrough") {
          return decision;
        }
        winning = decision;
      } catch (err) {
        this.logger.error(`[QuantClaw] Router ${id} failed: ${String(err)}`);
      }
    }

    return winning;
  }

  async runSingle(
    id: string,
    context: DetectionContext,
    pluginConfig: Record<string, unknown>,
  ): Promise<RouteDecision | null> {
    const router = this.routers.get(id);
    if (!router) return null;
    const decision = await router.detect({ ...context, dryRun: true }, pluginConfig);
    decision.routerId = id;
    return decision;
  }
}

let globalPipeline: RouterPipeline | null = null;

export function setGlobalPipeline(pipeline: RouterPipeline): void {
  globalPipeline = pipeline;
}

export function getGlobalPipeline(): RouterPipeline | null {
  return globalPipeline;
}
