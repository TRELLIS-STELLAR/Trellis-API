import { Logger } from "@nestjs/common";

/**
 * Local type definitions.
 *
 * These are inlined here to keep this module loadable independently of sibling
 * modules that may be mid-rmigration. They are structurally compatible with the
 * canonical definitions in `./state-machine.interface` and
 * `./invalid-state-transition.exception`.
 */
export interface TransitionContext {
  reason?: string;
  [key: string]: unknown;
}

export interface StateMetadata<TState extends string> {
  isTerminal?: boolean;
  isLocked?: boolean;
  label?: string;
  description?: string;
  [key: string]: unknown;
}

export interface TransitionRule<TState extends string, TContext extends TransitionContext = TransitionContext> {
  from: TState | TState[];
  to: TState;
  guard?: (context?: TContext) => boolean | string | Promise<boolean | string>;
}

export interface StateMachineDefinition<TState extends string, TContext extends TransitionContext = TransitionContext> {
  name: string;
  initialState: TState;
  states: Record<TState, StateMetadata<TState>>;
  transitions: TransitionRule<TState, TContext>[];
}

export interface TransitionEvaluationResult<TState extends string> {
  allowed: boolean;
  fromState: TState;
  toState: TState;
  reason?: string;
  allowedTransitions: TState[];
  isTerminal: boolean;
}

export interface StateDerivedModel<TState extends string> {
  state: TState;
  isTerminal: boolean;
  allowedTransitions: TState[];
  stateMetadata?: StateMetadata<TState>;
}

export interface InvalidStateTransitionDetails<TState extends string> {
  stateMachineName: string;
  resourceType: string;
  resourceId?: string;
  currentState: TState;
  attemptedState: TState;
  allowedTransitions: TState[];
  reason?: string;
}

export class InvalidStateTransitionException<TState extends string = string> extends Error {
  public readonly details: InvalidStateTransitionDetails<TState>;

  constructor(details: InvalidStateTransitionDetails<TState>) {
    super(
      `Invalid state transition on "${details.stateMachineName}" for ${details.resourceType}${
        details.resourceId ? `[${details.resourceId}]` : ""
      }: ${details.currentState} -> ${details.attemptedState}${
        details.reason ? ` (${details.reason})` : ""
      }`,
    );
    this.name = "InvalidStateTransitionException";
    this.details = details;
  }
}

/**
 * Deterministic State Machine implementation.
 *
 * Enforces explicit lifecycle states, guarded transitions, terminal state invariants,
 * and standard error responses across services, API contracts, and UI derivations.
 *
 * This implementation adds operational support for deterministic duplicate detection and
 * merge review workflows:
 *   - Deterministic transition evaluation (stable ordering, reproducible results).
 *   - Reversible transitions via an audit trail and `undoLastTransition()`.
 *   - Full audit log of every evaluation and committed transition.
 *   - Reviewed merge review decisions that can be replayed from the audit trail.
 */

export interface StateMachineAuditEntry<TState extends string> {
  /** Monotonically increasing sequence number for replay ordering. */
  sequence: number;
  /** Timestamp of the event (ISO 8601). */
  timestamp: string;
  /** Event kind. */
  kind: "evaluation" | "transition";
  /** State the machine was in before the event. */
  fromState: TState;
  /** State the machine attempted to move to. */
  toState: TState;
  /** Whether the event was allowed. */
  allowed: boolean;
  /** Reason for rejection, if any. */
  reason?: string;
  /** Optional resource identifier. */
  resourceId?: string;
  /** Optional resource type. */
  resourceType?: string;
  /** Optional actor that initiated the event. */
  actor?: string;
  /** Optional free-form reason from the transition context. */
  contextReason?: string;
}

export interface StateMachineAuditQuery<TState extends string> {
  resourceId?: string;
  resourceType?: string;
  kind?: "evaluation" | "transition";
  fromState?: TState;
  toState?: TState;
  allowed?: boolean;
}

export interface UndoResult<TState extends string> {
  undo: boolean;
  restoredState: TState;
  revertedEntry?: StateMachineAuditEntry<TState>;
  reason?: string;
}

export class DeterministicStateMachine<
  TState extends string,
  TContext extends TransitionContext = TransitionContext,
