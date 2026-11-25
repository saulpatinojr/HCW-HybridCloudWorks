import {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  Notice,
  requestUrl,
} from "obsidian";
import { SyncEngine } from "./engine.js";
import { vaultFiles } from "./vault-files.js";
import { decodeNote, encodeNote } from "./note-format.js";
import { brainApi } from "./brain-api.js";
import { createAuth } from "./auth.js";
import { createMsalNetworkClient } from "./auth-network.js";
import { describeError, failureText } from "./errors.js";
import { join } from "node:path";

const DEFAULTS = {
  baseUrl: "https://api-azure.hybridcloudworks.com/api",
  tenantId: "",
  clientId: "",
  audience: "",
};
const API_HOSTS = ["api-azure.hybridcloudworks.com", "hybridcloudworks.com"];
const allowedBase = (raw) => {
  const url = new URL(raw);
  // No query, #fragment, user name or password.
  const plain = ![url.search, url.hash, url.username, url.password].some(
    Boolean,
  );
  if (
    url.protocol !== "https:" ||
    !API_HOSTS.includes(url.hostname) ||
    url.pathname.replace(/\/$/, "") !== "/api" ||
    !plain
  )
    throw new Error("Use the HCW HTTPS API address.");
  return url.origin + "/api";
};
class CodeModal extends Modal {
  constructor(app, code) {
    super(app);
    this.code = code;
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Sign in to HCW Second Brain" });
    this.contentEl.createEl("p", {
      text: "Use your HCW owner account in the browser. Keep this code private.",
    });
    this.contentEl.createEl("a", {
      text: this.code.verificationUri,
      attr: {
        href: this.code.verificationUri,
        target: "_blank",
        rel: "noopener noreferrer",
      },
    });
    this.contentEl.createEl("p", {
      text: this.code.userCode,
      cls: "setting-item-name",
    });
  }
  onClose() {
    this.contentEl.empty();
  }
}
class EnrollModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.selected = new Set();
  }
  onOpen() {
    this.contentEl.createEl("h2", { text: "Choose notes to connect" });
    this.contentEl.createEl("p", {
      text: "Only selected Markdown notes are enrolled. HCW notes download into HCW/Notes; site references stay in HCW/Site. Unselected files are left alone.",
    });
    const known = new Set(
      Object.values(this.plugin.state.entries || {}).map((e) => e.path),
    );
    const candidates = this.plugin.app.vault
      .getMarkdownFiles()
      .filter((f) => !known.has(f.path) && !f.path.startsWith("HCW/"));
    const list = this.contentEl.createDiv();
    list.style.maxHeight = "320px";
    list.style.overflowY = "auto";
    const preview = this.contentEl.createEl("pre");
    preview.style.maxHeight = "180px";
    preview.style.overflow = "auto";
    preview.style.whiteSpace = "pre-wrap";
    for (const file of candidates)
      new Setting(list)
        .setName(file.path)
        .addToggle((t) =>
          t.setValue(false).onChange((value) => {
            if (value) this.selected.add(file.path);
            else this.selected.delete(file.path);
          }),
        )
        .addButton((b) =>
          b.setButtonText("Preview").onClick(async () => {
            preview.setText(
              (await this.plugin.app.vault.read(file)).slice(0, 4000),
            );
          }),
        );
    new Setting(this.contentEl).addButton((b) =>
      b
        .setButtonText("Connect selected notes")
        .setCta()
        .onClick(async () => {
          try {
            await this.plugin.connect();
            await this.plugin.engine.enroll([...this.selected]);
            this.close();
            await this.plugin.sync(true);
          } catch (error) {
            console.error(
              "HCW Second Brain: enrollment paused.",
              describeError(error),
            );
            new Notice(
              "Enrollment paused. Check settings, sign in, and retry. Original notes are retained.",
            );
          }
        }),
    );
  }
  onClose() {
    this.contentEl.empty();
  }
}
class HCWSettings extends PluginSettingTab {
  constructor(plugin) {
    super(plugin.app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "HCW Second Brain" });
    containerEl.createEl("p", {
      text: "Copy the connection values from HCW admin → Second Brain → Home. Login protects hosted data; local notes follow this computer’s and OneDrive’s permissions. Tokens are encrypted in Windows local application storage, outside this vault.",
    });
    for (const [key, label] of [
      ["baseUrl", "HCW API address"],
      ["tenantId", "Tenant ID"],
      ["clientId", "Desktop client ID"],
      ["audience", "API audience"],
    ])
      new Setting(containerEl).setName(label).addText((t) =>
        t.setValue(this.plugin.settings[key]).onChange(async (value) => {
          this.plugin.settings[key] = value.trim();
          this.plugin.engine = null;
          this.plugin.auth = null;
          await this.plugin.persist();
        }),
      );
    new Setting(containerEl)
      .setName("Owner sign-in")
      .addButton((b) =>
        b.setButtonText("Sign in").onClick(async () => {
          try {
            await this.plugin.connect();
            await this.plugin.auth.token(true);
            await this.plugin.persist();
            new Notice("Signed in. Choose notes or run Sync now.");
          } catch (error) {
            // Show and log the step and Microsoft's reason. describeError
            // hides tokens and device codes; the raw error is not logged.
            console.error(
              "HCW Second Brain: sign-in failed.",
              describeError(error),
            );
            new Notice(`Sign-in failed. ${failureText(error)}`, 20000);
          }
        }),
      )
      .addButton((b) =>
        b.setButtonText("Sign out").onClick(async () => {
          if (this.plugin.auth) await this.plugin.auth.signOut();
          await this.plugin.persist();
          this.plugin.report("Signed out. Local notes are retained.");
        }),
      );
    new Setting(containerEl)
      .setName("Enrollment preview")
      .addButton((b) =>
        b
          .setButtonText("Choose existing notes")
          .onClick(() => new EnrollModal(this.plugin).open()),
      );
    new Setting(containerEl)
      .setName("Synchronization")
      .addButton((b) =>
        b.setButtonText("Sync now").onClick(() => this.plugin.sync(true)),
      );
    const pending = Object.values(this.plugin.state.entries || {}).filter(
      (e) => e.pending || !e.version,
    ).length;
    containerEl.createEl("p", {
      text: `Last successful sync: ${this.plugin.state.lastSuccessfulSync || "Never"}. Pending operations: ${pending}. ${this.plugin.state.lastError || ""}`,
    });
  }
}

