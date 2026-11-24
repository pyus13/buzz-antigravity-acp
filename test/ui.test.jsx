// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readConfig } from "../src/config.js";
import { Runtime } from "../src/runtime/runtime.js";
import { ActivityTab } from "../src/ui/activity.jsx";
import { Button } from "../src/ui/controls.jsx";
import { CreateAction, CreateConfiguration } from "../src/ui/create.jsx";
import { DefaultControl, ProviderDialogBody } from "../src/ui/provider.jsx";
import { bindReact, Fragment, h } from "../src/ui/react.js";
import { Select } from "../src/ui/select.jsx";
import { bindServices } from "../src/ui/services.js";
import { SettingsTab } from "../src/ui/settings.jsx";
import { fakeAgents } from "./fake-buzz.js";
import { fakeGemini, fakeHostFor } from "./fake-gemini.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
bindReact(React);
void Fragment;

let root;
let container;
let runtime;
let agents;
const opened = [];

let gemini;
function services({ signedIn = true, Transcript } = {}) {
  gemini = fakeGemini();
  gemini.state.signedIn = signedIn;
  agents = fakeAgents();
  if (Transcript) agents.ui = { Transcript };
  runtime = new Runtime({ agents, host: fakeHostFor(gemini), typeKey: "local.gemini-acp/gemini-acp" });
  bindServices({ runtime, agents, openSetup: () => opened.push("setup") });
}

const render = async (element) => {
  await act(async () => root.render(element));
};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));
const press = (element, key) =>
  act(async () => element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
const comboboxes = () => [...container.querySelectorAll('[role="combobox"]')];
const named = (label) => comboboxes().find((element) => element.getAttribute("aria-label") === label);

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Element.prototype.scrollIntoView = () => {};
  opened.length = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  runtime?.dispose();
});

