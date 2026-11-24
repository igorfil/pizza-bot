import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AppNavigation } from "./AppNavigation.js";

const nav = (counts?: Parameters<typeof AppNavigation>[0]["counts"]) =>
  renderToStaticMarkup(<AppNavigation view="inbox" enableAutomations={false} enableMemories={false} onViewChange={() => {}} counts={counts} />);

describe("AppNavigation counts", () => {
  it("shows the unread count on the destination and says it in its label", () => {
    const html = nav({ fleet: 3 });
    expect([html.includes('aria-label="Fleet, 3 unread"'), /iconrail-count[^>]*>3</.test(html)]).toEqual([true, true]);
  });

  it("shows no count when nothing is unread", () => {
    expect(nav({ fleet: 0 })).not.toContain("iconrail-count");
  });

  it("caps a large count", () => {
    expect(nav({ fleet: 250 })).toContain(">99+<");
  });
});
