import {
  Plugin,
  PluginSettingTab,
  Setting,
  Modal,
  Notice,
  TFile,
  normalizePath,
  parseYaml,
  stringifyYaml,
  requestUrl,
} from "obsidian";
import { SyncEngine } from "./engine.js";
import { createAuth } from "./auth.js";
import { createMsalNetworkClient } from "./auth-network.js";
import { join } from "node:path";

const DEFAULTS = {
  baseUrl: "https://api-azure.hybridcloudworks.com/api",
  tenantId: "",
  clientId: "",
  audience: "",
};
const allowedBase = (raw) => {
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    !["api-azure.hybridcloudworks.com", "hybridcloudworks.com"].includes(
      url.hostname,
    ) ||
    url.pathname.replace(/\/$/, "") !== "/api" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Use the HCW HTTPS API address.");
  return url.origin + "/api";
};
function frontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { properties: {}, body: raw };
  const properties = parseYaml(match[1]);
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    throw new Error("Invalid note properties. Fix them before syncing.");
  return { properties, body: raw.slice(match[0].length) };
}
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
          } catch {
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
          } catch {
            new Notice(
              "Sign-in failed. Check the tenant, desktop client, and brain_sync permission.",
            );
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
    const vault = this.app.vault;
    const ensure = async (path) => {
      const parts = normalizePath(path).split("/");
      parts.pop();
      let folder = "";
      for (const part of parts) {
        folder = folder ? `${folder}/${part}` : part;
        if (!vault.getAbstractFileByPath(folder)) {
          try {
            await vault.createFolder(folder);
          } catch {
            if (!vault.getAbstractFileByPath(folder))
              throw new Error("Could not create sync folder.");
          }
        }
      }
    };
    const read = async (path) => {
      const file = vault.getAbstractFileByPath(path);
      return file instanceof TFile ? vault.read(file) : null;
    };
    const compareAndWrite = async (path, expected, value) => {
      await ensure(path);
      const file = vault.getAbstractFileByPath(path);
      if (!file) {
        if (expected !== null)
          throw new Error("The note moved during sync. Retry.");
        await vault.create(path, value);
      } else if (file instanceof TFile)
        await vault.process(file, (current) => {
          if (current !== expected)
            throw new Error("The note changed during sync. Retry.");
          return value;
        });
      else throw new Error("A folder is using the note path.");
    };
    const decode = (raw, path) => {
      const { properties: p, body } = frontmatter(raw || "");
      const list = (v) =>
        Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
      const links = new Set(list(p.hcw_links));
      for (const match of body.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)) {
        const file = this.app.metadataCache.getFirstLinkpathDest(
          match[1],
          path,
        );
        const found =
          file &&
          Object.entries(this.state.entries).find(
            ([, e]) => e.path === file.path,
          );
        if (found) links.add(found[0]);
      }
      const properties = Object.fromEntries(
        Object.entries(p).filter(
          ([key]) =>
            !key.startsWith("hcw_") && !["title", "tags"].includes(key),
        ),
      );
      return {
        type: ["note", "topic", "project", "conflict"].includes(p.hcw_type)
          ? p.hcw_type
          : "note",
        title:
          typeof p.title === "string"
            ? p.title
            : path.split("/").at(-1)?.replace(/\.md$/, "") || "Untitled",
        body,
        properties,
        tags: list(p.tags),
        links: [...links],
        collections: list(p.hcw_collections),
        urls: list(p.hcw_urls),
        archived: p.hcw_archived === true,
        inbox: p.hcw_inbox !== false,
      };
    };
    const encode = (item, previous) => {
      const { properties } = frontmatter(previous);
      const p = {
        ...properties,
        ...item.properties,
        title: item.title,
        tags: item.tags || [],
        hcw_id: item.id,
        hcw_type: item.type,
        hcw_links: item.links || [],
        hcw_collections: item.collections || [],
        hcw_urls: item.urls || [],
        hcw_archived: item.archived === true,
        hcw_inbox: item.inbox !== false,
      };
      if (item.href) p.hcw_source = `https://hybridcloudworks.com${item.href}`;
      if (item.type === "reference")
        p.hcw_reference_truncated = item.truncated === true;
      return `---\n${stringifyYaml(p).trimEnd()}\n---\n${item.body}`;
    };
    const call = async (action, method = "GET", body) => {
      const token = await this.auth.token();
      const response = await requestUrl({
        url: `${baseUrl}/cms/brain/${action}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body && { body: JSON.stringify(body) }),
        throw: false,
      });
      if (response.status >= 400)
        throw Object.assign(new Error("HCW sync request failed."), {
          status: response.status,
          details: response.json,
        });
      return response.json;
    };
    this.engine = new SyncEngine({
      files: {
        read,
        decode,
        encode,
        compareAndWrite,
        create: async (path, value) => {
          await ensure(path);
          await vault.create(path, value);
        },
        trashIfUnchanged: async (path, expected) => {
          const file = vault.getAbstractFileByPath(path);
          if (!(file instanceof TFile) || (await vault.read(file)) !== expected)
            throw new Error("The note changed before archiving. Retry.");
          // Vault trash preserves recovery. An active editor is never replaced
          // by a raw filesystem unlink.
          await vault.trash(file, false);
        },
      },
      api: {
        push: (body) => call("sync", "POST", body),
        pull: (cursor) => call(`sync?cursor=${cursor}`),
        references: (cursor) =>
          call(
            `sync-references${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        status: (body) => call("sync-status", "POST", body),
      },
      state: this.state,
      persist: () => this.persist(),
      report: (message) => this.report(message),
    });
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
