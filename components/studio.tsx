"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowDownAZ,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  FileText,
  GripVertical,
  Image as ImageIcon,
  Layers3,
  LayoutGrid,
  Link2,
  List,
  LoaderCircle,
  LogOut,
  Monitor,
  Moon,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Settings2,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { AuthScreen } from "./auth-screen";
import type {
  ChainRun,
  ChainStep,
  PromptChain,
  SessionUser,
  StepKind,
} from "@/lib/types";
import type { RegistryModelDescriptor } from "@/lib/existing-schema";
import type { LegacyHistoryItem } from "@/lib/legacy-history";

type Theme = "light" | "dark" | "system";
type Section = "chains" | "media";
type Toast = { message: string; error?: boolean };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
const date = (value: string) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
const models = {
  text: [
    { value: "gpt-4.1-mini", label: "GPT-4.1 mini" },
    { value: "gpt-4.1", label: "GPT-4.1" },
    { value: "gpt-4o-mini", label: "GPT-4o mini" },
  ],
  image: [{ value: "gpt-image-1", label: "GPT Image 1" }],
};
function chainRunIssue(chain: PromptChain): string {
  if (!chain.steps.length) return "Add a step before running this chain.";
  if (chain.steps.length > 10)
    return "Generation supports up to 10 steps per run. Split this chain to run it.";
  if (chain.steps.some((step) => step.generation_ready === false))
    return "A step uses an unavailable, inactive, or unsupported model. Choose a supported model before running.";
  return "";
}
const exampleSteps = [
  {
    name: "Describe the image",
    prompt:
      "Describe the image in detail. Focus on the subject, setting, and anything unusual.",
    kind: "text",
    model: "gpt-4.1-mini",
  },
  {
    name: "Find the funny side",
    prompt:
      "Find a funny, unexpected observation about this description: {{previous}}",
    kind: "text",
    model: "gpt-4.1-mini",
  },
  {
    name: "Write five captions",
    prompt:
      "Write five short, funny social media captions based on this observation: {{previous}}. Return a numbered list.",
    kind: "text",
    model: "gpt-4.1-mini",
  },
];

