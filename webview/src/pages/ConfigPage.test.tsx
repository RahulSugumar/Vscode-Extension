import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { configuredRuntime } from "../test/fixtures";

const storeMock = vi.hoisted(() => ({ useConfigStore: vi.fn() }));
vi.mock("../state/configStore", () => storeMock);

import ConfigPage from "./ConfigPage";

const save = vi.fn();
const loadModels = vi.fn();
let state: any;

beforeEach(() => {
  save.mockReset();
  loadModels.mockReset();
  save.mockResolvedValue(true);
  loadModels.mockResolvedValue(undefined);
  state = {
    config: null,
    status: "missing",
    error: null,
    save,
    models: [],
    modelsStatus: "idle",
    modelsError: null,
    loadModels,
  };
  storeMock.useConfigStore.mockImplementation(() => state);
});

describe("ConfigPage", () => {
  it("starts local graph creation without showing optional configuration fields", async () => {
    const user = userEvent.setup();
    render(<ConfigPage />);
    expect(screen.getByRole("heading", { name: "Project Assistant" })).toBeInTheDocument();
    expect(screen.getByText("Visualize your codebase as an interactive graph and chat with Project Assistant.")).toBeInTheDocument();
    expect(screen.queryByLabelText(/Neo4j URI/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI API Key/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Start Creating Graph" }));
    expect(screen.queryByText(/Missing:/)).not.toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ openAiApiKey: "", neo4jPassword: "" }),
      { deferBackendStart: true },
    );
  });

  it("validates the remaining required model field", async () => {
    const user = userEvent.setup();
    render(<ConfigPage mode="settings" />);
    await user.clear(screen.getByLabelText("Agent Model"));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Missing: Agent model")).toBeInTheDocument();
  });

  it("switches to local defaults and submits a complete form", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    render(<ConfigPage mode="settings" onSaved={onSaved} />);
    await user.selectOptions(screen.getByLabelText("LLM Provider"), "local");
    expect(screen.getByLabelText("Agent Model")).toHaveValue("local-deterministic");
    expect(screen.getByLabelText("Agent Model")).toBeDisabled();
    expect(screen.getByLabelText(/OpenAI API Key/)).toBeDisabled();
    await user.type(screen.getByLabelText(/Neo4j Password/), "neo-secret");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        llmProvider: "local",
        llmModel: "local-deterministic",
        neo4jPassword: "neo-secret",
      }),
      { deferBackendStart: false },
    );
    expect(onSaved).toHaveBeenCalledWith({ neo4jConfigChanged: true });
  });

  it("does not mark an LLM-only save as a Neo4j configuration change", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    state.config = configuredRuntime;
    render(<ConfigPage mode="settings" onSaved={onSaved} />);
    const model = screen.getByLabelText("Agent Model");
    await user.clear(model);
    await user.type(model, "gpt-updated");
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSaved).toHaveBeenCalledWith({ neo4jConfigChanged: false });
  });

  it("restores the OpenAI default after changing back from local", async () => {
    const user = userEvent.setup();
    render(<ConfigPage mode="settings" />);
    await user.selectOptions(screen.getByLabelText("LLM Provider"), "local");
    await user.selectOptions(screen.getByLabelText("LLM Provider"), "openai");
    expect(screen.getByLabelText("Agent Model")).toHaveValue("gpt-4o-mini");
  });

  it("keeps stored secrets out of inputs and automatically loads models", async () => {
    state.config = {
      ...configuredRuntime,
    };
    render(<ConfigPage mode="settings" />);
    await waitFor(() => expect(screen.getByLabelText(/OpenAI API Key/)).toHaveValue(""));
    expect(screen.getByLabelText(/OpenAI API Key/)).toHaveAttribute("placeholder", "••••••••");
    expect(screen.getByLabelText(/Neo4j Password/)).toHaveValue("");
    expect(screen.getByLabelText(/Neo4j Password/)).toHaveAttribute("placeholder", "••••••••");
    expect(screen.queryByText(/\(Optional\)/)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Project Assistant" })).not.toBeInTheDocument();
    expect(loadModels).toHaveBeenCalledWith();
  });

  it("marks stored secrets for removal without exposing their values", async () => {
    const user = userEvent.setup();
    state.config = configuredRuntime;
    render(<ConfigPage mode="settings" />);
    await user.click(screen.getByRole("button", { name: "Remove API key" }));
    await user.click(screen.getByRole("button", { name: "Remove Neo4j password" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        openAiApiKey: "",
        clearOpenAiApiKey: true,
        neo4jPassword: "",
        clearNeo4jPassword: true,
      }),
      { deferBackendStart: false },
    );
  });

  it("refreshes model choices with a trimmed typed API key", async () => {
    const user = userEvent.setup();
    state.config = { ...configuredRuntime, hasOpenAiApiKey: false };
    state.models = [{ id: "gpt-a" }, { id: "gpt-b" }];
    state.modelsStatus = "ready";
    render(<ConfigPage mode="settings" />);
    await user.type(screen.getByLabelText(/OpenAI API Key/), "  typed-key  ");
    await user.click(screen.getByRole("button", { name: "Refresh OpenAI models" }));
    expect(loadModels).toHaveBeenCalledWith("typed-key");
    expect(document.querySelector('option[value="gpt-a"]')).toBeInTheDocument();
  });

  it("does not call onSaved when the store rejects the save", async () => {
    const user = userEvent.setup();
    const onSaved = vi.fn();
    state.config = configuredRuntime;
    save.mockResolvedValue(false);
    render(<ConfigPage onSaved={onSaved} />);
    await user.click(screen.getByRole("button", { name: "Start Creating Graph" }));
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining(configuredRuntime.values),
      { deferBackendStart: true },
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("shows save and model errors only after the appropriate trigger", async () => {
    const user = userEvent.setup();
    state.config = configuredRuntime;
    state.error = "Save failed";
    state.modelsError = "Models failed";
    state.modelsStatus = "error";
    save.mockResolvedValue(false);
    render(<ConfigPage mode="settings" />);
    expect(screen.getByText("Models failed")).toBeInTheDocument();
    expect(screen.queryByText("Save failed")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText("Save failed")).toBeInTheDocument();
  });

  it("locks the form and shows progress while saving", () => {
    state.status = "saving";
    render(<ConfigPage />);
    expect(screen.getByRole("button", { name: "Starting..." })).toBeDisabled();
    expect(screen.queryByLabelText(/Neo4j URI/)).not.toBeInTheDocument();
  });

  it("keeps the saving label in the settings panel", () => {
    state.status = "saving";
    render(<ConfigPage mode="settings" />);
    expect(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
    expect(screen.getByLabelText(/Neo4j URI/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh OpenAI models" })).toBeDisabled();
  });
});
