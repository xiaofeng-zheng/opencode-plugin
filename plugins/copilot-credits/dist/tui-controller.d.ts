import type { Context } from "@opencode/plugin/tui/context";
import type { JSX } from "@opentui/solid";
/** Host APIs remain real; the view factory is injectable for no-renderer contract tests. */
export declare function setupTui(ctx: Context, view: (line: () => string) => JSX.Element, publish: (line: string) => void, line: () => string): () => void;
