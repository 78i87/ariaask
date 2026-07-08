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
import type { AppSettings, CoachMode, ModelInfo } from "../../lib/types";
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
  const [coachMode, setCoachMode] = useState<CoachMode>("guided");
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    setLoadState("loading");
    try {
      const [res, usageRes] = await Promise.all([api.getSettings(), api.getUsage()]);
      setSettings(res.settings);
      setModels(res.models);
      setCoachMode(usageRes.usage.coachMode);
      setLoadState("ready");
    } catch {
      setLoadState("error");
    }
  }, []);

  const updateCoachMode = useCallback(
    (mode: CoachMode) => {
      const before = coachMode;
      setCoachMode(mode);
      void api.updateUsage({ coachMode: mode }).catch(() => {
        setCoachMode(before);
        snackbar.show("Couldn't save the coaching style");
      });
    },
    [coachMode, snackbar],
  );

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

  const selectedModel =
    models.find((m) => m.model === settings?.model) ?? models.find((m) => m.isDefault) ?? models[0] ?? null;
  const selectedEffort = settings?.effort ?? selectedModel?.defaultReasoningEffort ?? null;
  const effortDescription = selectedModel?.supportedReasoningEfforts.find((e) => e.effort === selectedEffort)
    ?.description;

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

          <section className="settings__section">
            <h3 className="settings__heading label-large">Coaching style</h3>
            <Segmented
              ariaLabel="Coaching style"
              options={[
                { value: "guided", label: "Guided" },
                { value: "intermediate", label: "Intermediate" },
                { value: "experienced", label: "Experienced" },
              ]}
              value={coachMode}
              onChange={(v) => updateCoachMode(v as CoachMode)}
            />
            <span className="settings__supporting body-medium">
              {coachMode === "guided"
                ? "Full scaffolding — the coach explains which technique, why it fits, and exactly how to run it."
                : coachMode === "intermediate"
                  ? "Lighter scaffolding — the coach names the move and the mistake to avoid; you supply the how."
                  : "Peer mode — you bring the plan, the coach critiques it. The scaffolds are in your head now."}
            </span>
          </section>

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