export default class HCWSecondBrainPlugin extends Plugin {
  async onload() {
    const data = await this.loadData();
    this.settings = { ...DEFAULTS, ...data?.settings };
    this.state = data?.state || { entries: {}, references: {}, cursor: 0 };
    this.state.entries ||= {};
    this.state.references ||= {};
    this.status = this.addStatusBarItem();
    this.report("HCW Second Brain: ready");
    this.addSettingTab(new HCWSettings(this));
    this.addCommand({
      id: "sync-now",
      name: "Sync now",
      callback: () => this.sync(true),
    });
    this.addCommand({
      id: "choose-notes",
      name: "Choose notes to connect",
      callback: () => new EnrollModal(this).open(),
    });
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        for (const entry of [
          ...Object.values(this.state.entries),
          ...Object.values(this.state.references),
        ]) {
          if (entry.path === oldPath) entry.path = file.path;
          else if (entry.path.startsWith(`${oldPath}/`))
            entry.path = file.path + entry.path.slice(oldPath.length);
        }
        this.persist();
      }),
    );
    // Polling hashes handles writes by Obsidian, OneDrive, or another editor.
    // One in-flight engine cycle; no token/secret or private prose in logs.
    this.registerInterval(window.setInterval(() => this.sync(false), 30000));
  }
  persist() {
    // Serialize snapshots so a delayed earlier save cannot roll back a cursor.
    const snapshot = JSON.parse(
      JSON.stringify({ settings: this.settings, state: this.state }),
    );
    this.persistence = (this.persistence || Promise.resolve())
      .catch(() => {})
      .then(() => this.saveData(snapshot));
    return this.persistence;
  }
  report(text) {
    this.status?.setText(`HCW · ${text}`);
  }
  async connect() {
    if (this.engine) return;
    const baseUrl = allowedBase(this.settings.baseUrl);
    this.auth ||= await createAuth(
      this.settings,
      (code) => {
        const modal = new CodeModal(this.app, code);
        modal.open();
        return () => modal.close();
      },
      {
        networkClient: createMsalNetworkClient(requestUrl),
        helperPath: join(
          this.app.vault.adapter.getBasePath(),
          this.manifest.dir,
          "dpapi.ps1",
        ),
      },
    );
    this.engine = new SyncEngine({
      files: {
        ...vaultFiles(this.app.vault),
        decode: (raw, path) =>
          decodeNote(raw, path, (target) => this.linkedEntry(target, path)),
        encode: encodeNote,
      },
      api: brainApi(baseUrl, () => this.auth.token()),
      state: this.state,
      persist: () => this.persist(),
      report: (message) => this.report(message),
    });
  }
  // The [id, entry] of the enrolled note a [[link]] in `path` points at.
  linkedEntry(target, path) {
    const file = this.app.metadataCache.getFirstLinkpathDest(target, path);
    return (
      file &&
      Object.entries(this.state.entries).find(([, e]) => e.path === file.path)
    );
  }
  async sync(manual) {
    if (!manual && !this.settings.accountId) return;
    try {
      await this.connect();
      const withReferences =
        manual ||
        !this.lastReferenceSync ||
        Date.now() - this.lastReferenceSync > 300000;
      await this.engine.run({ references: withReferences });
      if (withReferences) this.lastReferenceSync = Date.now();
    } catch {
      if (manual)
        new Notice(
          this.state.lastError ||
            "Sync paused. Check settings and owner sign-in. Local notes are retained.",
        );
    }
  }
}
