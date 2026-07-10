import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { Icon } from "../../components/Icon";
import { ProgressIndicator } from "../../components/ProgressIndicator";
import { Segmented } from "../../components/Segmented";
import { useSnackbar } from "../../components/Snackbar";
import { api } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { setSplitChat, useSplitChat } from "../../lib/splitChat";
import { useTheme, type Palette } from "../../lib/theme";
import type { AppSettings, CodexCliStatus, ModelInfo } from "../../lib/types";
import "./SettingsDialog.css";

const EFFORT_LABELS: Record<string, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "X-high" };

// Swatches depict each palette regardless of the active one — the documented
// exception to the no-hardcoded-colors rule (values = each palette's light primary).
const SWATCHES: { palette: Palette; label: string; color: string }[] = [
  { palette: "blue", label: "Blue", color: "#31628d" },
  { palette: "purple", label: "Purple", color: "#6750a4" },
];

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const { state, logout } = useAuth();
  const { palette, setPalette } = useTheme();
  const splitChat = useSplitChat();
  const snackbar = useSnackbar();

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [codexStatus, setCodexStatus] = useState<CodexCliStatus | null>(null);
  const [codexLoadState, setCodexLoadState] = useState<"loading" | "ready" | "hidden">("loading");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    setLoadState("loading");
    setCodexStatus(null);
    setCodexLoadState("loading");
    void api
      .getCodexStatus()
      .then((status) => {
        setCodexStatus(status);
        setCodexLoadState("ready");
      })
      .catch(() => {
        setCodexStatus(null);
        setCodexLoadState("hidden");
      });
    try {
      const res = await api.getSettings();
      setSettings(res.settings);
      setModels(res.models);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const update = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => (prev ? { ...prev, ...patch } : prev));
      const seq = ++requestSeq.current;
      const before = settings;
      void api
        .updateSettings(patch)
        .then((res) => {
          if (seq === requestSeq.current) setSettings(res.settings);
        })
        .catch(() => {
          if (seq === requestSeq.current && before) setSettings(before);
          snackbar.show("Couldn't save settings");
        });
    },
    [settings, snackbar],
  );

  const selectedModel = models.find((m) => m.model === settings?.model) ?? null;
  const selectedEffort = settings?.effort ?? selectedModel?.defaultReasoningEffort ?? null;
  const effortDescription = selectedModel?.supportedReasoningEfforts.find((e) => e.effort === selectedEffort)
    ?.description;
  const codexIsUpToDate = Boolean(
    codexStatus &&
      (codexStatus.updateAvailable === false ||
        (codexStatus.state === "succeeded" && codexStatus.updateAvailable !== true)),
  );

  const updateCodex = useCallback(() => {
    if (!codexStatus?.canUpdate || codexStatus.state === "running") return;
    setCodexStatus({ ...codexStatus, state: "running", message: "Updating Codex CLI…" });
    void api
      .updateCodex()
      .then((status) => {
        setCodexStatus(status);
        if (status.state === "succeeded") {
          snackbar.show(status.message ?? "Codex CLI updated");
          void api.getSettings().then((res) => {
            setSettings(res.settings);
            setModels(res.models);
          });
        }
      })
      .catch(() => {
        setCodexStatus((current) =>
          current ? { ...current, state: "failed", message: "Couldn't update the Codex CLI." } : current,
        );
      });
  }, [codexStatus, snackbar]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      headline="Settings"
      actions={
        <Button variant="text" onClick={onClose}>
          Done
        </Button>
      }
    >
      {loadState === "loading" && (
        <div className="settings__loading">
          <ProgressIndicator size={32} />
        </div>
      )}

      {loadState === "error" && (
        <div className="settings__error">
          <span className="body-medium">Couldn't load settings.</span>
          <Button variant="text" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}

      {loadState === "ready" && settings && (
        <div className="settings__sections">
          {state.phase === "signed-in" && (
            <section className="settings__section">
              <h3 className="settings__heading label-large">Account</h3>
              <div className="settings__account">
                <span className="settings__avatar label-large">{(state.email?.[0] ?? "?").toUpperCase()}</span>
                <div className="settings__account-info">
                  <span className="body-large">{state.email ?? "Signed in"}</span>
                  {state.planType && <span className="settings__plan body-medium">{state.planType} plan</span>}
                </div>
                <Button
                  variant="text"
                  icon="logout"
                  onClick={() => {
                    onClose();
                    void logout();
                  }}
                >
                  Sign out
                </Button>
              </div>
            </section>
          )}

          {codexLoadState !== "hidden" && (
            <section className="settings__section">
              <h3 className="settings__heading label-large">Codex CLI</h3>
              {codexLoadState === "loading" || !codexStatus ? (
                <div className="settings__codex-row settings__codex-row--loading">
                  <div className="settings__codex-info">
                    <span className="body-large">Checking Codex CLI…</span>
                    <span className="settings__supporting body-medium">Reading the installed and latest versions.</span>
                  </div>
                  <ProgressIndicator size={24} />
                </div>
              ) : (
                <div className="settings__codex-row">
                  <div className="settings__codex-info">
                    <span className="body-large">
                      {codexStatus.currentVersion ? `Version ${codexStatus.currentVersion}` : "Version unavailable"}
                    </span>
                    <span className="settings__supporting body-medium">{codexStatus.message}</span>
                    {codexStatus.manualCommand &&
                      (!codexStatus.canUpdate || codexStatus.state === "failed" || codexStatus.state === "unchanged") && (
                        <code className="settings__codex-command">{codexStatus.manualCommand}</code>
                      )}
                  </div>
                  {codexStatus.canUpdate && (
                    <Button
                      variant="tonal"
                      disabled={codexStatus.state === "running" || codexIsUpToDate}
                      onClick={updateCodex}
                    >
                      {codexStatus.state === "running"
                        ? "Updating…"
                        : codexIsUpToDate
                          ? "Up to date"
                          : "Update Codex CLI"}
                    </Button>
                  )}
                </div>
              )}
            </section>
          )}

          <section className="settings__section">
            <h3 className="settings__heading label-large">Chat layout</h3>
            <Segmented
              ariaLabel="Chat layout"
              options={[
                { value: "tabs", label: "Tabbed" },
                { value: "split", label: "Split" },
              ]}
              value={splitChat ? "split" : "tabs"}
              onChange={(v) => setSplitChat(v === "split")}
            />
            <span className="settings__supporting body-medium">
              {splitChat
                ? "Aria on the left, Cyra on the right — “Ask Cyra” drops questions into the right-hand chat. On narrow windows the tabs come back."
                : "One conversation at a time — switch between Aria, the map, and Cyra questions with the tabs."}
            </span>
          </section>

          {models.length === 0 ? (
            <section className="settings__section">
              <h3 className="settings__heading label-large">Model</h3>
              <span className="settings__plan body-medium">Model list unavailable — try reopening settings.</span>
            </section>
          ) : (
            <>
              <section className="settings__section">
                <h3 className="settings__heading label-large">Model</h3>
                <div className="settings__models" role="radiogroup" aria-label="Model">
                  {models.map((m) => {
                    const selected = m.model === (selectedModel?.model ?? null);
                    return (
                      <button
                        key={m.model}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        className={`settings__model-row${selected ? " settings__model-row--selected" : ""}`}
                        onClick={() => update({ model: m.model })}
                      >
                        <div className="settings__model-text">
                          <span className="body-large">
                            {m.displayName}
                            {m.isDefault && <span className="settings__default-tag body-medium"> · default</span>}
                          </span>
                          {m.description && <span className="settings__model-desc body-medium">{m.description}</span>}
                        </div>
                        {selected && <Icon name="check" size={20} />}
                      </button>
                    );
                  })}
                </div>
              </section>

              {selectedModel && selectedModel.supportedReasoningEfforts.length > 0 && (
                <section className="settings__section">
                  <h3 className="settings__heading label-large">Thinking level</h3>
                  <Segmented
                    ariaLabel="Thinking level"
                    options={selectedModel.supportedReasoningEfforts.map((e) => ({
                      value: e.effort,
                      label: EFFORT_LABELS[e.effort] ?? e.effort,
                    }))}
                    value={selectedEffort ?? ""}
                    onChange={(v) => update({ effort: v })}
                  />
                  {effortDescription && <span className="settings__supporting body-medium">{effortDescription}</span>}
                </section>
              )}
            </>
          )}

          <section className="settings__section">
            <h3 className="settings__heading label-large">Student style</h3>
            <div className="settings__style-row">
              <span className="body-medium settings__style-label">Reply length</span>
              <Segmented
                ariaLabel="Reply length"
                options={[
                  { value: "concise", label: "Concise" },
                  { value: "default", label: "Default" },
                  { value: "chatty", label: "Chatty" },
                ]}
                value={settings.replyLength}
                onChange={(v) => update({ replyLength: v as AppSettings["replyLength"] })}
              />
            </div>
            <div className="settings__style-row">
              <span className="body-medium settings__style-label">Probing</span>
              <Segmented
                ariaLabel="Probing intensity"
                options={[
                  { value: "gentle", label: "Gentle" },
                  { value: "default", label: "Default" },
                  { value: "relentless", label: "Relentless" },
                ]}
                value={settings.probing}
                onChange={(v) => update({ probing: v as AppSettings["probing"] })}
              />
            </div>
          </section>

          <section className="settings__section">
            <h3 className="settings__heading label-large">Reading recall</h3>
            <div className="settings__style-row">
              <span className="body-medium settings__style-label">Recall</span>
              <Segmented
                ariaLabel="Reading recall"
                options={[
                  { value: "off", label: "Off" },
                  { value: "auto", label: "Auto" },
                  { value: "always", label: "Always" },
                ]}
                value={settings.ragMode}
                onChange={(v) => update({ ragMode: v as AppSettings["ragMode"] })}
              />
            </div>
            {settings.ragMode !== "off" && (
              <div className="settings__style-row">
                <span className="body-medium settings__style-label">Amount</span>
                <Segmented
                  ariaLabel="Recall amount"
                  options={[
                    { value: "light", label: "Light" },
                    { value: "default", label: "Default" },
                    { value: "generous", label: "Generous" },
                  ]}
                  value={settings.ragRecall}
                  onChange={(v) => update({ ragRecall: v as AppSettings["ragRecall"] })}
                />
              </div>
            )}
            <span className="settings__supporting body-medium">
              {settings.ragMode === "off"
                ? "Aria relies only on her own read of the sources."
                : settings.ragMode === "always"
                  ? "While you teach, Aria quietly recalls the most relevant passages from any reading."
                  : "For larger readings, Aria quietly recalls the most relevant passages while you teach."}
            </span>
          </section>

          <section className="settings__section">
            <h3 className="settings__heading label-large">Color theme</h3>
            <div className="settings__swatches" role="radiogroup" aria-label="Color theme">
              {SWATCHES.map((s) => (
                <button
                  key={s.palette}
                  type="button"
                  role="radio"
                  aria-checked={palette === s.palette}
                  aria-label={s.label}
                  title={s.label}
                  className={`settings__swatch${palette === s.palette ? " settings__swatch--selected" : ""}`}
                  style={{ background: s.color }}
                  onClick={() => setPalette(s.palette)}
                >
                  {palette === s.palette && <Icon name="check" size={20} className="settings__swatch-check" />}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}
    </Dialog>
  );
}
