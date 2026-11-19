import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import type { PresenceUser } from "../../shared/ws";
import { cleanup, render } from "../test/dom";
import { PresenceIndicator } from "./PresenceIndicator";

afterEach(cleanup);

const user = (id: string, name: string, connections = 1, readOnly = false): PresenceUser => ({
  id,
  name,
  readOnly,
  connections,
});

function openList(container: HTMLElement) {
  const button = container.querySelector("button") as HTMLButtonElement;
  act(() => button.click());
  return container.querySelector('[data-testid="presence-list"]') as HTMLElement;
}

describe("PresenceIndicator", () => {
  it("counts people, not connections: one account in three tabs is 1 online", () => {
    const { container } = render(
      <PresenceIndicator
        status="connected"
        clients={3}
        people={1}
        users={[user("u1", "Dylan", 3)]}
      />,
    );
    const presence = container.querySelector('[data-testid="presence"]') as HTMLElement;
    expect(presence.dataset.people).toBe("1");
    expect(presence.dataset.clients).toBe("3");
    expect(container.querySelector('[data-testid="presence-count"]')?.textContent).toBe("1 online");
    expect(container.querySelector("button")?.getAttribute("aria-label")).toBe(
      "1 online: who's here",
    );
  });

  it("lists each person once, with a quiet note when they have several tabs open", () => {
    const { container } = render(
      <PresenceIndicator
        status="connected"
        clients={4}
        people={2}
        users={[user("u1", "Dylan", 3), user("u2", "Sam")]}
      />,
    );
    const items = [...openList(container).querySelectorAll("li")];
    expect(items.map((li) => li.textContent)).toEqual(["Dylan · 3 tabs", "Sam"]);
    expect(items[0]?.querySelector('[data-testid="presence-tabs"]')?.textContent).toBe(" · 3 tabs");
    expect(container.querySelector("button")?.getAttribute("title")).toBe("Dylan (3 tabs), Sam");
  });

  it("share-link visitors count one each and are listed as guests, never as tabs", () => {
    const { container } = render(
      <PresenceIndicator
        status="connected"
        clients={4}
        people={4}
        readOnly={3}
        users={[
          user("u1", "Dylan"),
          user("share:a", "Guest (read-only)", 2, true),
          user("share:b", "Guest (read-only)", 1, true),
        ]}
      />,
    );
    expect(container.querySelector('[data-testid="presence-count"]')?.textContent).toBe("4 online");
    expect(container.querySelector('[data-testid="presence-read-only"]')?.textContent).toBe(" 3");
    const items = [...openList(container).querySelectorAll("li")];
    expect(items.map((li) => li.textContent)).toEqual([
      "Dylan",
      "2 guests (read-only)",
      "Guest (read-only)",
    ]);
  });

  it("a read-only member keeps the read-only note next to the tabs note", () => {
    const { container } = render(
      <PresenceIndicator
        status="connected"
        clients={2}
        people={1}
        readOnly={1}
        users={[user("u1", "Vic", 2, true)]}
      />,
    );
    const items = [...openList(container).querySelectorAll("li")];
    expect(items.map((li) => li.textContent)).toEqual(["Vic read-only · 2 tabs"]);
  });

  it("without names (a share visitor's own view) it still shows the people count", () => {
    const { container } = render(<PresenceIndicator status="connected" clients={5} people={2} />);
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="presence-count"]')?.textContent).toBe("2 online");
  });
});
