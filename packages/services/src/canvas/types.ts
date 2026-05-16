export interface CanvasAction {
  mindId: string;
  canvas: string;
  action: string;
  data: unknown;
  timestamp: number;
  lensViewId?: string;
}

export interface CanvasEntry {
  name: string;
  filename: string;
  url: string;
  token: string;
}

/**
 * Closed set of transition kinds accepted by the presentation engine (#5).
 *
 * The `zoom` kind is vestibular-risky per Sullivan's
 * {@link import('../sullivan/motionLimits').VESTIBULAR_RISKY_TRANSITIONS} and is
 * substituted to `fade` at runtime when
 * `prefers-reduced-motion: reduce` is active.
 */
export type CanvasPresentationTransitionKind =
  | 'zoom'
  | 'pan'
  | 'fade'
  | 'reveal'
  | 'none';

export interface CanvasPresentationTransition {
  kind: CanvasPresentationTransitionKind;
  durationMs?: number;
}

export interface CanvasPresentationStep {
  id: string;
  title: string;
  narration?: string;
  transition?: CanvasPresentationTransition;
}

/**
 * Opt-in presentation flow over a canvas (#5).
 *
 * When attached to a `canvas_show` / `canvas_update` call, the server stores
 * the payload in a sidecar JSON next to the HTML and the injected engine walks
 * the reader through `steps` in order. Omitting `presentation` keeps the
 * canvas byte-identical to the no-engine baseline.
 */
export interface CanvasPresentation {
  steps: CanvasPresentationStep[];
  startStepId?: string;
  options?: {
    autoAdvance?: { intervalMs: number };
    linearByDefault?: boolean;
  };
}

export interface CanvasShowInput {
  name: string;
  html?: string;
  file?: string;
  title?: string;
  lang?: string;
  open_browser?: boolean;
  presentation?: CanvasPresentation;
}

export interface CanvasUpdateInput {
  name: string;
  html: string;
  title?: string;
  lang?: string;
  presentation?: CanvasPresentation;
}

export interface CanvasCloseInput {
  name: string;
}

export interface CanvasServerLike {
  start(): Promise<number>;
  stop(): Promise<void>;
  reload(mindId?: string, filename?: string): void;
  closeClients(mindId?: string, filename?: string): void;
  getPort(): number | null;
  isRunning(): boolean;
}
