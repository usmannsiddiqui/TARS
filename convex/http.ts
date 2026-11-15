import { httpRouter } from "convex/server";
import { handleEvent as composioEvent, oauthCallback as composioCallback } from "./connectors/composio";
import { handlePush as gmailPush, oauthCallback as googleCallback } from "./connectors/gmail";
import { handleEvent as notionEvent } from "./connectors/notion";
import { handleNotification as outlookNotification, oauthCallback as microsoftCallback } from "./connectors/outlook";
import { handleEvent as slackEvent } from "./connectors/slack";
import { DOWNLOAD_PREFIX, download as documentDownload } from "./delivery";
import { SHARE_PREFIX, page as sharedPage } from "./shares";
import { upload as transcriptionUpload } from "./transcription";
import { STATUS_PATH, WHATSAPP_PATH, inbound as whatsappInbound, statusCallback as whatsappStatus } from "./whatsapp";

// One route per event-capable provider. Each handler verifies its provider's signature
// over the raw body before parsing and answers 2xx for valid deliveries it ignores.
const http = httpRouter();
http.route({ path: "/slack/events", method: "POST", handler: slackEvent });
http.route({ path: "/notion/events", method: "POST", handler: notionEvent });
http.route({ path: "/gmail/push", method: "POST", handler: gmailPush });
http.route({ path: "/outlook/notifications", method: "POST", handler: outlookNotification });
// Composio: one signed webhook for every trigger in the project (Slack, Gmail, Outlook via Composio).
http.route({ path: "/composio/events", method: "POST", handler: composioEvent });
http.route({ path: "/composio/callback", method: "GET", handler: composioCallback });
// Provider OAuth redirects: the stored single-use state names the owner and source.
http.route({ path: "/oauth/google/callback", method: "GET", handler: googleCallback });
http.route({ path: "/oauth/microsoft/callback", method: "GET", handler: microsoftCallback });
http.route({ path: "/transcription", method: "POST", handler: transcriptionUpload });
// TARS on WhatsApp (Twilio): his messages, and Twilio's status for messages TARS sent. X-Twilio-Signature checked.
http.route({ path: WHATSAPP_PATH, method: "POST", handler: whatsappInbound });
http.route({ path: STATUS_PATH, method: "POST", handler: whatsappStatus });
// Public read-only shared pages: anyone with the link, no sign-in.
http.route({ pathPrefix: SHARE_PREFIX, method: "GET", handler: sharedPage });
// Word documents the user sent: anyone with the link downloads that one file, no sign-in.
http.route({ pathPrefix: DOWNLOAD_PREFIX, method: "GET", handler: documentDownload });
export default http;
