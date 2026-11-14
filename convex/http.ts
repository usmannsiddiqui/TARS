import { httpRouter } from "convex/server";
import { handlePush as gmailPush, oauthCallback as googleCallback } from "./connectors/gmail";
import { handleEvent as notionEvent } from "./connectors/notion";
import { handleNotification as outlookNotification, oauthCallback as microsoftCallback } from "./connectors/outlook";
import { handleEvent as slackEvent } from "./connectors/slack";

// One route per event-capable provider. Each handler verifies its provider's signature
// over the raw body before parsing and answers 2xx for valid deliveries it ignores.
const http = httpRouter();
http.route({ path: "/slack/events", method: "POST", handler: slackEvent });
http.route({ path: "/notion/events", method: "POST", handler: notionEvent });
http.route({ path: "/gmail/push", method: "POST", handler: gmailPush });
http.route({ path: "/outlook/notifications", method: "POST", handler: outlookNotification });
// Provider OAuth redirects: the stored single-use state names the owner and source.
http.route({ path: "/oauth/google/callback", method: "GET", handler: googleCallback });
http.route({ path: "/oauth/microsoft/callback", method: "GET", handler: microsoftCallback });
export default http;
