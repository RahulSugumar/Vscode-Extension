import { beforeEach, describe, expect, it, vi } from "vitest";

const renderRoot = vi.hoisted(() => vi.fn());
const createRoot = vi.hoisted(() => vi.fn(() => ({ render: renderRoot })));

vi.mock("react-dom/client", () => ({ default: { createRoot } }));
vi.mock("./App.tsx", () => ({ default: () => <div>App</div> }));
vi.mock("./components/AppErrorBoundary.tsx", () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("webview entrypoint", () => {
  beforeEach(() => {
    vi.resetModules();
    createRoot.mockClear();
    renderRoot.mockClear();
    document.body.innerHTML = '<div id="root"></div>';
  });

  it("mounts the React application into the root element", async () => {
    await import("./main");
    expect(createRoot).toHaveBeenCalledWith(document.getElementById("root"));
    expect(renderRoot).toHaveBeenCalledOnce();
  });
});