describe("Select", () => {
  const options = [
    { value: "thread", label: "One session per thread" },
    { value: "channel", label: "One session per channel", description: "Shared" },
  ];

  it("opens, moves with the keyboard, chooses and returns focus", async () => {
    const onValueChange = vi.fn();
    await render(<Select label="Sessions" value="thread" options={options} onValueChange={onValueChange} />);
    const trigger = named("Sessions");
    await act(async () => trigger.click());
    await settle();
    const list = container.querySelector('[role="listbox"]');
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(list);
    expect(list.querySelector("[data-highlighted]").textContent).toContain("thread");
    await press(list, "ArrowDown");
    await press(list, "Enter");
    expect(onValueChange).toHaveBeenCalledWith("channel");
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("names options and links their descriptions", async () => {
    await render(<Select label="Sessions" value="thread" options={options} onValueChange={() => {}} />);
    const option = container.querySelectorAll('[role="option"]')[1];
    expect(option.getAttribute("aria-label")).toBe("One session per channel");
    expect(document.getElementById(option.getAttribute("aria-describedby")).textContent).toBe("Shared");
  });

  it("closes only itself on Escape and on a press outside the list", async () => {
    const dialogEscape = vi.fn();
    const dialogPress = vi.fn();
    document.addEventListener("keydown", dialogEscape);
    container.addEventListener("pointerdown", dialogPress);
    await render(<Select label="Sessions" value="thread" options={options} onValueChange={() => {}} />);
    const trigger = named("Sessions");
    await act(async () => trigger.click());
    await settle();
    await press(container.querySelector('[role="listbox"]'), "Escape");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(dialogEscape).not.toHaveBeenCalled();
    await act(async () => trigger.click());
    await settle();
    const layer = container.querySelector("[popover]");
    await act(async () => layer.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The press landed inside the dialog's DOM, so the dialog saw no outside press.
    expect(container.contains(layer)).toBe(true);
    document.removeEventListener("keydown", dialogEscape);
  });

  it("ignores clicks while closing", async () => {
    const onValueChange = vi.fn();
    await render(<Select label="Sessions" value="thread" options={options} onValueChange={onValueChange} />);
    await act(async () => named("Sessions").click());
    await settle();
    const [, second] = container.querySelectorAll('[role="option"]');
    await act(async () => second.click());
    await act(async () => second.click());
    expect(onValueChange).toHaveBeenCalledTimes(1);
  });
});

describe("Button", () => {
  it("shows the spinner and stays focusable while loading", async () => {
    const onClick = vi.fn();
    await render(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );
    const button = container.querySelector("button");
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.querySelector(".buzz-button-spinner")).not.toBeNull();
    await act(async () => button.click());
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("SettingsTab", () => {
  const agentWith = (config, configBase = { settings: "rev1" }) => ({ key: "agent-1", type: "t", config, configBase });

  it("saves the normalised draft against the agent's base", async () => {
    services();
    const save = vi.fn(async () => {});
    await render(<SettingsTab agent={agentWith(readConfig({}))} save={save} settingsSection="runtime" />);
    await settle();
    const input = container.querySelector("input.buzz-input");
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    await act(async () => {
      setValue.call(input, "  ~/code  ");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => container.querySelector('button[type="submit"]').click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ workspace: "~/code" }), { base: { settings: "rev1" } });
  });

  it("takes saves made elsewhere into fields not edited here", async () => {
    services();
    const save = vi.fn(async () => {});
    const first = readConfig({ instructions: "old" });
    await render(<SettingsTab agent={agentWith(first)} save={save} settingsSection="identity" />);
    await settle();
    const textarea = container.querySelector("textarea");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    await act(async () => {
      setValue.call(textarea, "mine");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Another device changed the model.
    await render(<SettingsTab agent={agentWith({ ...first, model: "gemini-2.5-flash" }, { settings: "rev2" })} save={save} settingsSection="identity" />);
    await settle();
    await act(async () => container.querySelector('button[type="submit"]').click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ instructions: "mine", model: "gemini-2.5-flash" }), { base: { settings: "rev2" } });
  });

  it("makes a field changed here and elsewhere a conflict, and holds Save until it's resolved", async () => {
    services();
    const save = vi.fn(async () => {});
    const first = readConfig({ instructions: "old" });
    await render(<SettingsTab agent={agentWith(first)} save={save} settingsSection="identity" />);
    await settle();
    const textarea = container.querySelector("textarea");
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    await act(async () => {
      setValue.call(textarea, "mine");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await render(<SettingsTab agent={agentWith({ ...first, instructions: "theirs" }, { settings: "rev2" })} save={save} settingsSection="identity" />);
    await settle();
    expect(container.textContent).toContain("Instructions changed elsewhere");
    expect(container.textContent).toContain("Latest: theirs");
    const submit = container.querySelector('button[type="submit"]');
    expect(submit.getAttribute("aria-disabled")).toBe("true");
    await act(async () => submit.click());
    expect(save).not.toHaveBeenCalled();
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Keep mine").click());
    await act(async () => container.querySelector('button[type="submit"]').click());
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ instructions: "mine" }), { base: { settings: "rev2" } });
  });

  it("holds Save while Buzz can't read the agent's config", async () => {
    services();
    await render(<SettingsTab agent={{ ...agentWith(readConfig({ workspace: "~/a" })), configProblem: "Unavailable" }} save={async () => {}} settingsSection="runtime" />);
    expect(container.textContent).toContain("Your edits stay in this form");
  });

  it("shows Save only while there is something to save", async () => {
    services();
    await render(<SettingsTab agent={agentWith(readConfig({}))} save={async () => {}} settingsSection="runtime" />);
    expect(container.querySelector('button[type="submit"]')).toBeNull();
  });
});

describe("New agent", () => {
  it("groups Harness, Model and Thinking and is ready once models are read", async () => {
    services();
    const ready = vi.fn();
    await render(
      <CreateConfiguration
        config={readConfig({})}
        onChange={() => {}}
        disabled={false}
        onReadyChange={ready}
        harnessControl={<div id="harness">Harness</div>}
      />,
    );
    await settle();
    await settle();
    expect(container.querySelector(".buzz-settings-group #harness")).not.toBeNull();
    expect(named("Model").textContent).toContain("Auto (Gemini 3)");
    expect(ready).toHaveBeenLastCalledWith(true);
  });

  it("holds creation until Gemini is signed in", async () => {
    services({ signedIn: false });
    const ready = vi.fn();
    await render(<CreateConfiguration config={readConfig({})} onChange={() => {}} disabled={false} onReadyChange={ready} harnessControl={null} />);
    await settle();
    await settle();
    expect(ready).toHaveBeenLastCalledWith(false);
    // Set up beside Harness is the way on; nothing here crowds the row.
    expect(named("Model").textContent).toContain("Not signed in");
    expect(named("Model").disabled).toBe(true);
    expect(container.textContent).not.toContain("Try again");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("offers Set up beside Harness only while Gemini isn't signed in", async () => {
    services({ signedIn: false });
    await render(<CreateAction disabled={false} />);
    await settle();
    await settle();
    const setUp = [...container.querySelectorAll("button")].find((button) => button.textContent === "Set up");
    expect(setUp.getAttribute("aria-label")).toBe("Sign in to Gemini");
    await act(async () => setUp.click());
    expect(opened).toEqual(["setup"]);
  });
});

describe("Agent setup", () => {
  it("says how Gemini is signed in", async () => {
    services();
    await render(<ProviderDialogBody onClose={() => {}} />);
    await settle();
    await settle();
    expect(container.textContent).toContain("Signed in with your Google account (me@example.com).");
    expect(container.textContent).toContain("Done");
  });

  it("signs in with Google when signed out", async () => {
    services({ signedIn: false });
    await render(<ProviderDialogBody onClose={() => {}} />);
    await settle();
    await settle();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent.includes("Check again"))).toBe(true);
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent.includes("Sign in with Google")).click());
    await settle();
    await settle();
    expect(gemini.state.calls.some((call) => call.method === "authenticate")).toBe(true);
    expect(container.textContent).toContain("Signed in with your Google account");
  });

  it("saves a default model and keeps the way back to the dialog", async () => {
    services();
    const onConfigure = vi.fn();
    await render(<DefaultControl onConfigure={onConfigure} />);
    await settle();
    await settle();
    await act(async () => named("Gemini (ACP) default model").click());
    await settle();
    const flash = [...container.querySelectorAll('[role="option"]')].find((option) => option.textContent.includes("Flash"));
    await act(async () => flash.click());
    await settle();
    expect(runtime.defaults.snapshot().model).toBe("gemini-2.5-flash");
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent === "Edit configuration").click());
    expect(onConfigure).toHaveBeenCalled();
  });
});

