import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import SessionsPage from "./SessionsPage";

describe("SessionsPage", () => {
  it("renders its current coming-soon state", () => {
    render(<SessionsPage />);
    expect(screen.getByText("Comming Soon")).toBeInTheDocument();
  });
});
