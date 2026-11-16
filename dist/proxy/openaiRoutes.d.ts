/**
 * OpenAI-compatible route handlers: `GET /v1/models` and (later) `POST /v1/chat/completions`.
 *
 * All collaborators come in through `OpenAIRouteDeps` (design Decision 6), so tests can
 * pass fakes and no network, `custom_models.json` or IDE is involved.
 */
import type * as http from 'http';
import type { Transform } from 'stream';
import type { CustomModel } from '../proxy';
import type { GeminiBody } from './requestOptions';
import { type SpecResolver } from './openaiCompat';
export interface TransformerOptions {
    headers: http.IncomingHttpHeaders;
    model: string;
    heartbeatIntervalMs: number;
}
export interface OpenAIRouteDeps {
    loadModels: () => CustomModel[];
    matchModel: (models: CustomModel[], selector: string) => CustomModel | undefined;
    runModel: (res: http.ServerResponse, model: CustomModel, body: GeminiBody, isStream: boolean, allModels: CustomModel[], cloudEnvelope: boolean) => Promise<void>;
    /** Default: `defaultCatalogResolver.resolveModelSpec`. */
    resolveSpec?: SpecResolver;
    /** Default: `Date.now`. */
    now?: () => number;
    /** Default: `crypto.randomUUID`. */
    newId?: () => string;
    /** Default: `startSseHeartbeat` from the Norm_Modules. */
    startHeartbeat?: (res: http.ServerResponse) => {
        stop(): void;
    };
    /** Default: `new StreamTransformer(opts)`. */
    createTransformer?: (opts: TransformerOptions) => {
        createTransformStream(): Transform;
    };
}
/** `OpenAIRouteDeps` with every optional dependency filled in by its production default. */
export type ResolvedOpenAIRouteDeps = Required<OpenAIRouteDeps>;
export declare function withDefaults(deps: OpenAIRouteDeps): ResolvedOpenAIRouteDeps;
/**
 * Decision 5 / R4.1: the ids listed by `/v1/models` win (first-wins order of R3.5),
 * then `matchModel` handles full names, catalog slugs, local slugs and placeholder ids.
 */
export declare function resolveChatModel(models: CustomModel[], selector: string, matchModel: OpenAIRouteDeps['matchModel']): CustomModel | undefined;
/** R3.1, R3.10, R3.11: OpenAI-format model list built only from local data. */
export declare function handleOpenAIModels(res: http.ServerResponse, deps: OpenAIRouteDeps): void;
/**
 * R4.1, R4.2, R4.11–R4.13, R7.1–R7.4, R7.9: validates the body, maps it to a GeminiBody,
 * resolves the Model_Selector and hands the request to `runModel` exactly once.
 */
export declare function handleChatCompletions(req: http.IncomingMessage, res: http.ServerResponse, bodyStr: string, deps: OpenAIRouteDeps): void;
//# sourceMappingURL=openaiRoutes.d.ts.map