/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as actions from "../actions.js";
import type * as artifacts from "../artifacts.js";
import type * as briefs from "../briefs.js";
import type * as connections from "../connections.js";
import type * as connectors_canvas from "../connectors/canvas.js";
import type * as connectors_composio from "../connectors/composio.js";
import type * as connectors_gmail from "../connectors/gmail.js";
import type * as connectors_notion from "../connectors/notion.js";
import type * as connectors_outlook from "../connectors/outlook.js";
import type * as connectors_slack from "../connectors/slack.js";
import type * as delivery from "../delivery.js";
import type * as evidence from "../evidence.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_model from "../lib/model.js";
import type * as lib_providerAuth from "../lib/providerAuth.js";
import type * as lib_sharePage from "../lib/sharePage.js";
import type * as localEvidence from "../localEvidence.js";
import type * as memory from "../memory.js";
import type * as prepare from "../prepare.js";
import type * as projects from "../projects.js";
import type * as recap from "../recap.js";
import type * as shares from "../shares.js";
import type * as transcription from "../transcription.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  actions: typeof actions;
  artifacts: typeof artifacts;
  briefs: typeof briefs;
  connections: typeof connections;
  "connectors/canvas": typeof connectors_canvas;
  "connectors/composio": typeof connectors_composio;
  "connectors/gmail": typeof connectors_gmail;
  "connectors/notion": typeof connectors_notion;
  "connectors/outlook": typeof connectors_outlook;
  "connectors/slack": typeof connectors_slack;
  delivery: typeof delivery;
  evidence: typeof evidence;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  "lib/crypto": typeof lib_crypto;
  "lib/model": typeof lib_model;
  "lib/providerAuth": typeof lib_providerAuth;
  "lib/sharePage": typeof lib_sharePage;
  localEvidence: typeof localEvidence;
  memory: typeof memory;
  prepare: typeof prepare;
  projects: typeof projects;
  recap: typeof recap;
  shares: typeof shares;
  transcription: typeof transcription;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