describe("Activity", () => {
  it("lists the agent's conversations and shows one's transcript in Buzz's view", async () => {
    const Transcript = vi.fn(({ read, readKey }) => {
      const [turns, setTurns] = React.useState();
      React.useEffect(() => void read(new AbortController().signal).then((value) => setTurns(value?.turns)), [readKey]);
      return <div id="transcript">{turns ? `${turns.length} turn` : "reading"}</div>;
    });
    services({ Transcript });
    const { mention } = await import("./fake-buzz.js");
    const message = mention("hello", { root: "t" });
    await runtime.run(message.delivery);
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
    await message.done();
    await render(<ActivityTab agent={{ key: "agent-1", name: "Tester" }} conversation={{ channelId: "c1", rootId: "t" }} />);
    expect(container.textContent).toContain("This thread");
    expect(container.textContent).toContain("#general");
    await act(async () => container.querySelector('button[aria-label="View transcript: #general"]').click());
    await settle();
    expect(container.querySelector("#transcript").textContent).toBe("1 turn");
    expect(Transcript.mock.calls.at(-1)[0]).toMatchObject({ readKey: "agent-1:c1/t", working: false });
    await act(async () => [...container.querySelectorAll("button")].find((b) => b.textContent.includes("Back to profile")).click());
    expect(container.textContent).toContain("Recent conversations");
  });

  it("says when there is no session here yet", async () => {
    services();
    await render(<ActivityTab agent={{ key: "agent-1" }} conversation={{ channelId: "c9" }} />);
    expect(container.textContent).toContain("No Gemini session here yet");
  });
});

void h;
