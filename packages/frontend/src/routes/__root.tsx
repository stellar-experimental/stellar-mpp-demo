import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import appCss from "../styles.css?url";

const SITE_URL = "https://mpp.dev";
const SITE_TITLE = "MPP Chat Demo";
const SITE_DESCRIPTION =
  "A live demo of pay-per-message AI chat powered by MPP micropayment sessions on the Stellar blockchain. Open a session, chat with an AI, and settle on-chain — no subscriptions.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: SITE_TITLE },
      { name: "description", content: SITE_DESCRIPTION },
      { name: "theme-color", content: "#000000" },
      // Open Graph
      { property: "og:type", content: "website" },
      { property: "og:url", content: SITE_URL },
      { property: "og:site_name", content: SITE_TITLE },
      { property: "og:title", content: SITE_TITLE },
      { property: "og:description", content: SITE_DESCRIPTION },
      { property: "og:image", content: `${SITE_URL}/meta.jpg` },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      // Twitter Card
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: SITE_TITLE },
      { name: "twitter:description", content: SITE_DESCRIPTION },
      { name: "twitter:image", content: `${SITE_URL}/meta.jpg` },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "canonical", href: SITE_URL },
      { rel: "manifest", href: "/manifest.json" },
    ],
  }),
  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <div
          id="root"
          className="flex h-screen min-h-[100dvh] flex-col bg-black text-neutral-300 font-mono"
        >
          <Outlet />
        </div>
        <Scripts />
      </body>
    </html>
  );
}
