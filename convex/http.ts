import { httpRouter } from "convex/server";
import { handleEvent as notionEvent } from "./connectors/notion";
import { handleEvent as slackEvent } from "./connectors/slack";

// One route per event-capable provider. Each handler verifies its provider's signature
// over the raw body before parsing and answers 2xx for valid deliveries it ignores.
const http = httpRouter();
http.route({ path: "/slack/events", method: "POST", handler: slackEvent });
http.route({ path: "/notion/events", method: "POST", handler: notionEvent });
export default http;