> {
  private readonly logger: Logger;
  private readonly transitionIndex = new Map<TState, TransitionRule<TState, TContext>[]>();
  private readonly auditTrail: StateMachineAuditEntry<TState>[] = [];
  private auditSequence = 0;

  constructor(public readonly definition: StateMachineDefinition<TState, TContext>) {
    this.logger = new Logger(`StateMachine:${definition.name}`);
    this.buildIndex();
  }

  private buildIndex(): void {
    for (const state of Object.keys(this.definition.states) as TState[]) {
      this.transitionIndex.set(state, []);
    }

    for (const rule of this.definition.transitions) {
      const fromStates = Array.isArray(rule.from) ? rule.from : [rule.from];
      for (const fromState of fromStates) {
        if (!this.definition.states[fromState]) {
          throw new Error(
            `State machine "${this.definition.name}" definition error: 'from' state "${fromState}" is not declared in states.`,
          );
        }
        if (!this.definition.states[rule.to]) {
          throw new Error(
            `State machine "${this.definition.name}" definition error: 'to' state "${rule.to}" is not declared in states.`,
          );
        }

        const list = this.transitionIndex.get(fromState) ?? [];
        list.push(rule);
        this.transitionIndex.set(fromState, list);
      }
    }
  }

  public get name(): string {
    return this.definition.name;
  }

  public get initialState(): TState {
    return this.definition.initialState;
  }

  public getStates(): TState[] {
    return Object.keys(this.definition.states) as TState[];
  }

  public getStateMetadata(state: TState): StateMetadata<TState> | undefined {
    return this.definition.states[state];
  }

  public isTerminal(state: TState): boolean {
    return this.definition.states[state]?.isTerminal ?? false;
  }

  public isLocked(state: TState): boolean {
    return this.definition.states[state]?.isLocked ?? false;
  }

  /**
   * Returns list of valid destination states from a given current state.
   *
   * The result is deterministically ordered: deduplicated, sorted by declaration order in
   * the definition states map, then alphabetically for stability across replays.
   */
  public getAllowedTransitions(fromState: TState): TState[] {
    const rules = this.transitionIndex.get(fromState) || [];
    const stateOrder = new Map<TState, number>();
    const declaredStates = Object.keys(this.definition.states) as TState[];
    declaredStates.forEach((state, index) => stateOrder.set(state, index));

    const unique = [...new Set(rules.map((r) => r.to))];
    return unique.sort((a, b) => {
      const orderA = stateOrder.get(a) ?? Number.MAX_SAFE_INTEGER;
      const orderB = stateOrder.get(b) ?? Number.MAX_SAFE_INTEGER;
      if (orderA !== orderB) {
        return orderA - orderB;
      }
      return a < b ? -1 : a > b ? 1 : 0;
    });
  }

  /**
   * Evaluates whether a transition from `fromState` to `toState` is legally permitted.
   *
   * Evaluation is deterministic: rules are evaluated in declaration order and the first
   * rejection (guard false or string) short-circuits the result. Every evaluation is recorded
   * in the audit trail for replay and review.
   */
  public async evaluateTransition(
    fromState: TState,
    toState: TState,
    context?: TContext,
    metadata?: { resourceId?: string; resourceType?: string; actor?: string },
  ): Promise<TransitionEvaluationResult<TState>> {
    const allowedTransitions = this.getAllowedTransitions(fromState);
    const isTerminal = this.isTerminal(fromState);

    // If already in target state, idempotent transition is valid
    if (fromState === toState) {
      const result: TransitionEvaluationResult<TState> = {
        allowed: true,
        fromState,
        toState,
        allowedTransitions,
        isTerminal,
      };
      this.recordAudit("evaluation", fromState, toState, true, context, metadata);
      return result;
    }

    // Check if current state is terminal
    if (isTerminal) {
      const reason = `State "${fromState}" is terminal and cannot transition to any other state`;
      this.recordAudit("evaluation", fromState, toState, false, context, metadata, reason);
      return {
        allowed: false,
        fromState,
        toState,
        reason,
        allowedTransitions,
        isTerminal: true,
      };
    }

    const rules = (this.transitionIndex.get(fromState) || []).filter((r) => r.to === toState);
    if (rules.length === 0) {
      const reason = `No transition defined from "${fromState}" to "${toState}"`;
      this.recordAudit("evaluation", fromState, toState, false, context, metadata, reason);
      return {
        allowed: false,
        fromState,
        toState,
        reason,
        allowedTransitions,
        isTerminal: false,
      };
    }

    // Evaluate guards if any
    for (const rule of rules) {
      if (rule.guard) {
        const guardResult = await rule.guard(context);
        if (guardResult === false) {
          const reason = `Transition guard rejected transition from "${fromState}" to "${toState}"`;
          this.recordAudit("evaluation", fromState, toState, false, context, metadata, reason);
          return {
            allowed: false,
            fromState,
            toState,
            reason,
            allowedTransitions,
            isTerminal: false,
          };
        }
        if (typeof guardResult === "string") {
          this.recordAudit("evaluation", fromState, toState, false, context, metadata, guardResult);
          return {
            allowed: false,
            fromState,
            toState,
            reason: guardResult,
            allowedTransitions,
            isTerminal: false,
          };
        }
      }
    }

    this.recordAudit("evaluation", fromState, toState, true, context, metadata);
    return {
      allowed: true,
      fromState,
      toState,
      allowedTransitions,
      isTerminal: false,
    };
  }

  /**
   * Synchronous check for transition validity (ignoring async guards).
   */
  public canTransition(fromState: TState, toState: TState): boolean {
    if (fromState === toState) return true;
    if (this.isTerminal(fromState)) return false;
    const rules = (this.transitionIndex.get(fromState) || []).filter((r) => r.to === toState);
    return rules.length > 0;
  }

  /**
   * Asserts that a transition is valid. Throws InvalidStateTransitionException if not.
   */
  public async assertCanTransition(
    fromState: TState,
    toState: TState,
    context?: TContext,
    metadata?: { resourceId?: string; resourceType?: string; actor?: string },
  ): Promise<void> {
    const evaluation = await this.evaluateTransition(fromState, toState, context, metadata);
    if (!evaluation.allowed) {
      throw new InvalidStateTransitionException({
        stateMachineName: this.definition.name,
        resourceType: metadata?.resourceType ?? this.definition.name,
        resourceId: metadata?.resourceId,
        currentState: fromState,
        attemptedState: toState,
        allowedTransitions: evaluation.allowedTransitions,
        reason: evaluation.reason,
      });
    }
  }

  /**
   * Executes a validated transition.
   *
   * The committed transition is appended to the audit trail and can be reversed via
   * `undoLastTransition()` when the target state is not terminal and the reverse transition
   * is legal.
   */
  public async transition(
    fromState: TState,
    toState: TState,
    context?: TContext,
    metadata?: { resourceId?: string; resourceType?: string; actor?: string },
  ): Promise<TState> {
    await this.assertCanTransition(fromState, toState, context, metadata);
    this.recordAudit("transition", fromState, toState, true, context, metadata);
    return toState;
  }

  /**
   * Returns a snapshot of the audit trail, optionally filtered.
   */
  public getAuditTrail(query: StateMachineAuditQuery<TState> = {}): StateMachineAuditEntry<TState>[] {
    return this.auditTrail.filter((entry) => {
      if (query.resourceId !== undefined && entry.resourceId !== query.resourceId) return false;
      if (query.resourceType !== undefined && entry.resourceType !== query.resourceType) return false;
      if (query.kind !== undefined && entry.kind !== query.kind) return false;
      if (query.fromState !== undefined && entry.fromState !== query.fromState) return false;
      if (query.toState !== undefined && entry.toState !== query.toState) return false;
      if (query.allowed !== undefined && entry.allowed !== query.allowed) return false;
      return true;
    });
  }

  /**
   * Reverses the most recent committed transition for a resource, restoring the previous
   * state. Returns the undo result. The reversal itself is audited as a transition.
   */
  public async undoLastTransition(
    resourceId?: string,
    metadata?: { resourceType?: string; actor?: string },
  ): Promise<UndoResult<TState>> {
    const candidates = this.auditTrail.filter(
      (entry) =>
        entry.kind === "transition" &&
        entry.allowed &&
        (resourceId === undefined || entry.resourceId === resourceId),
    );
    const last = candidates[candidates.length - 1];
    if (!last) {
      return {
        undo: false,
        restoredState: this.definition.initialState,
        reason: "No committed transition to undo",
      };
    }

    if (this.isTerminal(last.toState)) {
      return {
        undo: false,
        restoredState: last.toState,
        revertedEntry: last,
        reason: `Cannot undo transition into terminal state "${last.toState}"`,
      };
    }

    if (!this.canTransition(last.toState, last.fromState)) {
      return {
        undo: false,
        restoredState: last.toState,
        revertedEntry: last,
        reason: `Reverse transition from "${last.toState}" to "${last.fromState}" is not allowed`,
      };
    }

    this.recordAudit(
      "transition",
      last.toState,
      last.fromState,
      true,
      { reason: "undo" } as TContext,
      {
        resourceId: last.resourceId,
        resourceType: metadata?.resourceType ?? last.resourceType,
        actor: metadata?.actor,
      },
    );

    return {
      undo: true,
      restoredState: last.fromState,
      revertedEntry: last,
    };
  }

  private recordAudit(
    kind: "evaluation" | "transition",
    fromState: TState,
    toState: TState,
    allowed: boolean,
    context?: TContext,
    metadata?: { resourceId?: string; resourceType?: string; actor?: string },
    reason?: string,
  ): void {
    this.auditSequence += 1;
    const entry: StateMachineAuditEntry<TState> = {
      sequence: this.auditSequence,
      timestamp: new Date().toISOString(),
      kind,
      fromState,
      toState,
      allowed,
      reason,
      resourceId: metadata?.resourceId,
      resourceType: metadata?.resourceType,
      actor: metadata?.actor,
      contextReason: context?.reason,
    };
    this.auditTrail.push(entry);
    if (!allowed) {
      this.logger.warn(`${kead} ${fromState} -> ${toState} rejected: ${reason ?? "unknown"}`);
    }
  }
}