export default function Studio() {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checking, setChecking] = useState(true);
  const [authError, setAuthError] = useState("");
  const [theme, setTheme] = useState<Theme>("system");
  const [themeReady, setThemeReady] = useState(false);
  const [chains, setChains] = useState<PromptChain[]>([]);
  const [loading, setLoading] = useState(false);
  const [section, setSection] = useState<Section>("chains");
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("updated");
  const [view, setView] = useState("grid");
  const [chainModal, setChainModal] = useState<PromptChain | "new" | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<PromptChain | null>(null);
  const [guide, setGuide] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [mobileNav, setMobileNav] = useState(false);
  const [accountMenu, setAccountMenu] = useState(false);
  const notify = useCallback(
    (message: string, error = false) => setToast({ message, error }),
    [],
  );

  useEffect(() => {
    const saved = localStorage.getItem("chainlab-theme") as Theme;
    if (["light", "dark", "system"].includes(saved)) setTheme(saved);
    setThemeReady(true);
  }, []);
  useEffect(() => {
    if (!themeReady) return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    media.addEventListener("change", apply);
    localStorage.setItem("chainlab-theme", theme);
    return () => media.removeEventListener("change", apply);
  }, [theme, themeReady]);
  useEffect(() => {
    if (toast) {
      const id = setTimeout(() => setToast(null), 5000);
      return () => clearTimeout(id);
    }
  }, [toast]);
  const checkSession = useCallback(async () => {
    setChecking(true);
    try {
      const data = await api<{ user: SessionUser }>("/api/session");
      setUser(data.user);
      setAuthError("");
    } catch (e) {
      const message = (e as Error).message;
      setAuthError(
        /sign in|authenticated|authentication required|not authenticated/i.test(
          message,
        )
          ? ""
          : message,
      );
      setUser(null);
    } finally {
      setChecking(false);
    }
  }, []);
  const loadChains = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ chains: PromptChain[] }>("/api/chains");
      setChains(data.chains);
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  }, [notify]);
  useEffect(() => {
    checkSession();
  }, [checkSession]);
  useEffect(() => {
    if (user) loadChains();
  }, [user, loadChains]);

  async function logout() {
    try {
      await api("/api/auth/logout", { method: "POST" });
      setUser(null);
      setChains([]);
      setSelected(null);
      setAccountMenu(false);
    } catch (e) {
      notify((e as Error).message, true);
    }
  }
  async function saveChain(values: {
    name: string;
    description: string;
    status: string;
  }) {
    const editing = chainModal && chainModal !== "new";
    const data = await api<{ chain: PromptChain }>(
      editing ? `/api/chains/${chainModal.id}` : "/api/chains",
      { method: editing ? "PATCH" : "POST", body: JSON.stringify(values) },
    );
    await loadChains();
    setChainModal(null);
    if (!editing) setSelected(data.chain.id);
    notify(editing ? "Chain updated" : "Your new chain is ready");
  }
  async function createExample() {
    setLoading(true);
    let chainId: string | undefined;
    try {
      const baseName = "From image to punchline";
      const usedNames = new Set(chains.map((chain) => chain.name));
      let exampleName = baseName;
      for (let suffix = 2; usedNames.has(exampleName); suffix += 1)
        exampleName = `${baseName} (${suffix})`;
      const { chain } = await api<{ chain: PromptChain }>("/api/chains", {
        method: "POST",
        body: JSON.stringify({
          name: exampleName,
          description:
            "Turn a photo into five scroll-stopping, funny captions.",
          status: "draft",
        }),
      });
      chainId = chain.id;
      for (const step of exampleSteps)
        await api(`/api/chains/${chain.id}/steps`, {
          method: "POST",
          body: JSON.stringify(step),
        });
      await loadChains();
      setSelected(chain.id);
      notify("Example chain created. Make it your own.");
    } catch (e) {
      await loadChains();
      if (chainId) setSelected(chainId);
      notify((e as Error).message, true);
    } finally {
      setLoading(false);
    }
  }
  async function deleteChain() {
    if (!deleteTarget) return;
    await api(`/api/chains/${deleteTarget.id}`, { method: "DELETE" });
    setDeleteTarget(null);
    if (selected === deleteTarget.id) setSelected(null);
    await loadChains();
    notify("Chain deleted");
  }
  const current = chains.find((c) => c.id === selected);
  const filtered = chains
    .filter(
      (c) =>
        (filter === "all" || c.status === filter) &&
        `${c.name} ${c.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) =>
      sort === "name"
        ? a.name.localeCompare(b.name)
        : new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  if (checking)
    return (
      <div className="boot">
        <div className="brand-icon">
          <Workflow size={25} />
        </div>
        <LoaderCircle className="spin" size={22} />
        <span>Opening your studio…</span>
      </div>
    );
  if (!user)
    return (
      <AuthScreen onAuthenticated={checkSession} initialError={authError} />
    );

  return (
    <div className="app-shell">
      {mobileNav && (
        <div className="nav-scrim" onClick={() => setMobileNav(false)} />
      )}
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <a className="brand" href="/" aria-label="Chainlab home">
          <div className="brand-icon">
            <Workflow size={23} />
          </div>
          <span>
            chain<span className="brand-light">lab</span>
            <span className="brand-dot">.</span>
          </span>
        </a>
        <div className="workspace-label">
          <span className="workspace-avatar">G</span>
          <div>
            <strong>genAIDes workspace</strong>
            <small>Superadmin workspace</small>
          </div>
          <ChevronDown size={15} />
        </div>
        <div className="nav-section-label">WORKSPACE</div>
        <nav>
          <button
            className={`nav-item ${section === "chains" ? "active" : ""}`}
            onClick={() => {
              setSection("chains");
              setSelected(null);
              setMobileNav(false);
            }}
          >
            <Workflow size={18} />
            <span>Prompt chains</span>
            <span className="nav-count">{chains.length}</span>
          </button>
          <button
            className={`nav-item ${section === "media" ? "active" : ""}`}
            onClick={() => {
              setSection("media");
              setSelected(null);
              setMobileNav(false);
            }}
          >
            <ImageIcon size={18} />
            <span>Media library</span>
          </button>
        </nav>
        <div className="nav-section-label resources-label">RESOURCES</div>
        <button className="nav-item" onClick={() => setGuide(true)}>
          <BookOpen size={18} />
          <span>Quick start guide</span>
          <ArrowUpRight size={14} />
        </button>
        <div className="sidebar-bottom">
          <div className="sidebar-tip">
            <div className="tip-icon">
              <Sparkles size={18} />
            </div>
            <strong>One idea. Endless possibilities.</strong>
            <p>Connect your prompts and let the good ideas flow.</p>
            <button onClick={() => setGuide(true)}>
              Explore the possibilities <ArrowUpRight size={14} />
            </button>
          </div>
          <div className="theme-control" aria-label="Color theme">
            {(
              [
                { value: "light", icon: Sun, label: "Light" },
                { value: "dark", icon: Moon, label: "Dark" },
                { value: "system", icon: Monitor, label: "System" },
              ] as const
            ).map(({ value, icon: Icon, label }) => (
              <button
                key={value}
                aria-label={`${label} theme`}
                aria-pressed={theme === value}
                title={`${label} theme`}
                className={theme === value ? "chosen" : ""}
                onClick={() => setTheme(value)}
              >
                <Icon size={15} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <div className="sidebar-footer">
            <span className="online-dot" /> Access verified <span>v1.0</span>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <button
            className="icon-button mobile-toggle"
            aria-label="Open navigation"
            onClick={() => setMobileNav(true)}
          >
            <List size={22} />
          </button>
          <div className="breadcrumbs">
            <span>Workspace</span>
            <ChevronRight size={14} />
            <strong>
              {current
                ? current.name
                : section === "media"
                  ? "Media library"
                  : "Prompt chains"}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="superadmin-badge">
              <span />
              Superadmin
            </span>
            <button
              className="icon-button help-button"
              aria-label="Open quick start guide"
              onClick={() => setGuide(true)}
            >
              <CircleHelp size={19} />
            </button>
            <div className="account-wrapper">
              <button
                className="avatar"
                aria-label="Account menu"
                onClick={() => setAccountMenu(!accountMenu)}
              >
                {user.email.slice(0, 2).toUpperCase()}
              </button>
              {accountMenu && (
                <div className="account-menu">
                  <small>Signed in as</small>
                  <strong>{user.email}</strong>
                  <button onClick={logout}>
                    <LogOut size={15} />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        <main>
          {current && section === "chains" ? (
            <ChainEditor
              chain={current}
              onBack={() => setSelected(null)}
              onRefresh={loadChains}
              onEdit={() => setChainModal(current)}
              onDelete={() => setDeleteTarget(current)}
              notify={notify}
            />
          ) : section === "media" ? (
            <MediaLibrary chains={chains} notify={notify} />
          ) : (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    YOUR CREATIVE WORKFLOW, CONNECTED
                  </div>
                  <h1>
                    Prompt chains<span className="heading-dot">.</span>
                  </h1>
                  <p>
                    Small steps. Powerful possibilities. Build your next great
                    idea.
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() => setChainModal("new")}
                >
                  <Plus size={17} />
                  Create chain
                </button>
              </div>
              <div className="overview-stats">
                <div className="overview-stat">
                  <div className="stat-icon violet">
                    <Workflow size={20} />
                  </div>
                  <div>
                    <span>Total chains</span>
                    <strong>{chains.length.toString().padStart(2, "0")}</strong>
                  </div>
                  <span className="stat-label">Your idea engine</span>
                </div>
                <div className="overview-stat">
                  <div className="stat-icon green">
                    <Zap size={20} />
                  </div>
                  <div>
                    <span>Active chains</span>
                    <strong>
                      {chains
                        .filter((c) => c.status === "active")
                        .length.toString()
                        .padStart(2, "0")}
                    </strong>
                  </div>
                  <span className="stat-label">
                    <span className="online-dot" />
                    Ready to create
                  </span>
                </div>
                <div className="overview-stat">
                  <div className="stat-icon peach">
                    <Layers3 size={20} />
                  </div>
                  <div>
                    <span>Prompt steps</span>
                    <strong>
                      {chains
                        .reduce((n, c) => n + c.steps.length, 0)
                        .toString()
                        .padStart(2, "0")}
                    </strong>
                  </div>
                  <span className="stat-label">Connected possibilities</span>
                </div>
              </div>
              <div className="section-header">
                <div className="filter-tabs" aria-label="Filter chains">
                  {["all", "active", "draft"].map((f) => (
                    <button
                      key={f}
                      className={filter === f ? "selected" : ""}
                      onClick={() => setFilter(f)}
                    >
                      {f === "all"
                        ? "All chains"
                        : f === "active"
                          ? "Active"
                          : "Drafts"}
                      <span>
                        {
                          chains.filter((c) => f === "all" || c.status === f)
                            .length
                        }
                      </span>
                    </button>
                  ))}
                </div>
                <div className="library-tools">
                  <label className="search-field">
                    <Search size={16} />
                    <input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Search your chains…"
                      aria-label="Search chains"
                    />
                    {query && (
                      <button
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </label>
                  <label className="sort-select">
                    <ArrowDownAZ size={16} />
                    <select
                      aria-label="Sort chains"
                      value={sort}
                      onChange={(e) => setSort(e.target.value)}
                    >
                      <option value="updated">Last edited</option>
                      <option value="name">Name A–Z</option>
                    </select>
                  </label>
                  <div className="view-control">
                    <button
                      aria-label="Grid view"
                      aria-pressed={view === "grid"}
                      className={view === "grid" ? "chosen" : ""}
                      onClick={() => setView("grid")}
                    >
                      <LayoutGrid size={16} />
                    </button>
                    <button
                      aria-label="List view"
                      aria-pressed={view === "list"}
                      className={view === "list" ? "chosen" : ""}
                      onClick={() => setView("list")}
                    >
                      <List size={17} />
                    </button>
                  </div>
                </div>
              </div>
              {loading ? (
                <div className="loading-state">
                  <LoaderCircle className="spin" />
                  Loading your chains…
                </div>
              ) : filtered.length ? (
                <div
                  className={`chain-grid ${view === "list" ? "chain-list" : ""}`}
                >
                  {filtered.map((chain, i) => (
                    <ChainCard
                      key={chain.id}
                      chain={chain}
                      index={i}
                      onOpen={() => setSelected(chain.id)}
                      onEdit={() => setChainModal(chain)}
                      onDelete={() => setDeleteTarget(chain)}
                    />
                  ))}
                  {view === "grid" && (
                    <button
                      className="new-chain-card"
                      onClick={() => setChainModal("new")}
                    >
                      <span className="new-chain-plus">
                        <Plus size={24} />
                      </span>
                      <strong>A new possibility</strong>
                      <span>Start with an idea. Build a chain.</span>
                      <span className="text-link">
                        Create a prompt chain <ArrowRight size={15} />
                      </span>
                    </button>
                  )}
                </div>
              ) : (
                <div className="empty-library">
                  <div className="empty-art">
                    <div className="empty-node">
                      <ImageIcon size={20} />
                    </div>
                    <span />
                    <div className="empty-node main">
                      <Sparkles size={24} />
                    </div>
                    <span />
                    <div className="empty-node">
                      <FileText size={20} />
                    </div>
                  </div>
                  <h2>
                    {query || filter !== "all"
                      ? "No chains found"
                      : "Every great idea starts with a prompt."}
                  </h2>
                  <p>
                    {query || filter !== "all"
                      ? "Try another search or filter to find your chain."
                      : "Connect a few simple steps and see where your imagination takes you."}
                  </p>
                  <button
                    className="button primary"
                    onClick={() =>
                      query || filter !== "all"
                        ? (setQuery(""), setFilter("all"))
                        : setChainModal("new")
                    }
                  >
                    {query || filter !== "all" ? (
                      "Clear filters"
                    ) : (
                      <>
                        <Plus size={16} />
                        Create your first chain
                      </>
                    )}
                  </button>
                  {!query && filter === "all" && (
                    <button className="text-link" onClick={createExample}>
                      Or try an example chain <ArrowRight size={14} />
                    </button>
                  )}
                </div>
              )}
              <div className="inspiration-banner">
                <div className="inspiration-icon">
                  <Sparkles size={27} />
                </div>
                <div>
                  <span className="mini-eyebrow">A LITTLE INSPIRATION</span>
                  <h3>From a single image to a whole lot of laughs.</h3>
                  <p>
                    Image → Description → Funny observation → Five great
                    captions. That’s a chain.
                  </p>
                </div>
                <button
                  className="button subtle"
                  disabled={loading}
                  onClick={createExample}
                >
                  Try this chain <ArrowUpRight size={16} />
                </button>
                <div className="banner-orbit" />
              </div>
              <div className="page-footer">
                <span>Made for your next “what if?”</span>
                <span>
                  <Workflow size={13} /> Connected by Chainlab
                </span>
              </div>
            </>
          )}
        </main>
      </div>
      {chainModal && (
        <ChainDialog
          chain={chainModal === "new" ? undefined : chainModal}
          onClose={() => setChainModal(null)}
          onSave={saveChain}
        />
      )}
      {deleteTarget && (
        <ConfirmDelete
          title={`Delete “${deleteTarget.name}”?`}
          description="This permanently removes the chain and its steps. Existing media or workflow references may prevent deletion; set the chain to Draft to deactivate it instead."
          onClose={() => setDeleteTarget(null)}
          onConfirm={deleteChain}
        />
      )}
      {guide && <Guide onClose={() => setGuide(false)} />}
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} role="status">
          {toast.error ? <CircleHelp size={18} /> : <CheckCheck size={18} />}
          <span>{toast.message}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast(null)}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

function ChainCard({
  chain,
  index,
  onOpen,
  onEdit,
  onDelete,
}: {
  chain: PromptChain;
  index: number;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const [menu, setMenu] = useState(false);
  return (
    <article className="chain-card">
      <button
        className={`chain-art art-${index % 4}`}
        onClick={onOpen}
        aria-label={`Open ${chain.name}`}
      >
        <div className="art-grain" />
        <div className="art-orb one" />
        <div className="art-orb two" />
        <div className="art-orb three" />
        <div className="art-pipeline">
          {(chain.steps.length
            ? chain.steps.slice(0, 3)
            : [null, null, null]
          ).map((s, i) => (
            <span key={i}>
              {s?.kind === "image" ? (
                <ImageIcon size={21} />
              ) : i === 1 ? (
                <Sparkles size={21} />
              ) : i === 0 ? (
                <FileText size={21} />
              ) : (
                <Workflow size={21} />
              )}
            </span>
          ))}
        </div>
        <span className={`status-pill ${chain.status}`}>
          <span />
          {chain.status === "active" ? "Active" : "Draft"}
        </span>
      </button>
      <div className="chain-card-content">
        <div className="card-title-row">
          <button onClick={onOpen}>
            <h3>{chain.name}</h3>
          </button>
          <div className="card-menu-wrapper">
            <button
              className="icon-button"
              aria-label={`Options for ${chain.name}`}
              onClick={() => setMenu(!menu)}
            >
              <MoreHorizontal size={19} />
            </button>
            {menu && (
              <div className="context-menu">
                <button
                  onClick={() => {
                    setMenu(false);
                    onEdit();
                  }}
                >
                  <Settings2 size={14} />
                  Edit chain
                </button>
                <button
                  className="danger-text"
                  onClick={() => {
                    setMenu(false);
                    onDelete();
                  }}
                >
                  <Trash2 size={14} />
                  Delete chain
                </button>
              </div>
            )}
          </div>
        </div>
        <p className="card-description">
          {chain.description || "Your next great idea, one prompt at a time."}
        </p>
        <div className="card-meta">
          <span>
            <Layers3 size={14} />
            {chain.steps.length} {chain.steps.length === 1 ? "step" : "steps"}
          </span>
          <span className="meta-dot">·</span>
          <span>
            {chain.steps.some((s) => s.kind === "image")
              ? "Image + text"
              : "Text output"}
          </span>
        </div>
        <div className="card-footer">
          <span>
            <Clock3 size={13} />
            Edited {date(chain.updated_at)}
          </span>
          <button
            className="card-open"
            onClick={onOpen}
            aria-label={`Edit ${chain.name}`}
          >
            <ArrowUpRight size={18} />
          </button>
        </div>
      </div>
    </article>
  );
}

function Modal({
  children,
  onClose,
  wide = false,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  title: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>(
      "input, button, select, textarea",
    );
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && el) {
        const focusable = Array.from(
          el.querySelectorAll<HTMLElement>(
            "button:not(:disabled), input, textarea, select, a[href]",
          ),
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = old;
      document.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`modal ${wide ? "wide" : ""}`}
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {children}
      </div>
    </div>
  );
}
function ChainDialog({
  chain,
  onClose,
  onSave,
}: {
  chain?: PromptChain;
  onClose: () => void;
  onSave: (v: {
    name: string;
    description: string;
    status: string;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(chain?.name || "");
  const [description, setDescription] = useState(chain?.description || "");
  const [status, setStatus] = useState(chain?.status || "draft");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        status,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal
      onClose={onClose}
      title={chain ? "Edit chain" : "Create a prompt chain"}
    >
      <form onSubmit={submit}>
        <div className="modal-header">
          <div className="modal-icon">
            <Workflow size={22} />
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <h2>{chain ? "A little fine-tuning." : "Let’s connect an idea."}</h2>
        <p className="modal-subtitle">
          {chain
            ? "Give your chain a name, a purpose, and room to grow."
            : "Start with a name. The possibilities come next."}
        </p>
        <label className="form-field">
          Chain name
          <input
            required
            maxLength={120}
            placeholder="e.g. From image to punchline"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="form-field">
          Description <span className="optional">Optional</span>
          <textarea
            rows={3}
            maxLength={2000}
            placeholder="What will this chain create?"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
        <label className="form-field">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as "draft" | "active")}
          >
            <option value="draft">Draft — a work in progress</option>
            <option value="active">Active — ready to create</option>
          </select>
        </label>
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="button primary" disabled={saving || !name.trim()}>
            {saving ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Plus size={16} />
            )}
            {chain ? "Save changes" : "Create chain"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function ConfirmDelete({
  title,
  description,
  onClose,
  onConfirm,
}: {
  title: string;
  description: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Modal title={title} onClose={onClose}>
      <div className="modal-header">
        <div className="modal-icon danger">
          <Trash2 size={22} />
        </div>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <h2>{title}</h2>
      <p className="modal-subtitle">{description}</p>
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      <div className="modal-actions">
        <button className="button secondary" onClick={onClose}>
          Keep it
        </button>
        <button
          className="button danger-button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onConfirm();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <Trash2 size={16} />
          )}
          Delete permanently
        </button>
      </div>
    </Modal>
  );
}

function ChainEditor({
  chain,
  onBack,
  onRefresh,
  onEdit,
  onDelete,
  notify,
}: {
  chain: PromptChain;
  onBack: () => void;
  onRefresh: () => Promise<void>;
  onEdit: () => void;
  onDelete: () => void;
  notify: (message: string, error?: boolean) => void;
}) {
  const [tab, setTab] = useState("steps");
  const [editing, setEditing] = useState<ChainStep | "new" | null>(null);
  const [deleting, setDeleting] = useState<ChainStep | null>(null);
  const [runDialog, setRunDialog] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [runVersion, setRunVersion] = useState(0);
  const steps = [...chain.steps].sort((a, b) => a.position - b.position);
  const runIssue = chainRunIssue(chain);
  const canReorder = steps.length < 1000;
  async function reorder(from: number, to: number) {
    if (
      from === to ||
      from < 0 ||
      to < 0 ||
      to >= steps.length ||
      reordering ||
      !canReorder
    )
      return;
    const next = [...steps];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    setReordering(true);
    try {
      await api(`/api/chains/${chain.id}/steps/order`, {
        method: "PUT",
        body: JSON.stringify({ stepIds: next.map((s) => s.id) }),
      });
      await onRefresh();
      notify("Steps reordered");
    } catch (e) {
      notify((e as Error).message, true);
    } finally {
      setReordering(false);
      setDragged(null);
      setOver(null);
    }
  }
  async function saveStep(value: {
    name: string;
    prompt: string;
    kind: StepKind;
    model: string;
    role: string;
    model_id: string | null;
  }) {
    await api(
      editing !== "new" && editing
        ? `/api/chains/${chain.id}/steps/${editing.id}`
        : `/api/chains/${chain.id}/steps`,
      {
        method: editing === "new" ? "POST" : "PATCH",
        body: JSON.stringify(value),
      },
    );
    setEditing(null);
    await onRefresh();
    notify(editing === "new" ? "Step added to your chain" : "Step updated");
  }
  return (
    <>
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={15} />
        All prompt chains
      </button>
      <div className="page-heading editor-heading">
        <div>
          <div className="editor-title">
            <h1>{chain.name}</h1>
            <span className={`status-pill inline ${chain.status}`}>
              <span />
              {chain.status}
            </span>
          </div>
          <p>
            {chain.description || "A little imagination, one step at a time."}
          </p>
        </div>
        <div className="heading-actions">
          <button className="button secondary" onClick={onEdit}>
            <Settings2 size={16} />
            Chain settings
          </button>
          <button
            className="button primary"
            disabled={!!runIssue}
            title={runIssue || undefined}
            onClick={() => setRunDialog(true)}
          >
            <Play size={15} fill="currentColor" />
            Run chain
          </button>
        </div>
      </div>
      {runIssue && steps.length > 0 && (
        <p className="chain-run-warning" role="status">
          <CircleHelp size={15} />
          {runIssue}
        </p>
      )}
      <div className="editor-tabs">
        <button
          className={tab === "steps" ? "selected" : ""}
          onClick={() => setTab("steps")}
        >
          <Workflow size={16} />
          Chain steps<span>{steps.length}</span>
        </button>
        <button
          className={tab === "outputs" ? "selected" : ""}
          onClick={() => setTab("outputs")}
        >
          <ImageIcon size={16} />
          Generated media
        </button>
        <span className="autosave">
          <Check size={13} />
          All changes saved
        </span>
      </div>
      {tab === "steps" ? (
        <div className="editor-layout">
          <section className="step-canvas">
            <div className="canvas-heading">
              <div>
                <h2>The creative process</h2>
                <p>Each step picks up where the last one left off.</p>
              </div>
              <span className="step-total">{steps.length} / 1000 steps</span>
            </div>
            {!canReorder && (
              <p className="field-note">
                To reorder a full 1000-step chain, remove a step first.
              </p>
            )}
            <div className="input-node">
              <span className="node-icon">
                <Upload size={17} />
              </span>
              <div>
                <strong>Your input</strong>
                <span>Text, an image, or a spark of inspiration</span>
              </div>
              <span className="input-type">START</span>
            </div>
            <div className="node-connector">
              <span />
            </div>
            {steps.map((step, index) => (
              <div key={step.id}>
                <article
                  className={`step-card ${over === step.id && dragged !== step.id ? "drag-over" : ""} ${dragged === step.id ? "dragging" : ""}`}
                  draggable={!reordering && canReorder}
                  onDragStart={(e) => {
                    setDragged(step.id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", step.id);
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOver(step.id);
                  }}
                  onDragEnd={() => {
                    setDragged(null);
                    setOver(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const id = e.dataTransfer.getData("text/plain");
                    reorder(
                      steps.findIndex((s) => s.id === id),
                      index,
                    );
                  }}
                >
                  <div className="step-card-header">
                    <GripVertical size={16} className="drag-grip" />
                    <span className="step-number">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <span className={`step-kind ${step.kind}`}>
                      <span>
                        {step.kind === "image" ? (
                          <ImageIcon size={14} />
                        ) : (
                          <FileText size={14} />
                        )}
                      </span>
                      {step.kind === "image"
                        ? "Image generation"
                        : "Text generation"}
                    </span>
                    <div className="step-actions">
                      <button
                        className="icon-button"
                        aria-label={`Move ${step.name} up`}
                        disabled={index === 0 || reordering || !canReorder}
                        onClick={() => reorder(index, index - 1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Move ${step.name} down`}
                        disabled={
                          index === steps.length - 1 ||
                          reordering ||
                          !canReorder
                        }
                        onClick={() => reorder(index, index + 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Delete ${step.name}`}
                        onClick={() => setDeleting(step)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  <button
                    className="step-card-body"
                    onClick={() => setEditing(step)}
                  >
                    <h3>
                      {step.name}
                      <Settings2 size={15} />
                    </h3>
                    <p>{step.prompt}</p>
                    <div className="step-bottom">
                      <span className="model-pill">
                        <Sparkles size={12} />
                        {step.model_label ||
                          models[step.kind].find((m) => m.value === step.model)
                            ?.label ||
                          step.model ||
                          "Assigned model"}
                      </span>
                      {step.generation_ready === false && (
                        <span className="step-model-warning">
                          <CircleHelp size={12} />
                          Model unavailable for generation
                        </span>
                      )}
                      <span>
                        <Link2 size={12} />
                        {index ? "Previous step output" : "Original input"}
                      </span>
                      <span className="edit-step-link">
                        Edit step <ArrowUpRight size={13} />
                      </span>
                    </div>
                  </button>
                </article>
                <div className="node-connector">
                  <span />
                </div>
              </div>
            ))}
            <button
              className="add-step"
              disabled={steps.length >= 1000}
              onClick={() => setEditing("new")}
            >
              <Plus size={18} />
              <span>Add a step</span>
              <span className="add-step-hint">
                {steps.length >= 1000
                  ? "1000-step limit reached"
                  : "Keep the ideas flowing"}
              </span>
            </button>
            <div className="output-note">
              <CheckCheck size={15} />
              Your final output. A whole new possibility.
            </div>
          </section>
          <aside className="editor-aside">
            <div className="aside-card">
              <div className="aside-kicker">
                <Sparkles size={17} />A BETTER CHAIN STARTS HERE
              </div>
              <h3>
                Good prompts.
                <br />
                Great possibilities.
              </h3>
              <p>
                Tell each step exactly what you want. Be specific about the
                tone, format, and result.
              </p>
              <div className="aside-divider" />
              <strong>Pass the idea along</strong>
              <p>Use variables to connect the dots between your steps.</p>
              <div className="variable-tip">
                <code>{"{{input}}"}</code>
                <span>The original input</span>
              </div>
              <div className="variable-tip">
                <code>{"{{previous}}"}</code>
                <span>The last step’s output</span>
              </div>
              <div className="variable-tip">
                <code>{"{{step.1}}"}</code>
                <span>A specific step’s output</span>
              </div>
              <button
                className="text-link"
                onClick={() =>
                  notify(
                    "Tip: each step also receives the original input and previous outputs automatically.",
                  )
                }
              >
                A tip for your next prompt <ArrowUpRight size={14} />
              </button>
            </div>
            <div className="chain-details">
              <span>CHAIN DETAILS</span>
              <div>
                <span>Created</span>
                <strong>{date(chain.created_at)}</strong>
              </div>
              <div>
                <span>Last edited</span>
                <strong>{date(chain.updated_at)}</strong>
              </div>
              <div>
                <span>Total steps</span>
                <strong>{steps.length}</strong>
              </div>
            </div>
            <button className="delete-chain-link" onClick={onDelete}>
              <Trash2 size={14} />
              Delete this chain
            </button>
          </aside>
        </div>
      ) : (
        <RunHistory
          key={`${chain.id}-${runVersion}`}
          chain={chain}
          notify={notify}
          onRun={() => setRunDialog(true)}
        />
      )}
      {editing && (
        <StepDialog
          step={editing === "new" ? undefined : editing}
          number={
            editing === "new"
              ? steps.length + 1
              : steps.findIndex((s) => s.id === editing.id) + 1
          }
          onClose={() => setEditing(null)}
          onSave={saveStep}
        />
      )}
      {deleting && (
        <ConfirmDelete
          title={`Delete “${deleting.name}”?`}
          description="This removes the step from your chain. The remaining steps will be reordered automatically."
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api(`/api/chains/${chain.id}/steps/${deleting.id}`, {
              method: "DELETE",
            });
            setDeleting(null);
            await onRefresh();
            notify("Step deleted");
          }}
        />
      )}
      {runDialog && (
        <RunDialog
          chain={chain}
          onClose={() => setRunDialog(false)}
          onComplete={() => {
            setRunDialog(false);
            setRunVersion((v) => v + 1);
            setTab("outputs");
            notify("Your chain has finished creating");
          }}
        />
      )}
    </>
  );
}

function StepDialog({
  step,
  number,
  onClose,
  onSave,
}: {
  step?: ChainStep;
  number: number;
  onClose: () => void;
  onSave: (v: {
    name: string;
    prompt: string;
    kind: StepKind;
    model: string;
    role: string;
    model_id: string | null;
  }) => Promise<void>;
}) {
  const [name, setName] = useState(step?.name || "");
  const [prompt, setPrompt] = useState(step?.prompt || "");
  const [kind, setKind] = useState<StepKind>(step?.kind || "text");
  const [role, setRole] = useState(step ? (step.role ?? "") : "user");
  const [modelId, setModelId] = useState<string | null>(step?.model_id ?? null);
  const [fallbackModel, setFallbackModel] = useState(() => {
    const choices = models[step?.kind || "text"];
    return (
      choices.find((choice) => choice.value === step?.model)?.value ||
      choices[0].value
    );
  });
  const [registryModels, setRegistryModels] = useState<
    RegistryModelDescriptor[]
  >([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsNote, setModelsNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const selectedModel = registryModels.find((choice) => choice.id === modelId);
  const assignedModelUnavailable =
    modelId !== null &&
    (selectedModel
      ? selectedModel.active === false ||
        selectedModel.provider.toLowerCase() !== "openai" ||
        !models[kind].some((choice) => choice.value === selectedModel.model) ||
        (selectedModel.kind !== undefined && selectedModel.kind !== kind)
      : modelId !== step?.model_id || step?.generation_ready !== true);
  useEffect(() => {
    let mounted = true;
    api<{ models: RegistryModelDescriptor[] }>("/api/models")
      .then((data) => {
        if (!Array.isArray(data.models))
          throw new Error("Missing model choices");
        if (mounted) setRegistryModels(data.models);
      })
      .catch(() => {
        if (mounted)
          setModelsNote(
            "Model choices could not load. Your existing model assignment will be preserved.",
          );
      })
      .finally(() => {
        if (mounted) setModelsLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, []);
  return (
    <Modal
      wide
      title={step ? "Edit prompt step" : "Add a prompt step"}
      onClose={onClose}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await onSave({
              name: name.trim(),
              prompt,
              kind,
              model:
                modelId === null
                  ? fallbackModel
                  : (selectedModel?.model ?? step?.model ?? ""),
              role,
              model_id: modelId,
            });
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-header">
          <div className="modal-icon">
            <Layers3 size={22} />
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <div className="eyebrow">STEP {String(number).padStart(2, "0")}</div>
        <h2>
          {step
            ? "Fine-tune the next step."
            : "One more step. More possibility."}
        </h2>
        <p className="modal-subtitle">
          Give this step a job and tell it how to get there.
        </p>
        <label className="form-field">
          Step name
          <input
            required
            maxLength={100}
            placeholder="e.g. Find the funny side"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="form-columns">
          <label className="form-field">
            Output type
            <select
              value={kind}
              onChange={(e) => {
                const k = e.target.value as StepKind;
                setKind(k);
                if (modelId === null) setFallbackModel(models[k][0].value);
              }}
            >
              <option value="text">Text</option>
              <option value="image">Image</option>
            </select>
          </label>
          <label className="form-field">
            Prompt role
            <select
              required
              value={role}
              onChange={(e) => setRole(e.target.value)}
            >
              {!role && (
                <option value="" disabled>
                  Choose the existing prompt role
                </option>
              )}
              {role && !["system", "user", "assistant"].includes(role) && (
                <option value={role}>{role}</option>
              )}
              <option value="system">System</option>
              <option value="user">User</option>
              <option value="assistant">Assistant</option>
            </select>
          </label>
        </div>
        <label className="form-field">
          Model assignment
          <select
            value={modelId ?? ""}
            onChange={(e) => {
              const nextId = e.target.value || null;
              setModelId(nextId);
              const choice = registryModels.find((item) => item.id === nextId);
              if (choice?.kind) setKind(choice.kind);
              if (
                nextId === null &&
                !models[kind].some((item) => item.value === fallbackModel)
              )
                setFallbackModel(models[kind][0].value);
            }}
          >
            <option value="">Workspace default</option>
            {modelId && !selectedModel && (
              <option value={modelId}>
                {step?.model_label || "Assigned model"}
              </option>
            )}
            {registryModels.map((choice) => (
              <option
                key={choice.id}
                value={choice.id}
                disabled={
                  choice.active === false && choice.id !== step?.model_id
                }
              >
                {choice.label}
                {choice.active === false ? " (inactive)" : ""}
              </option>
            ))}
          </select>
        </label>
        {modelsLoading && (
          <p className="field-note" role="status">
            Loading model choices…
          </p>
        )}
        {modelsNote && <p className="field-note">{modelsNote}</p>}
        {assignedModelUnavailable && !modelsLoading && (
          <p className="field-note model-warning">
            This assignment can be saved, but generation needs an active,
            supported model.
          </p>
        )}
        {modelId === null && (
          <label className="form-field">
            Model
            <select
              value={fallbackModel}
              onChange={(e) => setFallbackModel(e.target.value)}
            >
              {models[kind].map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="form-field">
          Prompt
          <textarea
            className="prompt-textarea"
            required
            rows={7}
            maxLength={2000}
            placeholder="Tell the model what to do. Use {{previous}} to include the last step’s output."
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <div className="prompt-variables">
          <span>Insert variable</span>
          {["input", "previous", ...(number > 1 ? ["step.1"] : [])].map((v) => (
            <button
              type="button"
              key={v}
              onClick={() =>
                setPrompt(
                  (p) => `${p}${p && !p.endsWith(" ") ? " " : ""}{{${v}}}`,
                )
              }
            >
              <code>{`{{${v}}}`}</code>
            </button>
          ))}
        </div>
        {error && (
          <div role="alert" className="form-error">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            disabled={busy || !name.trim() || !prompt.trim() || !role}
            className="button primary"
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Check size={16} />
            )}
            {step ? "Save step" : "Add step"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RunDialog({
  chain,
  onClose,
  onComplete,
}: {
  chain: PromptChain;
  onClose: () => void;
  onComplete: () => void;
}) {
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | undefined>();
  const [imageName, setImageName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const runIssue = chainRunIssue(chain);
  async function selectFile(file?: File) {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Choose a JPG, PNG, or WebP image.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setError("Please choose an image smaller than 2 MB.");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setImage(reader.result as string);
      setImageName(file.name);
      setError("");
    };
    reader.onerror = () =>
      setError("Could not read this image. Please try another file.");
    reader.readAsDataURL(file);
  }
  return (
    <Modal wide title="Run prompt chain" onClose={busy ? () => {} : onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (runIssue) {
            setError(runIssue);
            return;
          }
          setBusy(true);
          setError("");
          try {
            await api(`/api/chains/${chain.id}/runs`, {
              method: "POST",
              body: JSON.stringify({ input, image }),
            });
            onComplete();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="modal-header">
          <div className="modal-icon">
            <Play size={20} />
          </div>
          <button
            type="button"
            disabled={busy}
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <h2>Let’s see where this goes.</h2>
        <p className="modal-subtitle">
          {chain.name} · {chain.steps.length} connected steps
        </p>
        {runIssue && (
          <p className="chain-run-warning" role="status">
            {runIssue}
          </p>
        )}
        <label className="form-field">
          Your input
          <textarea
            rows={4}
            maxLength={12000}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Add a topic, a brief, or a little context…"
            disabled={busy}
          />
        </label>
        {image ? (
          <div className="image-upload-preview">
            <img src={image} alt="Selected input" />
            <span>{imageName}</span>
            <button
              type="button"
              disabled={busy}
              className="icon-button"
              aria-label="Remove uploaded image"
              onClick={() => {
                setImage(undefined);
                setImageName("");
              }}
            >
              <X size={16} />
            </button>
          </div>
        ) : (
          <label
            className="image-dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!busy) selectFile(e.dataTransfer.files[0]);
            }}
          >
            <Upload size={22} />
            <strong>Drop in an image, or browse</strong>
            <span>Optional · JPG, PNG, WebP · Up to 2 MB</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={busy}
              onChange={(e) => selectFile(e.target.files?.[0])}
            />
          </label>
        )}
        <div className="run-notice">
          <Sparkles size={16} />
          <span>
            Each step runs in order. Generation uses your connected AI provider
            and may incur usage costs.
          </span>
        </div>
        {busy && (
          <div className="generation-progress" role="status">
            <LoaderCircle className="spin" size={18} />
            <div>
              <strong>Your ideas are taking shape…</strong>
              <span>
                Keep this window open while your {chain.steps.length} steps run.
              </span>
            </div>
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || !!runIssue || (!input.trim() && !image)}
          >
            {busy ? (
              <LoaderCircle className="spin" size={16} />
            ) : (
              <Play size={15} fill="currentColor" />
            )}
            {busy ? "Creating…" : "Run chain"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RunHistory({
  chain,
  notify,
  onRun,
}: {
  chain: PromptChain;
  notify: (m: string, e?: boolean) => void;
  onRun: () => void;
}) {
  const [runs, setRuns] = useState<ChainRun[]>([]);
  const [legacy, setLegacy] = useState<LegacyHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    setError("");
    api<{ runs: ChainRun[]; legacy?: LegacyHistoryItem[] }>(
      `/api/chains/${chain.id}/runs`,
    )
      .then((d) => {
        setRuns(d.runs);
        setLegacy(d.legacy ?? []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [chain.id]);
  useEffect(load, [load]);
  if (loading)
    return (
      <div className="loading-state">
        <LoaderCircle className="spin" />
        Loading your creations…
      </div>
    );
  if (error)
    return (
      <div className="empty-library">
        <CircleHelp size={30} />
        <h2>Couldn’t load your creations</h2>
        <p>{error}</p>
        <button className="button secondary" onClick={load}>
          Try again
        </button>
      </div>
    );
  if (!runs.length && !legacy.length)
    return (
      <div className="empty-library">
        <div className="empty-media-icon">
          <ImageIcon size={30} />
        </div>
        <h2>A little empty. A lot of potential.</h2>
        <p>Run this chain to see all your generated text and images here.</p>
        <button
          className="button primary"
          disabled={!!chainRunIssue(chain)}
          title={chainRunIssue(chain) || undefined}
          onClick={onRun}
        >
          <Play size={15} />
          Run this chain
        </button>
      </div>
    );
  return (
    <>
      <div className="run-list">
        {runs.map((run) => (
          <article className="run-card" key={run.id}>
            <button
              className="run-card-heading"
              onClick={() => setOpened(opened === run.id ? null : run.id)}
            >
              <div className={`run-status-icon ${run.status}`}>
                {run.status === "completed" ? (
                  <CheckCheck size={19} />
                ) : run.status === "failed" ? (
                  <X size={19} />
                ) : (
                  <LoaderCircle size={19} className="spin" />
                )}
              </div>
              <div>
                <h3>
                  {run.input ? run.input.slice(0, 90) : "Image generation run"}
                </h3>
                <span>
                  {new Date(run.created_at).toLocaleString()} ·{" "}
                  {run.outputs.length} outputs
                </span>
              </div>
              <span className={`run-status ${run.status}`}>{run.status}</span>
              <ChevronDown
                size={17}
                className={opened === run.id ? "rotate" : ""}
              />
            </button>
            {opened === run.id && (
              <div className="run-outputs">
                {run.error && <div className="form-error">{run.error}</div>}
                {run.outputs.map((output, i) => (
                  <div className="run-output" key={`${run.id}-${i}`}>
                    <div className="output-header">
                      <span className="step-number">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <strong>{output.step_name}</strong>
                      {output.kind === "text" && (
                        <button
                          className="icon-button"
                          title="Copy output"
                          aria-label={`Copy ${output.step_name} output`}
                          onClick={async () => {
                            try {
                              await navigator.clipboard.writeText(
                                output.content,
                              );
                              notify("Output copied");
                            } catch {
                              notify(
                                "Could not access the clipboard. Select the text to copy it.",
                                true,
                              );
                            }
                          }}
                        >
                          <Copy size={15} />
                        </button>
                      )}
                    </div>
                    {output.kind === "image" ? (
                      <div className="output-image">
                        <img
                          src={output.content || undefined}
                          alt={
                            output.content
                              ? `Generated by ${output.step_name}`
                              : "This stored image is no longer available."
                          }
                        />
                        {output.content && (
                          <a
                            href={output.content}
                            target="_blank"
                            rel="noreferrer"
                            className="button secondary"
                          >
                            <Download size={15} />
                            Open image
                          </a>
                        )}
                      </div>
                    ) : (
                      <pre>{output.content}</pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </article>
        ))}
      </div>
      <SavedHistory items={legacy} />
    </>
  );
}

function SavedHistory({ items }: { items: LegacyHistoryItem[] }) {
  if (!items.length) return null;
  return (
    <section className="saved-history" aria-label="Saved history">
      <div className="saved-history-heading">
        <h2>Saved history</h2>
        <span>Read-only</span>
      </div>
      <p>Saved examples and generation requests for this chain.</p>
      <div className="saved-history-list">
        {items.map((item) => (
          <article
            className="saved-history-card"
            key={`${item.source}:${item.id}`}
          >
            <div className="saved-history-meta">
              <span>
                {item.source === "saved_example"
                  ? "Saved example"
                  : "Generation request"}
              </span>
              <time dateTime={item.created_at}>
                {new Date(item.created_at).toLocaleString()}
              </time>
              {item.status && <span>{item.status}</span>}
            </div>
            <h3>{item.title || item.prompt.slice(0, 100) || "Saved result"}</h3>
            {(item.model || item.origin) && (
              <p className="saved-history-meta">
                {[item.model, item.origin].filter(Boolean).join(" · ")}
              </p>
            )}
            <dl>
              {[
                ["Prompt", item.prompt],
                ["Saved output", item.output],
                ["Caption", item.caption],
                ["Generation prompt", item.generation_prompt],
                ["Generation status", item.generation_status],
              ]
                .filter(([, text]) => text !== null && text !== "")
                .map(([label, text]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>
                      <pre className="saved-history-text">{text}</pre>
                    </dd>
                  </div>
                ))}
            </dl>
            {item.truncated && (
              <p className="saved-history-truncation">
                Some saved text is shortened.
              </p>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}

function MediaLibrary({
  chains,
  notify,
}: {
  chains: PromptChain[];
  notify: (m: string, e?: boolean) => void;
}) {
  const [chainId, setChainId] = useState(chains[0]?.id || "");
  const [runDialog, setRunDialog] = useState(false);
  const [runVersion, setRunVersion] = useState(0);
  const chain = chains.find((c) => c.id === chainId) || chains[0];
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">THE POSSIBILITIES, MADE REAL</div>
          <h1>
            Media library<span className="heading-dot">.</span>
          </h1>
          <p>Every idea that made it through the chain. All in one place.</p>
        </div>
        <label className="library-chain-select">
          <Workflow size={17} />
          <select
            aria-label="Filter media by prompt chain"
            value={chain?.id || ""}
            onChange={(e) => setChainId(e.target.value)}
          >
            {!chains.length && <option value="">No chains yet</option>}
            {chains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
      </div>
      {chain ? (
        <RunHistory
          key={`${chain.id}-${runVersion}`}
          chain={chain}
          notify={notify}
          onRun={() => setRunDialog(true)}
        />
      ) : (
        <div className="empty-library">
          <div className="empty-media-icon">
            <ImageIcon size={32} />
          </div>
          <h2>Your ideas will live here.</h2>
          <p>Create a prompt chain and run it to start your collection.</p>
        </div>
      )}
      {chain && runDialog && (
        <RunDialog
          chain={chain}
          onClose={() => setRunDialog(false)}
          onComplete={() => {
            setRunDialog(false);
            setRunVersion((v) => v + 1);
            notify("Your chain has finished creating");
          }}
        />
      )}
    </>
  );
}
function Guide({ onClose }: { onClose: () => void }) {
  return (
    <Modal wide onClose={onClose} title="Quick start guide">
      <div className="modal-header">
        <div className="modal-icon">
          <Sparkles size={22} />
        </div>
        <button
          className="icon-button"
          aria-label="Close guide"
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </div>
      <div className="eyebrow">A LITTLE GUIDANCE. A LOT OF POSSIBILITY.</div>
      <h2>From an idea to something great.</h2>
      <p className="modal-subtitle">
        A prompt chain is a series of AI steps. Each step builds on the output
        of the last.
      </p>
      <div className="guide-steps">
        {[
          {
            title: "Start with a purpose",
            text: "Create a chain and name it after what you want to achieve. A caption writer? A campaign concept? Your call.",
          },
          {
            title: "Connect the steps",
            text: "Add text or image steps, choose a model, and write a specific prompt. Use {{previous}} or {{step.1}} to reference earlier outputs.",
          },
          {
            title: "Make it flow",
            text: "Drag steps to reorder them, or use the up and down arrows. Changes are saved as you go.",
          },
          {
            title: "Let your idea run",
            text: "Add your initial text or upload an image. Run the chain and find every step’s output in Generated media.",
          },
        ].map((s, i) => (
          <div key={s.title}>
            <span className="guide-number">0{i + 1}</span>
            <div>
              <h3>{s.title}</h3>
              <p>{s.text}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="guide-note">
        <Link2 size={18} />
        <p>
          Text steps can analyze an uploaded image. Image steps create new
          images from your prompts. Your AI provider’s usage charges apply.
        </p>
      </div>
      <div className="modal-actions">
        <button className="button primary" onClick={onClose}>
          Let’s make something <ArrowRight size={16} />
        </button>
      </div>
    </Modal>
  );
}
