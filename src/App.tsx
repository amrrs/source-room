import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Download,
  FileText,
  Globe2,
  Layers3,
  LoaderCircle,
  Menu,
  MessageSquare,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, json, streamChat } from "./api";
import type { Config, Message, Reference, Settings, Source } from "./types";

const shortModel = (id: string) => id.split("/").pop() || id;
const parseDomains = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
function Modal({
  open,
  close,
  title,
  children,
  drawer = false,
}: {
  open: boolean;
  close: () => void;
  title: string;
  children: ReactNode;
  drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !ref.current?.open) ref.current?.showModal();
    else if (!open && ref.current?.open) ref.current.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={drawer ? "modal drawer" : "modal"}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal-head">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label={`Close ${title}`}
          onClick={close}
        >
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={checked}
      disabled={disabled}
      className={`switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function App() {
  const [config, setConfig] = useState<Config>();
  const [settings, setSettings] = useState<Settings>();
  const [sources, setSources] = useState<Source[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [question, setQuestion] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState("");
  const [status, setStatus] = useState("");
  const [controls, setControls] = useState(false);
  const [sourceModal, setSourceModal] = useState(false);
  const [sourceTab, setSourceTab] = useState<"pdf" | "website">("pdf");
  const [mobileSources, setMobileSources] = useState(false);
  const [help, setHelp] = useState(false);
  const [url, setUrl] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [password, setPassword] = useState("");
  const [catalogStatus, setCatalogStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState<number>();
  const [dragging, setDragging] = useState(false);
  const [focusedRef, setFocusedRef] = useState<Reference>();
  const fileRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const chatBottom = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const working = busy || !!uploading;

  async function loadWorkspace(initial = false) {
    const data = await api<{ sources: Source[]; messages: Message[] }>(
      "/workspace",
    );
    setSources(data.sources);
    setMessages(data.messages);
    setSelected((prev) =>
      initial
        ? data.sources.map((s) => s.id)
        : prev.filter((id) => data.sources.some((s) => s.id === id)),
    );
    if (data.sources.length)
      setSettings((s) =>
        s ? { ...s, embedding_model: data.sources[0].model } : s,
      );
  }
  async function initialize() {
    try {
      const cfg = await api<Config>("/config");
      setConfig(cfg);
      let saved: Partial<Settings> = {};
      try {
        saved = JSON.parse(
          localStorage.getItem("source-room-settings") || "{}",
        );
      } catch {
        /* Ignore invalid local preferences. */
      }
      const options = { ...cfg.defaults, ...saved };
      setSettings(options);
      setInclude(options.include_domains.join(", "));
      setExclude(options.exclude_domains.join(", "));
      if (!cfg.auth_required) await loadWorkspace(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void initialize();
  }, []);
  useEffect(() => {
    if (settings)
      localStorage.setItem("source-room-settings", JSON.stringify(settings));
  }, [settings]);
  useEffect(() => {
    chatBottom.current?.scrollIntoView({ behavior: "instant", block: "end" });
  }, [messages, status]);
  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setSettings((s) => (s ? { ...s, [key]: value } : s));
  }
  function options() {
    return {
      ...settings!,
      include_domains: parseDomains(include),
      exclude_domains: parseDomains(exclude),
    };
  }
  function commitDomains() {
    setSettings(options());
  }
  function showAdd(tab: "pdf" | "website") {
    setSourceTab(tab);
    setSourceModal(true);
    setError("");
  }

  async function upload(files: FileList | File[] | null) {
    if (!files || working || !settings) return;
    setError("");
    commitDomains();
    for (const file of Array.from(files)) {
      if (!file.name.toLowerCase().endsWith(".pdf")) {
        setError("Choose PDF files. Websites can be added with a URL.");
        break;
      }
      if (file.size > 20 * 1024 * 1024) {
        setError(`${file.name} is too large. Maximum size is 20 MB.`);
        break;
      }
      setUploading(file.name);
      const form = new FormData();
      form.append("file", file);
      form.append("settings", JSON.stringify(options()));
      try {
        const source = await api<Source>("/sources/pdf", {
          method: "POST",
          body: form,
        });
        setSources((prev) => [...prev, source]);
        setSelected((prev) => [...prev, source.id]);
        setSourceModal(false);
      } catch (e) {
        setError((e as Error).message);
        break;
      }
    }
    setUploading("");
    if (fileRef.current) fileRef.current.value = "";
  }
  async function addWebsite(e: React.FormEvent) {
    e.preventDefault();
    if (working) return;
    setError("");
    setUploading(url);
    commitDomains();
    try {
      const source = await api<Source>(
        "/sources/website",
        json({ url, settings: options() }),
      );
      setSources((prev) => [...prev, source]);
      setSelected((prev) => [...prev, source.id]);
      setUrl("");
      setSourceModal(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading("");
    }
  }
  async function removeSource(id: string) {
    try {
      await api("/sources/" + id, { method: "DELETE" });
      setSources((prev) => prev.filter((s) => s.id !== id));
      setSelected((prev) => prev.filter((x) => x !== id));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function newChat() {
    try {
      await api("/messages", { method: "DELETE" });
      setMessages([]);
      setQuestion("");
      setError("");
      setMobileSources(false);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (!question.trim() || working || !settings) return;
    const prompt = question.trim();
    setError("");
    setBusy(true);
    setQuestion("");
    commitDomains();
    const next: Message[] = [
      ...messages,
      { role: "user", content: prompt },
      {
        role: "assistant",
        content: "",
        sources: [],
        model: settings.chat_model,
      },
    ];
    setMessages(next);
    setStatus("Preparing your question…");
    const controller = new AbortController();
    abortRef.current = controller;
    const modify = (fn: (message: Message) => Message) =>
      setMessages((prev) =>
        prev.map((m, i) => (i === prev.length - 1 ? fn(m) : m)),
      );
    try {
      await streamChat(
        { question: prompt, source_ids: selected, settings: options() },
        controller.signal,
        (event) => {
          if (event.type === "status") setStatus(event.message as string);
          if (event.type === "sources")
            modify((m) => ({
              ...m,
              sources: event.sources as Reference[],
              warnings: event.warnings as string[],
            }));
          if (event.type === "token") {
            setStatus("");
            modify((m) => ({ ...m, content: m.content + event.text }));
          }
          if (event.type === "done")
            modify((m) => ({ ...m, warnings: event.warnings as string[] }));
        },
      );
    } catch (e) {
      const text =
        (e as Error).name === "AbortError"
          ? "Stopped. This partial answer is not saved."
          : (e as Error).message;
      modify((m) => ({ ...m, error: text }));
      setQuestion(prompt);
    } finally {
      setBusy(false);
      setStatus("");
    }
  }
  async function refreshCatalog() {
    setRefreshing(true);
    setCatalogStatus("");
    try {
      const data = await api<{ models: { id: string; type: string }[] }>(
        "/models",
      );
      const embeds = data.models
        .filter((m) =>
          /embed|bge|e5-|gte|jina.*embedding/i.test(m.type + " " + m.id),
        )
        .map((m) => m.id);
      const chats = data.models
        .filter(
          (m) =>
            !embeds.includes(m.id) &&
            !/rerank|text2image|text-to-image|flux|stable-diffusion|whisper/i.test(
              m.type + " " + m.id,
            ),
        )
        .map((m) => m.id);
      setConfig((c) =>
        c
          ? {
              ...c,
              chat_models: chats,
              embedding_models: embeds.length ? embeds : c.embedding_models,
            }
          : c,
      );
      setCatalogStatus(
        `${data.models.length} models returned. Exact model IDs are also supported below. Capability labels may be incomplete.`,
      );
    } catch (e) {
      setCatalogStatus((e as Error).message);
    } finally {
      setRefreshing(false);
    }
  }
  function exportChat() {
    const text = messages
      .map(
        (m) =>
          `## ${m.role === "user" ? "You" : "Source Room"}\n\n${m.content}\n\n${m.sources?.map((s) => `[${s.id}] ${s.title}${s.page ? ` · page ${s.page}` : ""}${s.url ? ` — ${s.url}` : ""}`).join("\n") || ""}${m.warnings?.length ? "\n\n" + m.warnings.join("\n") : ""}${m.error ? "\n\n" + m.error : ""}`,
      )
      .join("\n\n");
    const link = document.createElement("a"),
      href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    link.href = href;
    link.download = "source-room-conversation.md";
    link.click();
    URL.revokeObjectURL(href);
  }
  async function copy(text: string, index: number) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      window.setTimeout(() => setCopied(undefined), 2000);
    } catch {
      setError(
        "Clipboard unavailable. Select and copy the answer text instead.",
      );
    }
  }
  const disabled =
    !config?.nebius_configured ||
    (settings?.web_search && !config?.tavily_configured) ||
    (!selected.length && !settings?.web_search);

  if (!config || !settings)
    return (
      <div className="boot">
        <Layers3 size={36} />
        <h1>Source Room</h1>
        {error ? (
          <>
            <p role="alert">{error}</p>
            <button onClick={initialize}>Try again</button>
          </>
        ) : (
          <p>Opening your workspace…</p>
        )}
      </div>
    );
  const sidebar = (
    <>
      <div className="sidebar-top">
        <span className="eyebrow">YOUR WORKSPACE</span>
        <button
          className="icon-button mobile-only"
          aria-label="Close sources"
          onClick={() => setMobileSources(false)}
        >
          <X size={20} />
        </button>
      </div>
      <button className="new-chat" disabled={working} onClick={newChat}>
        <Plus size={18} />
        New conversation
      </button>
      <div className="source-heading">
        <h2>
          Sources <span>{sources.length}</span>
        </h2>
        <button
          className="icon-button"
          aria-label="Add source"
          onClick={() => showAdd("pdf")}
          disabled={working}
        >
          <Plus size={19} />
        </button>
      </div>
      <p className="sidebar-hint">Choose what goes into your answer.</p>
      {sources.length > 0 && (
        <label className="select-all">
          <input
            type="checkbox"
            checked={selected.length === sources.length}
            disabled={working}
            onChange={(e) =>
              setSelected(e.target.checked ? sources.map((s) => s.id) : [])
            }
          />
          Select all sources
          <span>
            {selected.length}/{sources.length}
          </span>
        </label>
      )}
      <div className="source-list">
        {sources.map((source) => (
          <div
            className={`source-row ${selected.includes(source.id) ? "selected" : ""}`}
            key={source.id}
          >
            <label>
              <input
                type="checkbox"
                disabled={working}
                checked={selected.includes(source.id)}
                onChange={(e) =>
                  setSelected((prev) =>
                    e.target.checked
                      ? [...prev, source.id]
                      : prev.filter((id) => id !== source.id),
                  )
                }
              />
              {source.kind === "pdf" ? (
                <FileText size={20} />
              ) : (
                <Globe2 size={20} />
              )}
              <span>
                <strong title={source.name}>{source.name}</strong>
                <small>
                  {source.kind === "pdf" ? `${source.pages} pages` : "Website"}{" "}
                  · {source.chunks} chunks
                </small>
              </span>
            </label>
            <button
              className="icon-button delete-source"
              aria-label={`Remove ${source.name}`}
              disabled={working}
              onClick={() => removeSource(source.id)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {!sources.length && (
          <div
            className={`dropzone ${dragging ? "dragging" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              void upload(e.dataTransfer.files);
            }}
          >
            <div className="upload-symbol">
              <Upload size={23} />
            </div>
            <strong>Bring your own context</strong>
            <p>
              Drop PDFs here, or add a<br />
              website to start exploring.
            </p>
            <button
              className="light-button"
              disabled={working}
              onClick={() => showAdd("pdf")}
            >
              <Plus size={16} />
              Add sources
            </button>
            <small>PDF · Up to 20 MB each</small>
          </div>
        )}
        {!!sources.length && (
          <button
            className="add-more"
            disabled={working}
            onClick={() => showAdd("pdf")}
          >
            <Plus size={16} />
            Add sources
          </button>
        )}
      </div>
      {uploading && (
        <div className="upload-progress" role="status">
          <LoaderCircle className="spin" size={17} />
          <span>Indexing {uploading}…</span>
        </div>
      )}
      <div className="sidebar-bottom">
        <div className="web-switch">
          <div>
            <Globe2 size={19} />
            <strong>Search the web</strong>
          </div>
          <Toggle
            label="Search the web"
            checked={settings.web_search}
            onChange={(v) => update("web_search", v)}
            disabled={working}
          />
        </div>
        <p>Add fresh context with Tavily.</p>
        <div className="privacy-note">
          <ShieldCheck size={15} />
          <span>Sources stay in this browser’s workspace.</span>
        </div>
      </div>
    </>
  );
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-icon">
            <Layers3 size={24} />
          </span>
          <span>
            source room<span className="brand-separator">/</span>
            <small>
              with <b>nebius</b>
            </small>
          </span>
        </div>
        <button className="help-button" onClick={() => setHelp(true)}>
          <CircleHelp size={17} />
          <span>Quick guide</span>
        </button>
      </header>
      <div className="workspace">
        <aside className="sidebar">{sidebar}</aside>
        <main className="main-panel">
          <header className="workspace-header">
            <div className="workspace-title">
              <button
                className="icon-button mobile-only"
                aria-label="Open sources"
                onClick={() => setMobileSources(true)}
              >
                <Menu size={20} />
              </button>
              <MessageSquare size={18} />
              <h1>Research chat</h1>
              <span className="workspace-label">Personal workspace</span>
            </div>
            <div className="header-actions">
              {!!messages.length && (
                <button
                  className="icon-button"
                  aria-label="Export conversation"
                  onClick={exportChat}
                  disabled={busy}
                >
                  <Download size={18} />
                </button>
              )}
              <button
                className={`controls-button ${controls ? "active" : ""}`}
                onClick={() => setControls(true)}
              >
                <Settings2 size={16} />
                <span>Advanced controls</span>
              </button>
            </div>
          </header>
          {(!config.nebius_configured || !config.tavily_configured) && (
            <div className="setup-banner">
              <span>
                <span className="setup-dot" />
                Setup needed:{" "}
                {!config.nebius_configured ? "Nebius API key" : ""}
                {!config.nebius_configured && !config.tavily_configured
                  ? " + "
                  : ""}
                {!config.tavily_configured ? "Tavily API key" : ""}
              </span>
              <button onClick={() => setHelp(true)}>
                Connect providers <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          {error && !sourceModal && (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <button
                aria-label="Dismiss error"
                className="icon-button"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className={`chat-scroll ${!messages.length ? "is-empty" : ""}`}>
            {!messages.length ? (
              <div className="empty-state">
                <div className="intro-kicker">
                  <span />
                  FROM INFORMATION TO UNDERSTANDING
                </div>
                <h2>
                  Your sources.
                  <br />
                  <span>A clearer answer.</span>
                </h2>
                <p>
                  Ask questions across your PDFs and the web.
                  <br className="desktop-break" /> Follow every answer back to
                  its source.
                </p>
                <div className="starter-actions">
                  <button disabled={working} onClick={() => showAdd("pdf")}>
                    <span className="starter-icon">
                      <FileText size={23} />
                    </span>
                    <span>
                      <strong>Upload a PDF</strong>
                      <small>Reports, papers, documents</small>
                    </span>
                    <ArrowUpRight size={18} />
                  </button>
                  <button disabled={working} onClick={() => showAdd("website")}>
                    <span className="starter-icon mint">
                      <Globe2 size={23} />
                    </span>
                    <span>
                      <strong>Add a website</strong>
                      <small>Articles, docs, anything public</small>
                    </span>
                    <ArrowUpRight size={18} />
                  </button>
                </div>
                <div className="try-question">
                  <span>Or ask the web</span>
                  <button
                    onClick={() => {
                      setQuestion(
                        "What are the key differences between RAG and fine-tuning?",
                      );
                      update("web_search", true);
                      composer.current?.focus();
                    }}
                  >
                    Compare RAG and fine-tuning <ArrowUpRight size={14} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="messages">
                {messages.map((message, index) => (
                  <article className={`message ${message.role}`} key={index}>
                    <div className="message-avatar">
                      {message.role === "user" ? "Y" : <Layers3 size={18} />}
                    </div>
                    <div className="message-body">
                      <div className="message-byline">
                        <strong>
                          {message.role === "user" ? "You" : "Source Room"}
                        </strong>
                        {message.model && (
                          <span>{shortModel(message.model)}</span>
                        )}
                      </div>
                      {message.content && (
                        <div className="markdown">
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={{
                              img: ({ alt }) => (
                                <span>
                                  {alt ? `[Image: ${alt}]` : "[Image omitted]"}
                                </span>
                              ),
                              a: ({ href, children }) => (
                                <a href={href} target="_blank" rel="noreferrer">
                                  {children}
                                </a>
                              ),
                            }}
                          >
                            {message.content}
                          </ReactMarkdown>
                        </div>
                      )}
                      {busy && index === messages.length - 1 && status && (
                        <div className="thinking" role="status">
                          <LoaderCircle size={15} className="spin" />
                          {status}
                        </div>
                      )}
                      {!!message.sources?.length && (
                        <div className="answer-sources">
                          <span>RETRIEVED EVIDENCE</span>
                          <div>
                            {message.sources.map((ref) => (
                              <button
                                key={ref.id}
                                onClick={() => setFocusedRef(ref)}
                              >
                                <span className="citation-number">
                                  {ref.id}
                                </span>
                                {ref.kind === "pdf" ? (
                                  <FileText size={13} />
                                ) : (
                                  <Globe2 size={13} />
                                )}
                                <span>
                                  {ref.title}
                                  {ref.page ? ` · p. ${ref.page}` : ""}
                                </span>
                                <ChevronRight size={13} />
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                      {message.warnings?.map((w, i) => (
                        <p className="message-warning" key={i}>
                          {w}
                        </p>
                      ))}
                      {message.error && (
                        <p role="alert" className="message-error">
                          {message.error}
                        </p>
                      )}
                      {message.role === "assistant" &&
                        message.content &&
                        (!busy || index < messages.length - 1) && (
                          <button
                            className="copy-button"
                            onClick={() => copy(message.content, index)}
                          >
                            {copied === index ? (
                              <Check size={14} />
                            ) : (
                              <Copy size={14} />
                            )}{" "}
                            {copied === index ? "Copied" : "Copy answer"}
                          </button>
                        )}
                    </div>
                  </article>
                ))}
                <div ref={chatBottom} />
              </div>
            )}
          </div>
          <div className="composer-area">
            <form className="composer" onSubmit={send}>
              <textarea
                ref={composer}
                aria-label="Ask a question"
                placeholder={
                  sources.length
                    ? "What would you like to know about your sources?"
                    : "Ask a question. Connect the dots."
                }
                value={question}
                maxLength={8000}
                rows={2}
                disabled={busy}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-toolbar">
                <div className="composer-tools">
                  <button
                    type="button"
                    className="icon-button attach-button"
                    aria-label="Attach PDF"
                    onClick={() => fileRef.current?.click()}
                    disabled={working}
                  >
                    <Plus size={20} />
                  </button>
                  <span className="toolbar-divider" />
                  <button
                    type="button"
                    className="model-picker"
                    onClick={() => setControls(true)}
                  >
                    <span className="model-dot" />
                    <span>{shortModel(settings.chat_model)}</span>
                    <ChevronDown size={13} />
                  </button>
                  <span className="search-pill">
                    <Globe2 size={13} />
                    {settings.web_search ? "Web on" : "Web off"}
                  </span>
                </div>
                {busy ? (
                  <button
                    type="button"
                    className="send-button"
                    aria-label="Stop answer"
                    onClick={() => abortRef.current?.abort()}
                  >
                    <Square size={17} />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="send-button"
                    aria-label="Send question"
                    disabled={!question.trim() || working || disabled}
                  >
                    <ArrowUp size={21} />
                  </button>
                )}
              </div>
            </form>
            <div className="composer-foot">
              <span>
                {selected.length
                  ? `${selected.length} source${selected.length === 1 ? "" : "s"} selected`
                  : "No sources selected"}
                <span>·</span>
                {settings.search_depth === "advanced"
                  ? "High-quality search"
                  : "Standard search"}
              </span>
              <span>Check sources. AI can make mistakes.</span>
            </div>
          </div>
          <footer className="workspace-footer">
            <span>
              POWERED BY <b>nebius</b> TOKEN FACTORY
            </span>
            <span>
              LangChain <span>·</span> Tavily
            </span>
          </footer>
        </main>
      </div>
      <input
        type="file"
        accept="application/pdf,.pdf"
        multiple
        hidden
        ref={fileRef}
        onChange={(e) => void upload(e.target.files)}
      />
      <Modal
        open={mobileSources}
        close={() => setMobileSources(false)}
        title="Your sources"
        drawer
      >
        {mobileSources && <div className="mobile-sidebar">{sidebar}</div>}
      </Modal>
      <Modal
        open={sourceModal}
        close={() => {
          if (!uploading) setSourceModal(false);
        }}
        title="Add your sources"
      >
        <div className="source-tabs">
          <button
            className={sourceTab === "pdf" ? "active" : ""}
            onClick={() => setSourceTab("pdf")}
          >
            <FileText size={17} />
            PDF documents
          </button>
          <button
            className={sourceTab === "website" ? "active" : ""}
            onClick={() => setSourceTab("website")}
          >
            <Globe2 size={17} />
            Website
          </button>
        </div>
        {sourceTab === "pdf" ? (
          <div className="modal-content">
            <button
              className="modal-upload"
              disabled={working}
              onClick={() => fileRef.current?.click()}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void upload(e.dataTransfer.files);
              }}
            >
              <Upload size={30} />
              <strong>Choose or drop PDF files</strong>
              <span>Up to 20 MB and 200 pages per file</span>
            </button>
            <p className="muted">
              Text is extracted page by page, so answers can cite the original
              page. Scanned documents need OCR first.
            </p>
          </div>
        ) : (
          <form className="modal-content" onSubmit={addWebsite}>
            <Field
              label="Website URL"
              hint="Add one public page at a time. Domain restrictions in Advanced controls apply."
            >
              <input
                type="url"
                required
                placeholder="https://docs.nebius.com/…"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </Field>
            <button
              className="primary-button"
              disabled={working || !url.trim()}
            >
              {uploading ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Plus size={16} />
              )}
              Add website
            </button>
          </form>
        )}
        {uploading && (
          <p className="modal-status" role="status">
            Extracting and indexing {uploading}…
          </p>
        )}
        {error && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}
      </Modal>
      <Modal
        open={controls}
        close={() => {
          commitDomains();
          setControls(false);
        }}
        title="Advanced controls"
        drawer
      >
        <div className="controls-intro">
          Fine-tune how you find, retrieve, and answer.
        </div>
        <div className="controls-content">
          <section>
            <div className="section-title">
              <Layers3 size={17} />
              <h3>Models</h3>
              <button
                className="text-button"
                onClick={refreshCatalog}
                disabled={refreshing || working}
              >
                <RefreshCw size={13} className={refreshing ? "spin" : ""} />
                Refresh catalog
              </button>
            </div>
            <Field
              label="Answer model"
              hint="Choose a suggestion or enter an exact Token Factory model ID."
            >
              <input
                list="chat-models"
                value={settings.chat_model}
                onChange={(e) => update("chat_model", e.target.value)}
                disabled={working}
              />
              <datalist id="chat-models">
                {config.chat_models.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </Field>
            <div className="model-suggestions">
              {config.chat_models.slice(0, 6).map((id) => (
                <button
                  key={id}
                  disabled={working}
                  className={settings.chat_model === id ? "selected" : ""}
                  onClick={() => update("chat_model", id)}
                >
                  {shortModel(id)}
                </button>
              ))}
            </div>
            <Field
              label="Embedding model"
              hint={
                sources.length
                  ? "Locked to your existing index. Remove all sources to switch."
                  : "Used to index and retrieve your PDFs and websites. Confirm availability with your account."
              }
            >
              <input
                list="embedding-models"
                value={settings.embedding_model}
                disabled={sources.length > 0 || working}
                onChange={(e) => update("embedding_model", e.target.value)}
              />
              <datalist id="embedding-models">
                {config.embedding_models.map((id) => (
                  <option key={id} value={id} />
                ))}
              </datalist>
            </Field>
            {catalogStatus && (
              <p className="field-note" role="status">
                {catalogStatus}
              </p>
            )}
          </section>
          <section>
            <div className="section-title">
              <Globe2 size={17} />
              <h3>Web research</h3>
              <Toggle
                label="Enable live web research"
                checked={settings.web_search}
                onChange={(v) => update("web_search", v)}
                disabled={working}
              />
            </div>
            <Field label="Search depth">
              <select
                value={settings.search_depth}
                disabled={working}
                onChange={(e) =>
                  update(
                    "search_depth",
                    e.target.value as Settings["search_depth"],
                  )
                }
              >
                <option value="advanced">High quality · Advanced</option>
                <option value="basic">Fast · Basic</option>
              </select>
            </Field>
            <p className="field-note">
              Advanced search retrieves richer context and uses more Tavily
              credits.
            </p>
            <Field
              label="Allowed domains"
              hint="Comma or newline separated. Blank allows all public domains. Subdomains are included."
            >
              <textarea
                rows={2}
                placeholder="nebius.com, arxiv.org"
                disabled={working}
                value={include}
                onChange={(e) => setInclude(e.target.value)}
                onBlur={commitDomains}
              />
            </Field>
            <Field
              label="Excluded domains"
              hint="Exclusions take priority. Rules also apply to added websites."
            >
              <textarea
                rows={2}
                placeholder="example.com"
                value={exclude}
                disabled={working}
                onChange={(e) => setExclude(e.target.value)}
                onBlur={commitDomains}
              />
            </Field>
            <div className="field-grid">
              <Field label="Search topic">
                <select
                  value={settings.topic}
                  disabled={working}
                  onChange={(e) =>
                    update("topic", e.target.value as Settings["topic"])
                  }
                >
                  <option value="general">General</option>
                  <option value="news">News</option>
                  <option value="finance">Finance</option>
                </select>
              </Field>
              <Field label="Time range">
                <select
                  value={settings.time_range}
                  disabled={working}
                  onChange={(e) =>
                    update(
                      "time_range",
                      e.target.value as Settings["time_range"],
                    )
                  }
                >
                  <option value="">Any time</option>
                  <option value="day">Past day</option>
                  <option value="week">Past week</option>
                  <option value="month">Past month</option>
                  <option value="year">Past year</option>
                </select>
              </Field>
            </div>
            <Field label={`Search results · ${settings.max_results}`}>
              <input
                type="range"
                min="1"
                max="10"
                value={settings.max_results}
                disabled={working}
                onChange={(e) => update("max_results", +e.target.value)}
              />
            </Field>
            <Field
              label="Website extraction depth"
              hint="Used when adding a website. Does not re-extract existing sources."
            >
              <select
                value={settings.extract_depth}
                disabled={working}
                onChange={(e) =>
                  update(
                    "extract_depth",
                    e.target.value as Settings["extract_depth"],
                  )
                }
              >
                <option value="advanced">Advanced</option>
                <option value="basic">Basic</option>
              </select>
            </Field>
          </section>
          <section>
            <div className="section-title">
              <Search size={17} />
              <h3>Retrieval & indexing</h3>
            </div>
            <Field label={`Retrieved chunks · ${settings.top_k}`}>
              <input
                type="range"
                min="1"
                max="20"
                value={settings.top_k}
                disabled={working}
                onChange={(e) => update("top_k", +e.target.value)}
              />
            </Field>
            <Field
              label="Minimum similarity"
              hint="Cosine similarity; higher values may return no evidence."
            >
              <input
                type="number"
                min="-1"
                max="1"
                step="0.05"
                value={settings.score_threshold}
                disabled={working}
                onChange={(e) => update("score_threshold", +e.target.value)}
              />
            </Field>
            <div className="field-grid">
              <Field label="Chunk size (chars)">
                <input
                  type="number"
                  min="400"
                  max="2400"
                  step="100"
                  value={settings.chunk_size}
                  disabled={working}
                  onChange={(e) => update("chunk_size", +e.target.value)}
                />
              </Field>
              <Field label="Overlap (chars)">
                <input
                  type="number"
                  min="0"
                  max="600"
                  step="50"
                  value={settings.chunk_overlap}
                  disabled={working}
                  onChange={(e) => update("chunk_overlap", +e.target.value)}
                />
              </Field>
            </div>
            <p className="field-note">
              Chunk settings apply to new sources. Overlap must be smaller than
              chunk size.
            </p>
            <Field label="Evidence budget (characters)">
              <input
                type="number"
                min="4000"
                max="60000"
                step="1000"
                value={settings.context_chars}
                disabled={working}
                onChange={(e) => update("context_chars", +e.target.value)}
              />
            </Field>
          </section>
          <section>
            <div className="section-title">
              <MessageSquare size={17} />
              <h3>Answer generation</h3>
            </div>
            <Field
              label={`Temperature · ${settings.temperature}`}
              hint="Lower for focused answers; higher for more varied wording."
            >
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={settings.temperature}
                disabled={working}
                onChange={(e) => update("temperature", +e.target.value)}
              />
            </Field>
            <div className="field-grid">
              <Field label="Top P">
                <input
                  type="number"
                  min="0.05"
                  max="1"
                  step="0.05"
                  value={settings.top_p}
                  disabled={working}
                  onChange={(e) => update("top_p", +e.target.value)}
                />
              </Field>
              <Field label="Max output tokens">
                <input
                  type="number"
                  min="256"
                  max="8192"
                  step="256"
                  value={settings.max_tokens}
                  disabled={working}
                  onChange={(e) => update("max_tokens", +e.target.value)}
                />
              </Field>
            </div>
            <Field
              label="Previous questions to include"
              hint="Keeps follow-up context. Answers are always grounded in the currently selected evidence."
            >
              <input
                type="number"
                min="0"
                max="10"
                value={settings.history_turns}
                disabled={working}
                onChange={(e) => update("history_turns", +e.target.value)}
              />
            </Field>
            <Field label="Answer style">
              <select
                value={settings.answer_style}
                disabled={working}
                onChange={(e) =>
                  update(
                    "answer_style",
                    e.target.value as Settings["answer_style"],
                  )
                }
              >
                <option value="concise">Concise</option>
                <option value="balanced">Balanced</option>
                <option value="detailed">Detailed</option>
              </select>
            </Field>
          </section>
        </div>
        <div className="controls-footer">
          <button
            className="light-button"
            disabled={working}
            onClick={() => {
              setSettings({
                ...config.defaults,
                embedding_model:
                  sources[0]?.model || config.defaults.embedding_model,
              });
              setInclude("");
              setExclude("");
            }}
          >
            Reset defaults
          </button>
          <button
            className="primary-button"
            onClick={() => {
              commitDomains();
              setControls(false);
            }}
          >
            Done <Check size={16} />
          </button>
        </div>
      </Modal>
      <Modal
        open={help}
        close={() => setHelp(false)}
        title="A little context goes a long way"
      >
        <div className="guide modal-content">
          <div className="guide-step">
            <span>1</span>
            <div>
              <h3>Connect your providers</h3>
              <p>
                Set <code>NEBIUS_API_KEY</code> and <code>TAVILY_API_KEY</code>{" "}
                in the server’s environment and restart. Your keys never enter
                the browser.
              </p>
              <div className="provider-check">
                <span>
                  {config.nebius_configured ? (
                    <Check size={14} />
                  ) : (
                    <Plus size={14} />
                  )}
                  Nebius{" "}
                  {config.nebius_configured ? "configured" : "needs a key"}
                </span>
                <span>
                  {config.tavily_configured ? (
                    <Check size={14} />
                  ) : (
                    <Plus size={14} />
                  )}
                  Tavily{" "}
                  {config.tavily_configured ? "configured" : "needs a key"}
                </span>
              </div>
              <button
                className="text-button"
                onClick={() => {
                  void initialize();
                }}
              >
                Recheck configuration <RefreshCw size={13} />
              </button>
            </div>
          </div>
          <div className="guide-step">
            <span>2</span>
            <div>
              <h3>Add what you want to understand</h3>
              <p>
                Upload text-based PDFs or add public website pages. Select the
                sources to use, or enable web search for fresh evidence.
              </p>
            </div>
          </div>
          <div className="guide-step">
            <span>3</span>
            <div>
              <h3>Ask, then follow the evidence</h3>
              <p>
                Answers stream into your chat. Open the numbered evidence chips
                to inspect excerpts, page numbers, and original links.
              </p>
            </div>
          </div>
          <div className="guide-note">
            <BookOpen size={18} />
            <p>
              PDF text is sent to Nebius for embeddings and answers. URLs and
              search queries are sent to Tavily. Source text and chat history
              stay in this server’s browser-scoped workspace for up to 30 days.
            </p>
          </div>
          <div className="guide-links">
            <a
              href="https://tokenfactory.nebius.com/endpoints"
              target="_blank"
              rel="noreferrer"
            >
              Nebius Token Factory <ArrowUpRight size={14} />
            </a>
            <a href="https://app.tavily.com/" target="_blank" rel="noreferrer">
              Tavily <ArrowUpRight size={14} />
            </a>
          </div>
        </div>
      </Modal>
      <Modal
        open={!!focusedRef}
        close={() => setFocusedRef(undefined)}
        title="Source evidence"
      >
        <div className="modal-content evidence-view">
          <span className="eyebrow">
            SOURCE [{focusedRef?.id}]{" "}
            {focusedRef?.page ? ` · PAGE ${focusedRef.page}` : ""}
          </span>
          <h3>{focusedRef?.title}</h3>
          <p>{focusedRef?.text}</p>
          <small>
            Excerpt of the retrieved context. The model may not have cited every
            retrieved source.
          </small>
          {focusedRef?.url && (
            <a
              className="primary-button"
              href={focusedRef.url}
              target="_blank"
              rel="noreferrer"
            >
              Open original page <ArrowUpRight size={15} />
            </a>
          )}
        </div>
      </Modal>
      <Modal
        open={config.auth_required}
        close={() => {}}
        title="Open your workspace"
      >
        <form
          className="modal-content"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/login", json({ password }));
              setPassword("");
              setError("");
              await initialize();
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        >
          <p>
            This workspace is protected. Enter the shared password configured by
            its owner.
          </p>
          <Field label="Workspace password">
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </Field>
          <button className="primary-button">
            Open workspace <ArrowUpRight size={16} />
          </button>
          {error && (
            <p role="alert" className="message-error">
              {error}
            </p>
          )}
        </form>
      </Modal>
    </div>
  );
}
export default App;
